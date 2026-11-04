// Package otlpstage is the Postgres staging store of the OTLP GenAI
// dialect. OpenTelemetry GenAI frameworks export a span when it ends, so
// an agent's span arrives after its model calls and tools, and one run's
// spans can reach different ingestion replicas in several requests.
// Ingestion therefore stages each span (and each Google ADK content log
// record) in otlp_spans, keyed by the sending token, trace, span and
// kind, and an assembler in every ingestion process claims due traces
// under a lease and maps each one whole. See ARCHITECTURE.md (OTLP
// ingest > GenAI dialect, and Database > OTLP GenAI staging).
//
// Every time this store writes comes from its clock, never from the
// database's now(), so the timers are deterministic under test. All
// state lives in Postgres: nothing a replica holds in memory is needed
// by another, or after a restart.
package otlpstage

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Timers and bounds. ARCHITECTURE.md (OTLP ingest > GenAI dialect)
// states each value; the justification is beside it.
const (
	// StageTimeout bounds one request's staging transaction. A request
	// is answered only after the write commits, inside the receiver's
	// decode slot, so a slow database must turn into a 503 the exporter
	// retries rather than hold the slot; two seconds is far above a
	// healthy write of one request's records and well inside exporters'
	// ten-second default export timeout.
	StageTimeout = 2 * time.Second

	// RootGrace is how long after a trace's root span, and after each
	// later record, the trace waits before it is due. It absorbs a
	// second BatchSpanProcessor flush: the root ends last in every
	// recorded framework, and its last stragglers follow within one
	// export.
	RootGrace = 3 * time.Second

	// AdkLogWait is how long after its root a Google ADK trace waits for
	// the log records of its generate_content spans. ADK's last log
	// record follows the root's export in every recorded scenario,
	// within its five-second batch delay. The assembler's completeness
	// check uses it; the content backstop age below includes it.
	AdkLogWait = 30 * time.Second

	// QuietTimeout is how long a trace whose root has not arrived waits
	// after its latest record. It equals the threshold after which a
	// silent session is lost, so "no data for 30 minutes" means the same
	// thing everywhere.
	QuietTimeout = 30 * time.Minute

	// MaxTraceHold is how long after its first record a trace is due in
	// any case. It leaves half of the 48-hour event validation window
	// for the assembly, so an assembled event is never too old to pass.
	MaxTraceHold = 24 * time.Hour

	// MaxSpansPerTrace caps the records one trace stages. It bounds one
	// assembly at about 20,000 events (an agent span becomes a start and
	// an end), published in chunks.
	MaxSpansPerTrace = 10000

	// LeaseTTL is how long a claim on a trace lasts unless renewed. The
	// assembler renews it between published chunks, so it never has to
	// cover a whole assembly, and a crashed replica's claim expires
	// quickly.
	LeaseTTL = 2 * time.Minute

	// ClaimBatch is the most traces one claim takes. With every replica
	// ticking once a second it keeps a claim, and the assembly work it
	// hands one replica per tick, small, so due traces spread across
	// replicas instead of piling on the first to claim.
	ClaimBatch = 32

	// CompleteRetention is how long a trace's records are kept after a
	// complete assembly. It covers exporter retries and asynchronous
	// spans that end after the root, and lets the table shrink early for
	// the common case.
	CompleteRetention = time.Hour

	// DegradedRetention is how long a trace's records are kept after
	// any other assembly. It matches the orphan timeout, so late
	// ancestry can still be used while its session can still be
	// re-attached.
	DegradedRetention = 24 * time.Hour

	// ContentBackstopAge is the age past which staged content is
	// deleted whatever its trace's state: the longest a trace can wait
	// (MaxTraceHold) plus the ADK log wait. Assembly deletes content
	// long before this; the sweep only catches content an assembly
	// never reached.
	ContentBackstopAge = MaxTraceHold + AdkLogWait

	// SweepBatch is how many rows one sweep statement deletes, so a
	// large backlog is removed in short transactions that do not hold
	// locks an ingest or an assembly waits on for long.
	SweepBatch = 1000
)

// Kind tells a staged span from a staged log record.
type Kind int16

const (
	// KindSpan is a span.
	KindSpan Kind = 1
	// KindLog is a Google ADK gen_ai.client.inference.operation.details
	// log record, keyed by the span id of the call it describes.
	KindLog Kind = 2
)

func (k Kind) valid() bool { return k == KindSpan || k == KindLog }

// Reason is why a trace was due when it was assembled.
type Reason string

// The assembly reasons ARCHITECTURE.md names.
const (
	ReasonComplete      Reason = "complete"
	ReasonADKLogTimeout Reason = "adk_log_timeout"
	ReasonQuiet         Reason = "quiet"
	ReasonMaxHold       Reason = "max_hold"
)

func (r Reason) valid() bool {
	switch r {
	case ReasonComplete, ReasonADKLogTimeout, ReasonQuiet, ReasonMaxHold:
		return true
	}
	return false
}

// TraceKey names a trace: a trace belongs to the token that sent it.
type TraceKey struct {
	TokenKey string
	TraceID  [16]byte
}

// FactKey names one staged record within its trace.
type FactKey struct {
	SpanID [8]byte
	Kind   Kind
}

// Fact is the content-free part of a staged record.
type Fact struct {
	SpanID [8]byte
	Kind   Kind
	// ParentSpanID is the parent span's id; the zero value means the
	// record has no parent (an all-zero span id is invalid in OTLP).
	ParentSpanID [8]byte
	// RemoteParent reports that the parent lives in another process
	// (span flags 0x300), which makes the span its trace's root here.
	RemoteParent bool
	ScopeName    string
	ScopeVersion string
	Name         string
	Op           string // gen_ai.operation.name
	AgentName    string
	StartNs      int64
	EndNs        int64
	Status       int16
	// Meta holds the allowlisted, content-free attributes as a JSON
	// object; nil stores an empty object.
	Meta json.RawMessage
}

// Key returns the record's key within its trace.
func (f Fact) Key() FactKey { return FactKey{SpanID: f.SpanID, Kind: f.Kind} }

// isRoot reports whether the record is its trace's root: a span with no
// parent, or a remote one. A log record never is.
func (f Fact) isRoot() bool {
	return f.Kind == KindSpan && (f.ParentSpanID == [8]byte{} || f.RemoteParent)
}

// Record is one record to stage.
type Record struct {
	Fact
	// Capture reports that the record's own resource declares
	// flightdeck.capture_prompts=true.
	Capture bool
	// Content is the record's captured content as JSON, or nil when it
	// has none. It is staged only when Capture holds and the trace's
	// posture is still on; otherwise it is dropped here.
	Content json.RawMessage
}

// TraceBatch is the records of one trace in one request.
type TraceBatch struct {
	Key       TraceKey
	TokenName string
	// Source and SourceVersion are the framework label and version of
	// the batch's first recognised record; Resource is the allowlisted
	// identity resource as a JSON object. All three are written only
	// when this batch creates the trace's row, so every assembly of a
	// trace derives the same identity.
	Source        string
	SourceVersion string
	Resource      json.RawMessage
	Records       []Record
}

// StageResult counts what a Stage call did with its records.
type StageResult struct {
	// Staged records were new and are now staged.
	Staged int
	// Duplicate records were already staged (a resent export) and were
	// ignored.
	Duplicate int
	// OverCap records were refused because their trace already held
	// MaxSpansPerTrace records; the receiver counts them as rejected.
	OverCap int
}

// Trace is a claimed trace's row.
type Trace struct {
	Key             TraceKey
	Source          string
	SourceVersion   string
	TokenName       string
	Resource        json.RawMessage
	Capture         bool
	FirstReceivedAt time.Time
	LastReceivedAt  time.Time
	RootSeenAt      *time.Time
	ResolveAt       time.Time
	Gen             int64
	LeaseExpires    time.Time
	AssembledAt     *time.Time
	AssemblyCount   int
	AssemblyReason  string
	SpanCount       int
}

// StagedFact is one staged record as LoadTrace returns it.
type StagedFact struct {
	Fact
	// Content is the record's staged content; it is loaded only for
	// records not yet assembled, and nil when there is none.
	Content   json.RawMessage
	Assembled bool
	// AssembledIn is the number of the assembly that marked the record
	// (the trace's assembly_count after it, from 1); 0 while it is not
	// assembled.
	AssembledIn int
	ReceivedAt  time.Time
}

// LoadedTrace is a snapshot of one trace's records.
type LoadedTrace struct {
	Key     TraceKey
	Gen     int64 // the trace's gen in the same snapshot as Facts
	Capture bool
	Facts   []StagedFact
}

// Unassembled returns the keys of the snapshot's records not yet
// assembled: the ones MarkAssembled is given once they are published.
func (t LoadedTrace) Unassembled() []FactKey {
	var keys []FactKey
	for _, f := range t.Facts {
		if !f.Assembled {
			keys = append(keys, f.Key())
		}
	}
	return keys
}

// ErrTraceNotFound is returned by LoadTrace when the trace has no row.
var ErrTraceNotFound = errors.New("otlpstage: trace not found")

// Store reads and writes the staging tables.
type Store struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// Option configures a Store.
type Option func(*Store)

// WithClock replaces the store's clock (time.Now by default); tests use
// it to move the timers without waiting.
func WithClock(now func() time.Time) Option {
	return func(s *Store) { s.now = now }
}

// NewStore creates a staging Store.
func NewStore(pool *pgxpool.Pool, opts ...Option) *Store {
	s := &Store{pool: pool, now: time.Now}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// clock returns the store's time at the precision Postgres stores, so a
// value written and read back compares equal.
func (s *Store) clock() time.Time {
	return s.now().UTC().Truncate(time.Microsecond)
}

// resolveAt is the time a trace that just staged a new record is next
// due: RootGrace after it once the root has been seen, else
// QuietTimeout after it, and never later than MaxTraceHold after the
// trace's first record.
func resolveAt(firstReceived time.Time, rootSeen bool, now time.Time) time.Time {
	due := now.Add(QuietTimeout)
	if rootSeen {
		due = now.Add(RootGrace)
	}
	if hold := firstReceived.Add(MaxTraceHold); hold.Before(due) {
		return hold
	}
	return due
}

// Stage writes a request's GenAI records in one transaction, under
// StageTimeout: per trace, in (token, trace) order so two requests that
// touch the same traces cannot deadlock, it upserts the trace row (which
// satisfies the foreign key and takes the lock that serialises writes to
// one trace), inserts the records that are new, inserts their content
// when capture allows, and then, only when a record was new, moves the
// trace's timers and bumps its gen. A resent record changes nothing,
// timers and gen included.
//
// The trace's capture posture is ANDed with every record's, resent ones
// included, since off is the safe direction; when it turns off, the
// trace's staged content is deleted in the same transaction.
func (s *Store) Stage(ctx context.Context, batches []TraceBatch) (StageResult, error) {
	var res StageResult
	if len(batches) == 0 {
		return res, nil
	}
	for i := range batches {
		if err := batches[i].validate(); err != nil {
			return res, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, StageTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return res, fmt.Errorf("otlpstage: begin stage: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	res, err = s.stageTx(ctx, tx, batches)
	if err != nil {
		return StageResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return StageResult{}, fmt.Errorf("otlpstage: commit stage: %w", err)
	}
	return res, nil
}

func (b *TraceBatch) validate() error {
	if b.Key.TokenKey == "" {
		return errors.New("otlpstage: a trace batch needs a token key")
	}
	if b.Key.TraceID == [16]byte{} {
		return errors.New("otlpstage: a trace batch needs a non-zero trace id")
	}
	if b.Source == "" {
		return errors.New("otlpstage: a trace batch needs a source")
	}
	if b.Resource != nil && !json.Valid(b.Resource) {
		return errors.New("otlpstage: a trace batch's resource is not valid JSON")
	}
	for _, r := range b.Records {
		if r.SpanID == [8]byte{} {
			return errors.New("otlpstage: a record needs a non-zero span id")
		}
		if !r.Kind.valid() {
			return fmt.Errorf("otlpstage: record kind %d is neither a span nor a log record", r.Kind)
		}
		if r.Meta != nil && !json.Valid(r.Meta) {
			return errors.New("otlpstage: a record's meta is not valid JSON")
		}
		if r.Content != nil && !json.Valid(r.Content) {
			return errors.New("otlpstage: a record's content is not valid JSON")
		}
	}
	return nil
}

// stageTx is Stage's body inside a caller's transaction.
func (s *Store) stageTx(ctx context.Context, tx pgx.Tx, batches []TraceBatch) (StageResult, error) {
	var res StageResult
	ordered := slices.Clone(batches)
	slices.SortStableFunc(ordered, func(a, b TraceBatch) int {
		if c := cmp.Compare(a.Key.TokenKey, b.Key.TokenKey); c != 0 {
			return c
		}
		return bytes.Compare(a.Key.TraceID[:], b.Key.TraceID[:])
	})
	for i := range ordered {
		r, err := stageTrace(ctx, tx, &ordered[i], s.clock)
		if err != nil {
			return StageResult{}, err
		}
		res.Staged += r.Staged
		res.Duplicate += r.Duplicate
		res.OverCap += r.OverCap
	}
	return res, nil
}

func jsonOrEmpty(raw json.RawMessage) string {
	if raw == nil {
		return "{}"
	}
	return string(raw)
}

// stageTrace stages one trace's records. It reads the clock once for a
// row it may create and again once it holds the trace's row lock, so a
// write that waited behind another (up to StageTimeout) dates the
// trace's timers and records from when it could write, never from
// before an earlier writer's.
func stageTrace(ctx context.Context, tx pgx.Tx, b *TraceBatch, clock func() time.Time) (StageResult, error) {
	var res StageResult
	if len(b.Records) == 0 {
		return res, nil
	}
	batchCapture := true
	for _, r := range b.Records {
		batchCapture = batchCapture && r.Capture
	}
	traceID := b.Key.TraceID[:]

	// 1. The trace row, first: the foreign key needs it, and the upsert
	// takes the row lock that serialises writes to this trace. A new row
	// gets a placeholder resolve_at that step 5 replaces, since every
	// record of a new trace is new.
	var (
		spanCount  int
		oldCapture bool
		rootSeenAt *time.Time
		firstRecv  time.Time
	)
	created := clock()
	err := tx.QueryRow(ctx, `
		INSERT INTO otlp_traces (token_key, trace_id, source, source_version, token_name,
		                         resource, capture, first_received_at, last_received_at, resolve_at)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8, $9)
		ON CONFLICT (token_key, trace_id) DO UPDATE SET last_received_at = otlp_traces.last_received_at
		RETURNING span_count, capture, root_seen_at, first_received_at`,
		b.Key.TokenKey, traceID, b.Source, b.SourceVersion, b.TokenName,
		jsonOrEmpty(b.Resource), batchCapture, created, created.Add(QuietTimeout),
	).Scan(&spanCount, &oldCapture, &rootSeenAt, &firstRecv)
	if err != nil {
		return res, fmt.Errorf("otlpstage: upsert trace: %w", err)
	}
	now := clock()

	// 2. Which records are new. The trace row lock is held, so no other
	// write adds records to this trace until this transaction ends.
	candidates := dedupe(b.Records)
	ids := make([][]byte, len(candidates))
	kinds := make([]int16, len(candidates))
	for i, r := range candidates {
		ids[i] = r.SpanID[:]
		kinds[i] = int16(r.Kind)
	}
	rows, err := tx.Query(ctx, `
		SELECT span_id, kind FROM otlp_spans
		WHERE token_key = $1 AND trace_id = $2
		  AND (span_id, kind) IN (SELECT * FROM unnest($3::bytea[], $4::smallint[]))`,
		b.Key.TokenKey, traceID, ids, kinds)
	if err != nil {
		return res, fmt.Errorf("otlpstage: look up staged records: %w", err)
	}
	existing := map[FactKey]bool{}
	for rows.Next() {
		var id []byte
		var kind int16
		if err := rows.Scan(&id, &kind); err != nil {
			rows.Close()
			return res, fmt.Errorf("otlpstage: scan staged record: %w", err)
		}
		existing[factKey(id, kind)] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, fmt.Errorf("otlpstage: look up staged records: %w", err)
	}
	res.Duplicate = len(b.Records) - len(candidates) + len(existing)

	fresh := make([]Record, 0, len(candidates)-len(existing))
	for _, r := range candidates {
		if !existing[r.Key()] {
			fresh = append(fresh, r)
		}
	}
	// The cap counts staged records, so a resent record never takes a
	// new one's place.
	if room := MaxSpansPerTrace - spanCount; len(fresh) > room {
		room = max(room, 0)
		res.OverCap = len(fresh) - room
		fresh = fresh[:room]
	}

	newCapture := oldCapture && batchCapture
	if oldCapture && !newCapture {
		// Off wins: once one record of the trace comes without capture,
		// none of its content stays staged.
		if _, err := tx.Exec(ctx,
			`DELETE FROM otlp_span_content WHERE token_key = $1 AND trace_id = $2`,
			b.Key.TokenKey, traceID); err != nil {
			return res, fmt.Errorf("otlpstage: delete content of trace without capture: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE otlp_traces SET capture = false WHERE token_key = $1 AND trace_id = $2`,
			b.Key.TokenKey, traceID); err != nil {
			return res, fmt.Errorf("otlpstage: turn trace capture off: %w", err)
		}
	}
	if len(fresh) == 0 {
		return res, nil
	}

	// 3. The new records. The lock makes a conflict here impossible;
	// ON CONFLICT and the returned rows keep the counts true regardless.
	inserted, err := insertFacts(ctx, tx, b.Key, fresh, now)
	if err != nil {
		return res, err
	}
	res.Staged = len(inserted)
	res.Duplicate += len(fresh) - len(inserted)
	if len(inserted) == 0 {
		return res, nil
	}

	// 4. Their content, only under capture.
	if newCapture {
		if err := insertContent(ctx, tx, b.Key, inserted, now); err != nil {
			return res, err
		}
	}

	// 5. Timers and gen, because a record was new.
	rootNow := rootSeenAt != nil
	if !rootNow {
		for _, r := range inserted {
			if r.isRoot() {
				rootNow = true
				break
			}
		}
	}
	var newRootSeen *time.Time
	if rootSeenAt != nil {
		newRootSeen = rootSeenAt
	} else if rootNow {
		newRootSeen = &now
	}
	if _, err := tx.Exec(ctx, `
		UPDATE otlp_traces
		SET gen = gen + 1, pending = true, span_count = span_count + $3,
		    last_received_at = GREATEST(last_received_at, $4), root_seen_at = $5, resolve_at = $6
		WHERE token_key = $1 AND trace_id = $2`,
		b.Key.TokenKey, traceID, len(inserted), now, newRootSeen,
		resolveAt(firstRecv, rootNow, now)); err != nil {
		return res, fmt.Errorf("otlpstage: move trace timers: %w", err)
	}
	return res, nil
}

// dedupe keeps the first copy of each key, in request order, so a
// request that repeats a record stages it once; a later copy is counted
// as a duplicate even when its fields differ from the first.
func dedupe(records []Record) []Record {
	seen := make(map[FactKey]bool, len(records))
	out := make([]Record, 0, len(records))
	for _, r := range records {
		if seen[r.Key()] {
			continue
		}
		seen[r.Key()] = true
		out = append(out, r)
	}
	return out
}

func factKey(spanID []byte, kind int16) FactKey {
	var k FactKey
	copy(k.SpanID[:], spanID)
	k.Kind = Kind(kind)
	return k
}

// insertFacts stages records and returns the ones it inserted, so their
// content and the root check never act on a row it did not write.
func insertFacts(ctx context.Context, tx pgx.Tx, key TraceKey, records []Record, now time.Time) ([]Record, error) {
	n := len(records)
	var (
		ids, parents                     = make([][]byte, n), make([][]byte, n)
		kinds, statuses                  = make([]int16, n), make([]int16, n)
		remotes                          = make([]bool, n)
		scopes, versions, names, ops, ag = make([]string, n), make([]string, n), make([]string, n), make([]string, n), make([]string, n)
		starts, ends                     = make([]int64, n), make([]int64, n)
		metas                            = make([]string, n)
	)
	for i, r := range records {
		ids[i] = r.SpanID[:]
		if r.ParentSpanID != [8]byte{} {
			parents[i] = r.ParentSpanID[:]
		}
		kinds[i] = int16(r.Kind)
		statuses[i] = r.Status
		remotes[i] = r.RemoteParent
		scopes[i], versions[i], names[i], ops[i], ag[i] = r.ScopeName, r.ScopeVersion, r.Name, r.Op, r.AgentName
		starts[i], ends[i] = r.StartNs, r.EndNs
		metas[i] = jsonOrEmpty(r.Meta)
	}
	rows, err := tx.Query(ctx, `
		INSERT INTO otlp_spans (token_key, trace_id, span_id, kind, parent_span_id, remote_parent,
		                        scope_name, scope_version, name, op, agent_name,
		                        start_ns, end_ns, status, meta, received_at)
		SELECT $1, $2, u.span_id, u.kind, u.parent_span_id, u.remote_parent,
		       u.scope_name, u.scope_version, u.name, u.op, u.agent_name,
		       u.start_ns, u.end_ns, u.status, u.meta::jsonb, $16
		FROM unnest($3::bytea[], $4::smallint[], $5::bytea[], $6::boolean[],
		            $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
		            $12::bigint[], $13::bigint[], $14::smallint[], $15::text[])
		     AS u(span_id, kind, parent_span_id, remote_parent,
		          scope_name, scope_version, name, op, agent_name,
		          start_ns, end_ns, status, meta)
		ON CONFLICT DO NOTHING
		RETURNING span_id, kind`,
		key.TokenKey, key.TraceID[:], ids, kinds, parents, remotes,
		scopes, versions, names, ops, ag, starts, ends, statuses, metas, now)
	if err != nil {
		return nil, fmt.Errorf("otlpstage: insert records: %w", err)
	}
	written := map[FactKey]bool{}
	for rows.Next() {
		var id []byte
		var kind int16
		if err := rows.Scan(&id, &kind); err != nil {
			rows.Close()
			return nil, fmt.Errorf("otlpstage: scan inserted record: %w", err)
		}
		written[factKey(id, kind)] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("otlpstage: insert records: %w", err)
	}
	inserted := make([]Record, 0, len(written))
	for _, r := range records {
		if written[r.Key()] {
			inserted = append(inserted, r)
		}
	}
	return inserted, nil
}

// insertContent stages the content of the given (new) records whose own
// resource declares capture. The caller has checked the trace's posture.
func insertContent(ctx context.Context, tx pgx.Tx, key TraceKey, records []Record, now time.Time) error {
	var (
		ids      [][]byte
		kinds    []int16
		contents []string
	)
	for _, r := range records {
		if !r.Capture || r.Content == nil {
			continue
		}
		ids = append(ids, r.SpanID[:])
		kinds = append(kinds, int16(r.Kind))
		contents = append(contents, string(r.Content))
	}
	if len(ids) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO otlp_span_content (token_key, trace_id, span_id, kind, content, staged_at)
		SELECT $1, $2, u.span_id, u.kind, u.content::jsonb, $6
		FROM unnest($3::bytea[], $4::smallint[], $5::text[]) AS u(span_id, kind, content)
		ON CONFLICT DO NOTHING`,
		key.TokenKey, key.TraceID[:], ids, kinds, contents, now); err != nil {
		return fmt.Errorf("otlpstage: insert content: %w", err)
	}
	return nil
}

// claimedColumns is the trace row as ClaimDue returns it and scanTrace
// reads it, qualified by the claim's alias.
const claimedColumns = `t.token_key, t.trace_id, t.source, t.source_version, t.token_name,
	t.resource, t.capture, t.first_received_at, t.last_received_at, t.root_seen_at,
	t.resolve_at, t.gen, t.lease_expires, t.assembled_at, t.assembly_count,
	COALESCE(t.assembly_reason, ''), t.span_count`

func scanTrace(row pgx.Row) (Trace, error) {
	var (
		t       Trace
		traceID []byte
		expires *time.Time
	)
	if err := row.Scan(&t.Key.TokenKey, &traceID, &t.Source, &t.SourceVersion, &t.TokenName,
		&t.Resource, &t.Capture, &t.FirstReceivedAt, &t.LastReceivedAt, &t.RootSeenAt,
		&t.ResolveAt, &t.Gen, &expires, &t.AssembledAt, &t.AssemblyCount,
		&t.AssemblyReason, &t.SpanCount); err != nil {
		return Trace{}, err
	}
	copy(t.Key.TraceID[:], traceID)
	if expires != nil {
		t.LeaseExpires = *expires
	}
	return t, nil
}

// ClaimDue leases up to ClaimBatch due traces to owner for LeaseTTL: a
// pending trace whose resolve_at has passed and whose lease is free or
// expired, earliest due first. SKIP LOCKED passes over traces another
// claim, or an ingest that is writing to them, holds, so no replica
// waits on another; the next tick takes them. No lock outlives the
// claim's own transaction.
//
// owner must be unique to this claim, not only to the process (for
// example the process id plus a claim counter): the lease checks in
// RenewLease, Defer and MarkAssembled tell claims apart by owner, so an
// owner id reused across claims would let a stale assembly from an
// earlier claim act on a later one.
func (s *Store) ClaimDue(ctx context.Context, owner string) ([]Trace, error) {
	if owner == "" {
		return nil, errors.New("otlpstage: a claim needs an owner")
	}
	now := s.clock()
	rows, err := s.pool.Query(ctx, `
		UPDATE otlp_traces t SET lease_owner = $1, lease_expires = $3
		FROM (SELECT token_key, trace_id FROM otlp_traces
		      WHERE pending AND resolve_at <= $2
		        AND (lease_expires IS NULL OR lease_expires < $2)
		      ORDER BY resolve_at
		      LIMIT $4
		      FOR UPDATE SKIP LOCKED) due
		WHERE t.token_key = due.token_key AND t.trace_id = due.trace_id
		RETURNING `+claimedColumns,
		owner, now, now.Add(LeaseTTL), ClaimBatch)
	if err != nil {
		return nil, fmt.Errorf("otlpstage: claim due traces: %w", err)
	}
	defer rows.Close()
	var out []Trace
	for rows.Next() {
		t, err := scanTrace(rows)
		if err != nil {
			return nil, fmt.Errorf("otlpstage: scan claimed trace: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("otlpstage: claim due traces: %w", err)
	}
	return out, nil
}

// LoadTrace reads a trace's gen and capture and all its records in one
// snapshot, with content for the records not yet assembled. A record
// committed after the snapshot is not in it, so MarkAssembled, given
// only the snapshot's keys, leaves it unassembled.
//
// The snapshot's Capture and content are the posture when it was read.
// A record without capture staged afterwards turns the trace's capture
// off, and the content loaded here must then not be published: the
// assembler re-reads the posture with RenewLease before every chunk,
// and MarkAssembled reports it again.
func (s *Store) LoadTrace(ctx context.Context, key TraceKey) (LoadedTrace, error) {
	out := LoadedTrace{Key: key}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, fmt.Errorf("otlpstage: begin load: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	err = tx.QueryRow(ctx,
		`SELECT gen, capture FROM otlp_traces WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:]).Scan(&out.Gen, &out.Capture)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrTraceNotFound
	}
	if err != nil {
		return out, fmt.Errorf("otlpstage: load trace: %w", err)
	}
	rows, err := tx.Query(ctx, `
		SELECT s.span_id, s.kind, s.parent_span_id, s.remote_parent, s.scope_name, s.scope_version,
		       s.name, s.op, s.agent_name, s.start_ns, s.end_ns, s.status, s.meta,
		       s.assembled, s.assembled_in, s.received_at, c.content
		FROM otlp_spans s
		LEFT JOIN otlp_span_content c
		       ON NOT s.assembled
		      AND c.token_key = s.token_key AND c.trace_id = s.trace_id
		      AND c.span_id = s.span_id AND c.kind = s.kind
		WHERE s.token_key = $1 AND s.trace_id = $2
		ORDER BY s.start_ns, s.span_id, s.kind`,
		key.TokenKey, key.TraceID[:])
	if err != nil {
		return out, fmt.Errorf("otlpstage: load records: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			f              StagedFact
			spanID, parent []byte
			kind           int16
			content        []byte
			assembledIn    *int32
		)
		if err := rows.Scan(&spanID, &kind, &parent, &f.RemoteParent, &f.ScopeName, &f.ScopeVersion,
			&f.Name, &f.Op, &f.AgentName, &f.StartNs, &f.EndNs, &f.Status, &f.Meta,
			&f.Assembled, &assembledIn, &f.ReceivedAt, &content); err != nil {
			return out, fmt.Errorf("otlpstage: scan record: %w", err)
		}
		copy(f.SpanID[:], spanID)
		copy(f.ParentSpanID[:], parent)
		f.Kind = Kind(kind)
		if assembledIn != nil {
			f.AssembledIn = int(*assembledIn)
		}
		if content != nil {
			f.Content = content
		}
		out.Facts = append(out.Facts, f)
	}
	if err := rows.Err(); err != nil {
		return out, fmt.Errorf("otlpstage: load records: %w", err)
	}
	return out, nil
}

// Lease is the state RenewLease reads.
type Lease struct {
	// Held is false when owner's lease has expired or another claim
	// holds the trace; the caller then stops publishing.
	Held bool
	// Capture is the trace's capture posture now. When it is false the
	// caller publishes none of the content it loaded, whatever the
	// snapshot said.
	Capture bool
}

// RenewLease extends owner's unexpired lease on the trace by LeaseTTL
// from now, and reads the trace's capture posture. The assembler calls
// it before every chunk it publishes, the first included. An expired
// lease is not renewed even when no other claim has taken the trace: its
// assembly ends, and the next claim starts over.
func (s *Store) RenewLease(ctx context.Context, owner string, key TraceKey) (Lease, error) {
	now := s.clock()
	var lease Lease
	err := s.pool.QueryRow(ctx, `
		UPDATE otlp_traces SET lease_expires = $5
		WHERE token_key = $1 AND trace_id = $2 AND lease_owner = $3 AND lease_expires >= $4
		RETURNING capture`,
		key.TokenKey, key.TraceID[:], owner, now, now.Add(LeaseTTL)).Scan(&lease.Capture)
	if errors.Is(err, pgx.ErrNoRows) {
		return Lease{}, nil
	}
	if err != nil {
		return Lease{}, fmt.Errorf("otlpstage: renew lease: %w", err)
	}
	lease.Held = true
	return lease, nil
}

// Defer releases owner's unexpired lease on a trace that is not ready
// yet, or whose publish failed, and makes it due again at resolveAt, but
// never later than the trace's own timers allow: not past MaxTraceHold
// after its first record, and, when a record was staged during the
// claim (its gen moved from gen, the gen the caller decided on), not
// past the time that record made it due. It returns false when owner no
// longer holds an unexpired lease.
func (s *Store) Defer(ctx context.Context, owner string, key TraceKey, gen int64, resolveAt time.Time) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE otlp_traces
		SET lease_owner = NULL, lease_expires = NULL,
		    resolve_at = LEAST(first_received_at + $7 * interval '1 microsecond',
		                       CASE WHEN gen <> $5 THEN LEAST(resolve_at, $6) ELSE $6 END)
		WHERE token_key = $1 AND trace_id = $2 AND lease_owner = $3 AND lease_expires >= $4`,
		key.TokenKey, key.TraceID[:], owner, s.clock(), gen, resolveAt.UTC(), MaxTraceHold.Microseconds())
	if err != nil {
		return false, fmt.Errorf("otlpstage: defer trace: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// MarkResult is what MarkAssembled did.
type MarkResult struct {
	// Marked is false when owner no longer held an unexpired lease:
	// nothing was marked, and the next holder publishes the same event
	// ids again.
	Marked bool
	// Pending is true when a record was staged after the snapshot was
	// loaded (the trace's gen moved), so the trace stays due.
	Pending bool
	// Capture is the trace's capture posture at the mark. It is false
	// when a record without capture turned the trace off after the
	// snapshot; the assembler re-checks the posture before each chunk
	// (RenewLease), and this is the last reading, for its log line.
	Capture bool
}

// MarkAssembled records an assembly of the snapshot LoadTrace returned:
// when owner's lease is unexpired, it releases it, counts the assembly and its reason, keeps
// the trace pending when its gen moved since the snapshot, marks the
// given records assembled by key, with the assembly's number (the new
// assembly_count) in assembled_in, and deletes their content. The trace
// row is updated first, so the mark waits for an ingest writing to the
// trace and then sees its gen; and a record committed after the
// snapshot is not among keys, so it stays unassembled whatever order
// the two transactions committed in.
func (s *Store) MarkAssembled(ctx context.Context, owner string, key TraceKey, gen int64, reason Reason, keys []FactKey) (MarkResult, error) {
	var (
		res      MarkResult
		assembly int32
	)
	if !reason.valid() {
		return res, fmt.Errorf("otlpstage: unknown assembly reason %q", reason)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return res, fmt.Errorf("otlpstage: begin mark: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	err = tx.QueryRow(ctx, `
		UPDATE otlp_traces
		SET lease_owner = NULL, lease_expires = NULL, assembled_at = $5,
		    assembly_count = assembly_count + 1, assembly_reason = $6,
		    pending = (gen <> $4)
		WHERE token_key = $1 AND trace_id = $2 AND lease_owner = $3 AND lease_expires >= $5
		RETURNING pending, capture, assembly_count`,
		key.TokenKey, key.TraceID[:], owner, gen, s.clock(), string(reason)).Scan(&res.Pending, &res.Capture, &assembly)
	if errors.Is(err, pgx.ErrNoRows) {
		return MarkResult{}, nil
	}
	if err != nil {
		return MarkResult{}, fmt.Errorf("otlpstage: mark trace: %w", err)
	}
	if len(keys) > 0 {
		ids := make([][]byte, len(keys))
		kinds := make([]int16, len(keys))
		for i, k := range keys {
			ids[i] = k.SpanID[:]
			kinds[i] = int16(k.Kind)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE otlp_spans SET assembled = true, assembled_in = $5
			WHERE token_key = $1 AND trace_id = $2 AND NOT assembled
			  AND (span_id, kind) IN (SELECT * FROM unnest($3::bytea[], $4::smallint[]))`,
			key.TokenKey, key.TraceID[:], ids, kinds, assembly); err != nil {
			return MarkResult{}, fmt.Errorf("otlpstage: mark records: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM otlp_span_content
			WHERE token_key = $1 AND trace_id = $2
			  AND (span_id, kind) IN (SELECT * FROM unnest($3::bytea[], $4::smallint[]))`,
			key.TokenKey, key.TraceID[:], ids, kinds); err != nil {
			return MarkResult{}, fmt.Errorf("otlpstage: delete assembled content: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return MarkResult{}, fmt.Errorf("otlpstage: commit mark: %w", err)
	}
	res.Marked = true
	return res, nil
}

// SweepTraces deletes the traces whose retention has passed, with their
// records and content by cascade: CompleteRetention after a complete
// assembly, DegradedRetention after any other. A pending trace is never
// deleted, and one an ingest or a claim holds is passed over until the
// next sweep. It deletes in batches of SweepBatch until none is left,
// and returns how many traces it deleted.
func (s *Store) SweepTraces(ctx context.Context) (int64, error) {
	now := s.clock()
	return sweep(ctx, s.pool, `
		DELETE FROM otlp_traces t
		USING (SELECT token_key, trace_id FROM otlp_traces
		       WHERE NOT pending AND assembled_at < $1
		         AND (assembly_reason = $4 OR assembled_at < $2)
		       LIMIT $3
		       FOR UPDATE SKIP LOCKED) expired
		WHERE t.token_key = expired.token_key AND t.trace_id = expired.trace_id
		  AND NOT t.pending`,
		now.Add(-CompleteRetention), now.Add(-DegradedRetention), SweepBatch, string(ReasonComplete))
}

// SweepContent deletes staged content more than ContentBackstopAge old,
// whatever its trace's state: the backstop for content no assembly
// reached. It deletes in batches of SweepBatch until none is left, and
// returns how many rows it deleted.
func (s *Store) SweepContent(ctx context.Context) (int64, error) {
	return sweep(ctx, s.pool, `
		DELETE FROM otlp_span_content c
		USING (SELECT token_key, trace_id, span_id, kind FROM otlp_span_content
		       WHERE staged_at < $1
		       LIMIT $2
		       FOR UPDATE SKIP LOCKED) old
		WHERE c.token_key = old.token_key AND c.trace_id = old.trace_id
		  AND c.span_id = old.span_id AND c.kind = old.kind`,
		s.clock().Add(-ContentBackstopAge), SweepBatch)
}

func sweep(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) (int64, error) {
	var total int64
	for {
		tag, err := pool.Exec(ctx, sql, args...)
		if err != nil {
			return total, fmt.Errorf("otlpstage: sweep: %w", err)
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < SweepBatch {
			return total, nil
		}
	}
}
