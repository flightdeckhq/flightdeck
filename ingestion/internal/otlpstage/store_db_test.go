package otlpstage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These tests run against a real Postgres at TEST_POSTGRES_URL (else
// FLIGHTDECK_POSTGRES_URL) migrated through 000036, and skip when
// neither is set (CI's unit jobs run without a database).
//
// Point them at a database of their own, never one an ingestion process
// assembles from. The store's clock runs in 2001, so a claim or a sweep
// made here never takes a real deployment's rows, whose times are
// current; but the reverse does not hold: a real-clock assembler or
// sweeper on the same database finds every 2001-dated test trace long
// due or expired, and claims or deletes it mid-test. For the same
// reason, never run two copies of this package against one database at
// once: their 2001-dated claims take each other's traces. Each test stages
// under a token key of its own, deletes its rows when it ends, and
// claim assertions look only at the test's own token.

// pollTimeout bounds every wait for another goroutine's database work:
// generous against a loaded dev box, and the poll returns as soon as the
// condition holds.
const pollTimeout = 10 * time.Second

// pollInterval is how often a poll re-checks its condition.
const pollInterval = 5 * time.Millisecond

var testEpoch = time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func (c *testClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
}

type testEnv struct {
	t     *testing.T
	pool  *pgxpool.Pool
	store *Store
	clock *testClock
	token string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		dsn = os.Getenv("FLIGHTDECK_POSTGRES_URL")
	}
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL or FLIGHTDECK_POSTGRES_URL set; skipping DB test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("postgres unavailable, skipping DB test: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable, skipping DB test: %v", err)
	}
	t.Cleanup(pool.Close)
	var present, assembledIn bool
	if err := pool.QueryRow(ctx, `
		SELECT to_regclass('otlp_traces') IS NOT NULL,
		       EXISTS (SELECT 1 FROM information_schema.columns
		               WHERE table_name = 'otlp_spans' AND column_name = 'assembled_in')`).Scan(&present, &assembledIn); err != nil {
		t.Fatalf("check staging schema: %v", err)
	}
	if !present {
		t.Fatal("otlp_traces is missing: apply migration 000035 to the test database")
	}
	if !assembledIn {
		t.Fatal("otlp_spans.assembled_in is missing: apply migration 000036 to the test database")
	}
	clock := &testClock{now: testEpoch}
	token := "otlpstage-test-" + randomHex(t, 6)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM otlp_traces WHERE token_key = $1`, token)
	})
	return &testEnv{t: t, pool: pool, store: NewStore(pool, WithClock(clock.Now)), clock: clock, token: token}
}

func randomHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func (e *testEnv) newKey() TraceKey {
	k := TraceKey{TokenKey: e.token}
	if _, err := rand.Read(k.TraceID[:]); err != nil {
		e.t.Fatal(err)
	}
	return k
}

func spanID(n byte) [8]byte { return [8]byte{0xa0, 0, 0, 0, 0, 0, 0, n} }

// idBytes is spanID(n) as a query argument.
func idBytes(n byte) []byte {
	id := spanID(n)
	return id[:]
}

// span is a model-call span with a local parent (a non-root).
func span(id, parent byte) Record {
	r := Record{Fact: Fact{
		SpanID: spanID(id), Kind: KindSpan,
		ScopeName: "pydantic-ai", ScopeVersion: "1.0.0", Name: "chat gpt-4o", Op: "chat",
		StartNs: int64(id) * 1000, EndNs: int64(id)*1000 + 500,
		Meta: json.RawMessage(`{"gen_ai.usage.input_tokens":10}`),
	}}
	if parent != 0 {
		r.ParentSpanID = spanID(parent)
	}
	return r
}

func captured(r Record, content string) Record {
	r.Capture = true
	r.Content = json.RawMessage(content)
	return r
}

func (e *testEnv) batch(key TraceKey, records ...Record) TraceBatch {
	return TraceBatch{
		Key: key, TokenName: "test token", Source: "pydantic_ai", SourceVersion: "1.0.0",
		Resource: json.RawMessage(`{"service.name":"otlpstage-test"}`),
		Records:  records,
	}
}

func (e *testEnv) stage(batches ...TraceBatch) StageResult {
	e.t.Helper()
	res, err := e.store.Stage(context.Background(), batches)
	if err != nil {
		e.t.Fatalf("Stage: %v", err)
	}
	return res
}

func (e *testEnv) traceRow(key TraceKey) Trace {
	e.t.Helper()
	row := e.pool.QueryRow(context.Background(),
		`SELECT `+claimedColumns+` FROM otlp_traces t WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:])
	tr, err := scanTrace(row)
	if err != nil {
		e.t.Fatalf("read trace row: %v", err)
	}
	return tr
}

func (e *testEnv) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatalf("count: %v", err)
	}
	return n
}

func (e *testEnv) contentRows(key TraceKey) int {
	return e.count(`SELECT count(*) FROM otlp_span_content WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:])
}

func (e *testEnv) spanRows(key TraceKey) int {
	return e.count(`SELECT count(*) FROM otlp_spans WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:])
}

func (e *testEnv) assembledFlag(key TraceKey, id byte) bool {
	e.t.Helper()
	var assembled bool
	if err := e.pool.QueryRow(context.Background(), `
		SELECT assembled FROM otlp_spans
		WHERE token_key = $1 AND trace_id = $2 AND span_id = $3 AND kind = 1`,
		key.TokenKey, key.TraceID[:], idBytes(id)).Scan(&assembled); err != nil {
		e.t.Fatalf("read assembled flag: %v", err)
	}
	return assembled
}

// claimOwn claims due traces and returns those of this test's token.
func (e *testEnv) claimOwn(owner string) []Trace {
	e.t.Helper()
	claimed, err := e.store.ClaimDue(context.Background(), owner)
	if err != nil {
		e.t.Fatalf("ClaimDue: %v", err)
	}
	return e.own(claimed)
}

func (e *testEnv) own(traces []Trace) []Trace {
	var out []Trace
	for _, tr := range traces {
		if tr.Key.TokenKey == e.token {
			out = append(out, tr)
		}
	}
	return out
}

// beginIngest opens a staging transaction that writes batches and stays
// open, holding the trace row locks, until the test commits it.
func (e *testEnv) beginIngest(batches ...TraceBatch) pgx.Tx {
	e.t.Helper()
	ctx := context.Background()
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		e.t.Fatalf("begin ingest: %v", err)
	}
	e.t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if _, err := e.store.stageTx(ctx, tx, batches); err != nil {
		e.t.Fatalf("stageTx: %v", err)
	}
	return tx
}

// poll waits until cond holds, failing the test after pollTimeout.
func poll(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(pollTimeout)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		<-ticker.C
	}
}

// claimOne makes key due, claims it as owner and loads it.
func (e *testEnv) claimOne(owner string, key TraceKey) (Trace, LoadedTrace) {
	e.t.Helper()
	e.clock.Advance(QuietTimeout + time.Second)
	claimed := e.claimOwn(owner)
	if len(claimed) != 1 || claimed[0].Key != key {
		e.t.Fatalf("claimed %d traces of this test, want exactly the one staged", len(claimed))
	}
	lt, err := e.store.LoadTrace(context.Background(), key)
	if err != nil {
		e.t.Fatalf("LoadTrace: %v", err)
	}
	return claimed[0], lt
}

func TestStageIsIdempotent(t *testing.T) {
	e := newTestEnv(t)
	key := e.newKey()
	b := e.batch(key, span(1, 0), span(2, 1))

	if res := e.stage(b); res != (StageResult{Staged: 2}) {
		t.Fatalf("first stage = %+v, want 2 staged", res)
	}
	before := e.traceRow(key)
	if before.Gen != 1 || before.SpanCount != 2 {
		t.Fatalf("after first stage gen=%d span_count=%d, want 1 and 2", before.Gen, before.SpanCount)
	}

	// The exporter resends the same batch later: nothing changes.
	e.clock.Advance(10 * time.Second)
	if res := e.stage(b); res != (StageResult{Duplicate: 2}) {
		t.Fatalf("resent stage = %+v, want 2 duplicates", res)
	}
	after := e.traceRow(key)
	if after.Gen != before.Gen || !after.ResolveAt.Equal(before.ResolveAt) ||
		!after.LastReceivedAt.Equal(before.LastReceivedAt) || after.SpanCount != before.SpanCount {
		t.Fatalf("a resent batch moved the trace: before %+v, after %+v", before, after)
	}

	// A record repeated inside one request is staged once.
	if res := e.stage(e.batch(key, span(3, 1), span(3, 1))); res != (StageResult{Staged: 1, Duplicate: 1}) {
		t.Fatalf("repeated-record stage = %+v, want 1 staged and 1 duplicate", res)
	}
	if got := e.traceRow(key); got.Gen != 2 || got.SpanCount != 3 {
		t.Fatalf("gen=%d span_count=%d, want 2 and 3", got.Gen, got.SpanCount)
	}
}

func TestStageWritesTheTraceRowBeforeItsRecords(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()

	// A record of a trace with no row breaks the foreign key, so the
	// store must write the trace row first.
	_, err := e.pool.Exec(ctx, `
		INSERT INTO otlp_spans (token_key, trace_id, span_id, kind, scope_name, name, start_ns, end_ns, status, meta)
		VALUES ($1, $2, $3, 1, 's', 'n', 0, 0, 0, '{}')`, key.TokenKey, key.TraceID[:], idBytes(1))
	assertForeignKeyViolation(t, err)

	res := e.stage(e.batch(key, captured(span(1, 0), `{"m":1}`)))
	if res.Staged != 1 || e.spanRows(key) != 1 || e.contentRows(key) != 1 {
		t.Fatalf("stage on a new trace = %+v with %d records and %d content rows, want 1 of each",
			res, e.spanRows(key), e.contentRows(key))
	}

	// Content of a record that is not staged breaks its foreign key too.
	_, err = e.pool.Exec(ctx, `
		INSERT INTO otlp_span_content (token_key, trace_id, span_id, kind, content)
		VALUES ($1, $2, $3, 2, '{}')`, key.TokenKey, key.TraceID[:], idBytes(1))
	assertForeignKeyViolation(t, err)

	// Deleting the trace row removes its records and content.
	if _, err := e.pool.Exec(ctx, `DELETE FROM otlp_traces WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:]); err != nil {
		t.Fatal(err)
	}
	if e.spanRows(key) != 0 || e.contentRows(key) != 0 {
		t.Fatal("deleting the trace row left its records or content")
	}
}

func assertForeignKeyViolation(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("insert error = %v, want a foreign key violation (23503)", err)
	}
}

func TestStageDetectsTheRoot(t *testing.T) {
	t.Run("a child alone waits the quiet timeout", func(t *testing.T) {
		e := newTestEnv(t)
		key := e.newKey()
		e.stage(e.batch(key, span(2, 1)))
		tr := e.traceRow(key)
		if tr.RootSeenAt != nil || !tr.ResolveAt.Equal(testEpoch.Add(QuietTimeout)) {
			t.Fatalf("root_seen_at=%v resolve_at=%v, want none and epoch+quiet", tr.RootSeenAt, tr.ResolveAt)
		}
	})
	t.Run("a log record without a parent is not a root", func(t *testing.T) {
		e := newTestEnv(t)
		key := e.newKey()
		log := span(2, 0)
		log.Kind = KindLog
		e.stage(e.batch(key, log))
		if tr := e.traceRow(key); tr.RootSeenAt != nil {
			t.Fatalf("root_seen_at=%v after a log record, want none", tr.RootSeenAt)
		}
	})
	t.Run("a span without a parent is the root", func(t *testing.T) {
		e := newTestEnv(t)
		key := e.newKey()
		e.stage(e.batch(key, span(2, 1)))
		e.clock.Advance(time.Minute)
		e.stage(e.batch(key, span(1, 0)))
		tr := e.traceRow(key)
		at := testEpoch.Add(time.Minute)
		if tr.RootSeenAt == nil || !tr.RootSeenAt.Equal(at) || !tr.ResolveAt.Equal(at.Add(RootGrace)) {
			t.Fatalf("root_seen_at=%v resolve_at=%v, want %v and +root grace", tr.RootSeenAt, tr.ResolveAt, at)
		}
		// A later record keeps the first root time and extends the grace.
		e.clock.Advance(2 * time.Second)
		e.stage(e.batch(key, span(3, 1)))
		tr = e.traceRow(key)
		if !tr.RootSeenAt.Equal(at) || !tr.ResolveAt.Equal(at.Add(2*time.Second+RootGrace)) {
			t.Fatalf("after a later record root_seen_at=%v resolve_at=%v", tr.RootSeenAt, tr.ResolveAt)
		}
	})
	t.Run("a span with a remote parent is the root", func(t *testing.T) {
		e := newTestEnv(t)
		key := e.newKey()
		root := span(1, 7)
		root.RemoteParent = true
		e.stage(e.batch(key, root))
		tr := e.traceRow(key)
		if tr.RootSeenAt == nil || !tr.ResolveAt.Equal(testEpoch.Add(RootGrace)) {
			t.Fatalf("root_seen_at=%v resolve_at=%v, want the root seen and epoch+grace", tr.RootSeenAt, tr.ResolveAt)
		}
	})
	t.Run("the max hold caps the timer", func(t *testing.T) {
		e := newTestEnv(t)
		key := e.newKey()
		e.stage(e.batch(key, span(2, 1)))
		e.clock.Advance(MaxTraceHold - time.Second)
		e.stage(e.batch(key, span(1, 0)))
		if tr := e.traceRow(key); !tr.ResolveAt.Equal(testEpoch.Add(MaxTraceHold)) {
			t.Fatalf("resolve_at=%v, want the first record + max hold", tr.ResolveAt)
		}
	})
}

func TestStageCaptureIsANDedAndOffDeletesContent(t *testing.T) {
	e := newTestEnv(t)
	key := e.newKey()

	// A record whose resource does not declare capture stages no
	// content, even when it carries some.
	uncaptured := span(9, 1)
	uncaptured.Content = json.RawMessage(`{"secret":true}`)
	other := e.newKey()
	e.stage(e.batch(other, uncaptured))
	if tr := e.traceRow(other); tr.Capture || e.contentRows(other) != 0 {
		t.Fatalf("capture=%v with %d content rows for a record without capture, want off and none",
			tr.Capture, e.contentRows(other))
	}

	e.stage(e.batch(key, captured(span(1, 0), `{"a":1}`), captured(span(2, 1), `{"b":2}`)))
	if tr := e.traceRow(key); !tr.Capture || e.contentRows(key) != 2 {
		t.Fatalf("capture=%v with %d content rows, want on and 2", tr.Capture, e.contentRows(key))
	}

	// One record from a resource without capture turns the trace off and
	// deletes everything staged, its own content included.
	off := span(3, 1)
	off.Content = json.RawMessage(`{"c":3}`)
	e.stage(e.batch(key, off, captured(span(4, 1), `{"d":4}`)))
	if tr := e.traceRow(key); tr.Capture || e.contentRows(key) != 0 {
		t.Fatalf("capture=%v with %d content rows after an uncaptured record, want off and none",
			tr.Capture, e.contentRows(key))
	}

	// Off wins for good: a captured record after it stages no content.
	e.stage(e.batch(key, captured(span(5, 1), `{"e":5}`)))
	if tr := e.traceRow(key); tr.Capture || e.contentRows(key) != 0 {
		t.Fatalf("capture=%v with %d content rows after off, want off and none", tr.Capture, e.contentRows(key))
	}
	if e.spanRows(key) != 5 {
		t.Fatalf("%d records staged, want 5: capture never drops metadata", e.spanRows(key))
	}

	// A resent record without capture also turns a trace off.
	third := e.newKey()
	first := captured(span(1, 0), `{"a":1}`)
	e.stage(e.batch(third, first))
	resent := first
	resent.Capture = false
	resent.Content = nil
	if res := e.stage(e.batch(third, resent)); res.Duplicate != 1 {
		t.Fatalf("resent stage = %+v, want 1 duplicate", res)
	}
	if tr := e.traceRow(third); tr.Capture || e.contentRows(third) != 0 || tr.Gen != 1 {
		t.Fatalf("capture=%v content=%d gen=%d after a resent uncaptured record, want off, none and 1",
			tr.Capture, e.contentRows(third), tr.Gen)
	}
}

func TestStageCapsRecordsPerTrace(t *testing.T) {
	e := newTestEnv(t)
	key := e.newKey()
	records := make([]Record, MaxSpansPerTrace-1)
	for i := range records {
		var id [8]byte
		id[0], id[6], id[7] = 0xb0, byte(i>>8), byte(i)
		records[i] = Record{Fact: Fact{SpanID: id, Kind: KindSpan, ScopeName: "s", Name: "n", ParentSpanID: spanID(1)}}
	}
	if res := e.stage(e.batch(key, records...)); res.Staged != MaxSpansPerTrace-1 {
		t.Fatalf("staged %d, want %d", res.Staged, MaxSpansPerTrace-1)
	}
	// One resent record, then two new ones with room for one: the
	// resent record does not take the new one's place.
	res := e.stage(e.batch(key, records[0], span(1, 0), span(2, 1)))
	if res != (StageResult{Staged: 1, Duplicate: 1, OverCap: 1}) {
		t.Fatalf("stage at the cap = %+v, want 1 staged, 1 duplicate, 1 over the cap", res)
	}
	if tr := e.traceRow(key); tr.SpanCount != MaxSpansPerTrace {
		t.Fatalf("span_count=%d, want %d", tr.SpanCount, MaxSpansPerTrace)
	}
	if res := e.stage(e.batch(key, span(3, 1))); res != (StageResult{OverCap: 1}) {
		t.Fatalf("stage past the cap = %+v, want 1 over the cap", res)
	}
}

// Two requests that touch the same traces in opposite orders never
// deadlock, because each writes its traces in (token, trace) order. The
// requests run in waves of one opposite-order pair, released together,
// so at most two writes ever queue on a trace's row lock: a longer queue
// would wait out the real StageTimeout under load and fail for a reason
// that is not a deadlock. Without the ordering, a pair that each take
// their first trace before either takes its second deadlocks, which
// Postgres reports as an error the test fails on.
func TestStageConcurrentRequestsDoNotDeadlock(t *testing.T) {
	// waves is how many opposite-order pairs run, one pair at a time.
	// With the ordering removed from the store, six of six runs
	// deadlocked in the first wave (the pair that creates both rows); the
	// later waves, on existing rows, cover the lock-on-update path too,
	// and each takes milliseconds.
	const waves = 25
	e := newTestEnv(t)
	a, b := e.newKey(), e.newKey()
	for i := range waves {
		id := byte(2 * (i + 1))
		pairs := [2][]TraceBatch{
			{e.batch(a, span(id, 1)), e.batch(b, span(id, 1))},
			{e.batch(b, span(id+1, 1)), e.batch(a, span(id+1, 1))},
		}
		start := make(chan struct{})
		errs := make(chan error, len(pairs))
		var wg sync.WaitGroup
		for _, batches := range pairs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, err := e.store.Stage(context.Background(), batches)
				errs <- err
			}()
		}
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("wave %d: concurrent Stage: %v", i, err)
			}
		}
	}
	if e.spanRows(a) != 2*waves || e.spanRows(b) != 2*waves {
		t.Fatalf("staged %d and %d records, want %d each", e.spanRows(a), e.spanRows(b), 2*waves)
	}
}

func TestClaimDueTakesOnlyDueTraces(t *testing.T) {
	e := newTestEnv(t)
	rooted, quiet := e.newKey(), e.newKey()
	e.stage(e.batch(rooted, span(1, 0)), e.batch(quiet, span(2, 1)))

	if got := e.claimOwn("a"); len(got) != 0 {
		t.Fatalf("claimed %d traces before any was due", len(got))
	}
	e.clock.Advance(RootGrace)
	got := e.claimOwn("a")
	if len(got) != 1 || got[0].Key != rooted {
		t.Fatalf("claimed %v at the root grace, want only the rooted trace", got)
	}
	if !got[0].LeaseExpires.Equal(testEpoch.Add(RootGrace + LeaseTTL)) {
		t.Fatalf("lease expires %v, want claim time + lease TTL", got[0].LeaseExpires)
	}
	if got[0].Gen != 1 || got[0].Source != "pydantic_ai" || !got[0].FirstReceivedAt.Equal(testEpoch) {
		t.Fatalf("claimed row %+v does not carry the staged row", got[0])
	}
	lt, err := e.store.LoadTrace(context.Background(), rooted)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.MarkAssembled(context.Background(), "a", rooted, lt.Gen, ReasonComplete, lt.Unassembled()); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(QuietTimeout)
	if got := e.claimOwn("b"); len(got) != 1 || got[0].Key != quiet {
		t.Fatalf("claimed %v after the quiet timeout, want only the rootless trace (the other is assembled)", got)
	}
}

func TestClaimDueConcurrentClaimersSplitTheTraces(t *testing.T) {
	e := newTestEnv(t)
	const traces = 3*ClaimBatch + 5
	want := map[TraceKey]bool{}
	var batches []TraceBatch
	for range traces {
		k := e.newKey()
		want[k] = true
		batches = append(batches, e.batch(k, span(1, 0)))
	}
	e.stage(batches...)
	e.clock.Advance(RootGrace)

	claimedBy := map[string][]Trace{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, owner := range []string{"replica-a", "replica-b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for {
				got, err := e.store.ClaimDue(context.Background(), owner)
				if err != nil {
					t.Errorf("ClaimDue(%s): %v", owner, err)
					return
				}
				if len(got) == 0 {
					return
				}
				mu.Lock()
				claimedBy[owner] = append(claimedBy[owner], e.own(got)...)
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()

	seen := map[TraceKey]string{}
	for owner, got := range claimedBy {
		for _, tr := range got {
			if prev, dup := seen[tr.Key]; dup {
				t.Fatalf("trace claimed by both %s and %s", prev, owner)
			}
			seen[tr.Key] = owner
		}
	}
	if len(seen) != traces {
		t.Fatalf("claimed %d distinct traces, want %d", len(seen), traces)
	}
	for k := range want {
		var owner string
		if err := e.pool.QueryRow(context.Background(),
			`SELECT lease_owner FROM otlp_traces WHERE token_key = $1 AND trace_id = $2`,
			k.TokenKey, k.TraceID[:]).Scan(&owner); err != nil {
			t.Fatal(err)
		}
		if owner != seen[k] {
			t.Fatalf("trace leased to %q, but claimed by %q", owner, seen[k])
		}
	}
}

// A trace an ingest is writing is passed over, not waited on.
func TestClaimDueSkipsATraceAnIngestHolds(t *testing.T) {
	e := newTestEnv(t)
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	e.clock.Advance(RootGrace)

	tx := e.beginIngest(e.batch(key, span(2, 1)))
	// A claim that waited on the ingest's lock would block until the
	// commit below; the deadline turns that into a failure.
	ctx, cancel := context.WithTimeout(context.Background(), pollTimeout)
	defer cancel()
	claimed, err := e.store.ClaimDue(ctx, "a")
	if err != nil {
		t.Fatalf("ClaimDue while an ingest held the trace: %v", err)
	}
	if got := e.own(claimed); len(got) != 0 {
		t.Fatalf("claimed %d traces while an ingest held the trace, want none", len(got))
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(RootGrace)
	if got := e.claimOwn("a"); len(got) != 1 {
		t.Fatalf("claimed %d traces after the ingest committed, want 1", len(got))
	}
}

func TestLoadTraceReturnsTheSkeletonAndUnassembledContent(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	if _, err := e.store.LoadTrace(ctx, e.newKey()); !errors.Is(err, ErrTraceNotFound) {
		t.Fatalf("LoadTrace of an unknown trace = %v, want ErrTraceNotFound", err)
	}

	key := e.newKey()
	root := captured(span(1, 0), `{"root":true}`)
	root.AgentName = "assistant"
	root.Op = "invoke_agent"
	remote := captured(span(2, 1), `{"call":1}`)
	remote.RemoteParent = true
	e.stage(e.batch(key, root, remote))
	_, lt := e.claimOne("a", key)
	if lt.Gen != 1 || !lt.Capture || len(lt.Facts) != 2 {
		t.Fatalf("loaded gen=%d capture=%v with %d records, want 1, on and 2", lt.Gen, lt.Capture, len(lt.Facts))
	}
	got := lt.Facts[0]
	if got.SpanID != spanID(1) || got.ParentSpanID != ([8]byte{}) || got.AgentName != "assistant" ||
		got.Op != "invoke_agent" || got.ScopeName != "pydantic-ai" || got.EndNs != 1500 ||
		string(got.Content) != `{"root": true}` || got.Assembled {
		t.Fatalf("loaded root %+v does not round-trip", got)
	}
	var meta map[string]int
	if err := json.Unmarshal(got.Meta, &meta); err != nil || meta["gen_ai.usage.input_tokens"] != 10 {
		t.Fatalf("loaded meta %s does not round-trip: %v", got.Meta, err)
	}
	if lt.Facts[1].ParentSpanID != spanID(1) || !lt.Facts[1].RemoteParent {
		t.Fatalf("loaded child %+v lost its parent", lt.Facts[1])
	}

	if res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled()); err != nil || !res.Marked {
		t.Fatalf("MarkAssembled = %+v, %v", res, err)
	}
	// A late record: the skeleton comes back whole, content only for the
	// unassembled record.
	e.stage(e.batch(key, captured(span(3, 1), `{"late":1}`)))
	_, lt = e.claimOne("a", key)
	if len(lt.Facts) != 3 {
		t.Fatalf("loaded %d records, want the 3 of the skeleton", len(lt.Facts))
	}
	for _, f := range lt.Facts {
		if f.Assembled == (f.SpanID == spanID(3)) {
			t.Fatalf("record %x assembled=%v", f.SpanID, f.Assembled)
		}
		if (f.Content != nil) != (f.SpanID == spanID(3)) {
			t.Fatalf("record %x content=%s, want content only for the unassembled record", f.SpanID, f.Content)
		}
	}
	if keys := lt.Unassembled(); len(keys) != 1 || keys[0] != (FactKey{SpanID: spanID(3), Kind: KindSpan}) {
		t.Fatalf("Unassembled = %v, want the late record", keys)
	}
}

func TestMarkAssembledMarksTheSnapshotAndDeletesItsContent(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, captured(span(1, 0), `{"a":1}`), captured(span(2, 1), `{"b":2}`)))
	_, lt := e.claimOne("a", key)

	res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled())
	if err != nil || res != (MarkResult{Marked: true, Capture: true}) {
		t.Fatalf("MarkAssembled = %+v, %v; want marked, not pending, capture on", res, err)
	}
	tr := e.traceRow(key)
	if tr.AssembledAt == nil || !tr.AssembledAt.Equal(e.clock.Now()) {
		t.Fatalf("assembled_at=%v, want the mark time %v", tr.AssembledAt, e.clock.Now())
	}
	if tr.AssemblyCount != 1 || tr.AssemblyReason != "complete" || !tr.LeaseExpires.IsZero() {
		t.Fatalf("after the mark count=%d reason=%q lease=%v", tr.AssemblyCount, tr.AssemblyReason, tr.LeaseExpires)
	}
	if !e.assembledFlag(key, 1) || !e.assembledFlag(key, 2) || e.contentRows(key) != 0 {
		t.Fatal("the mark left a loaded record unassembled or its content staged")
	}
	if got := e.claimOwn("b"); len(got) != 0 {
		t.Fatalf("claimed %d traces after a clean assembly, want none", len(got))
	}
}

// An ingest of a new record runs while the trace is being assembled and
// commits after the mark started: the mark waits for it, sees the gen
// move, and leaves the trace pending.
func TestMarkAssembledAfterARacingIngestKeepsThePending(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	_, lt := e.claimOne("a", key)

	tx := e.beginIngest(e.batch(key, span(2, 1)))
	done := make(chan MarkResult, 1)
	go func() {
		res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled())
		if err != nil {
			t.Errorf("MarkAssembled: %v", err)
		}
		done <- res
	}()
	poll(t, "the mark to wait on the ingest's row lock", func() bool {
		return e.count(`
			SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'
			  AND query LIKE '%assembly_count = assembly_count + 1%'`) > 0
	})
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	res := <-done
	if res != (MarkResult{Marked: true, Pending: true}) {
		t.Fatalf("MarkAssembled = %+v, want marked and still pending", res)
	}
	if !e.assembledFlag(key, 1) || e.assembledFlag(key, 2) {
		t.Fatal("want the loaded record assembled and the racing one not")
	}

	// The next assembly takes only the racing record and clears pending.
	e.clock.Advance(RootGrace)
	got := e.claimOwn("a")
	if len(got) != 1 {
		t.Fatalf("claimed %d traces, want the pending one again", len(got))
	}
	lt, err := e.store.LoadTrace(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if keys := lt.Unassembled(); len(keys) != 1 || keys[0].SpanID != spanID(2) {
		t.Fatalf("Unassembled = %v, want only the racing record", keys)
	}
	if res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled()); err != nil || res.Pending {
		t.Fatalf("second MarkAssembled = %+v, %v; want not pending", res, err)
	}
	if tr := e.traceRow(key); tr.AssemblyCount != 2 {
		t.Fatalf("assembly_count=%d, want 2", tr.AssemblyCount)
	}
}

// An ingest that began before the snapshot was loaded commits after it:
// its record is not in the snapshot, so the mark leaves it unassembled,
// with its content staged, and the trace pending.
func TestMarkAssembledLeavesALateCommittingRecordUnassembled(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, captured(span(1, 0), `{"a":1}`)))
	e.clock.Advance(QuietTimeout + time.Second)
	if got := e.claimOwn("a"); len(got) != 1 {
		t.Fatalf("claimed %d traces, want 1", len(got))
	}

	tx := e.beginIngest(e.batch(key, captured(span(2, 1), `{"b":2}`)))
	lt, err := e.store.LoadTrace(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if len(lt.Facts) != 1 {
		t.Fatalf("snapshot holds %d records, want only the committed one", len(lt.Facts))
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled())
	if err != nil || res != (MarkResult{Marked: true, Pending: true, Capture: true}) {
		t.Fatalf("MarkAssembled = %+v, %v; want marked, still pending, capture on", res, err)
	}
	if !e.assembledFlag(key, 1) || e.assembledFlag(key, 2) {
		t.Fatal("want the snapshot's record assembled and the late one not")
	}
	if n := e.count(`SELECT count(*) FROM otlp_span_content WHERE token_key = $1 AND trace_id = $2 AND span_id = $3`,
		key.TokenKey, key.TraceID[:], idBytes(2)); n != 1 || e.contentRows(key) != 1 {
		t.Fatalf("content rows: late=%d total=%d, want only the late record's", n, e.contentRows(key))
	}
}

// Each assembly stamps the records it marks with its own number (the
// trace's assembly_count after it), LoadTrace returns it, and a record
// not yet assembled has none.
func TestMarkAssembledRecordsTheAssembly(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(2, 1)))
	_, lt := e.claimOne("a", key)
	if lt.Facts[0].AssembledIn != 0 {
		t.Fatalf("an unassembled record loads with assembled_in %d", lt.Facts[0].AssembledIn)
	}
	if res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonQuiet, lt.Unassembled()); err != nil || !res.Marked {
		t.Fatalf("first mark = %+v, %v", res, err)
	}

	// The late root arrives and is assembled second.
	e.stage(e.batch(key, span(1, 0)))
	_, lt = e.claimOne("b", key)
	in := map[byte]int{}
	for _, f := range lt.Facts {
		in[f.SpanID[7]] = f.AssembledIn
	}
	if in[2] != 1 || in[1] != 0 {
		t.Fatalf("before the second mark assembled_in = %v, want record 2 in assembly 1 and record 1 in none", in)
	}
	if res, err := e.store.MarkAssembled(ctx, "b", key, lt.Gen, ReasonComplete, lt.Unassembled()); err != nil || !res.Marked {
		t.Fatalf("second mark = %+v, %v", res, err)
	}
	lt, err := e.store.LoadTrace(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range lt.Facts {
		in[f.SpanID[7]] = f.AssembledIn
		if !f.Assembled {
			t.Fatalf("record %d not assembled", f.SpanID[7])
		}
	}
	if in[2] != 1 || in[1] != 2 {
		t.Fatalf("after two assemblies assembled_in = %v, want record 2 in 1 and record 1 in 2", in)
	}
	if tr := e.traceRow(key); tr.AssemblyCount != 2 {
		t.Fatalf("assembly_count = %d, want 2", tr.AssemblyCount)
	}
}

// A mark whose lease expired stamps nothing, and the check refuses a
// record marked assembled without its assembly or the reverse.
func TestAssembledInStaysWithTheFlag(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	_, lt := e.claimOne("a", key)
	e.clock.Advance(LeaseTTL + time.Second)
	if res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled()); err != nil || res.Marked {
		t.Fatalf("expired mark = %+v, %v; want nothing marked", res, err)
	}
	if n := e.count(`SELECT count(*) FROM otlp_spans WHERE token_key = $1 AND assembled_in IS NOT NULL`, key.TokenKey); n != 0 {
		t.Fatalf("an expired mark stamped %d records", n)
	}
	for _, sql := range []string{
		`UPDATE otlp_spans SET assembled = true WHERE token_key = $1 AND trace_id = $2`,
		`UPDATE otlp_spans SET assembled_in = 1 WHERE token_key = $1 AND trace_id = $2`,
		`UPDATE otlp_spans SET assembled = true, assembled_in = 0 WHERE token_key = $1 AND trace_id = $2`,
	} {
		_, err := e.pool.Exec(ctx, sql, key.TokenKey, key.TraceID[:])
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" || pgErr.ConstraintName != "otlp_spans_assembled_in_check" {
			t.Errorf("%s: err = %v, want the assembled_in check to refuse it", sql, err)
		}
	}
}

func TestLeaseRenewalAndExpiry(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	_, lt := e.claimOne("a", key)
	claimedAt := e.clock.Now()

	// A renewal pushes the expiry out from the renewal time.
	e.clock.Advance(LeaseTTL / 2)
	if lease, err := e.store.RenewLease(ctx, "a", key); err != nil || !lease.Held {
		t.Fatalf("RenewLease by the holder = %+v, %v", lease, err)
	}
	if lease, err := e.store.RenewLease(ctx, "b", key); err != nil || lease.Held {
		t.Fatalf("RenewLease by another owner = %+v, %v; want refused", lease, err)
	}
	if tr := e.traceRow(key); !tr.LeaseExpires.Equal(claimedAt.Add(LeaseTTL/2 + LeaseTTL)) {
		t.Fatalf("lease expires %v, want renewal time + TTL", tr.LeaseExpires)
	}

	// Past the original expiry the renewed lease still holds.
	e.clock.Advance(LeaseTTL/2 + time.Second)
	if got := e.claimOwn("b"); len(got) != 0 {
		t.Fatal("another replica claimed a renewed lease")
	}

	// Past the renewed expiry the lease is free, and the old holder can
	// neither renew nor mark.
	e.clock.Advance(LeaseTTL)
	if got := e.claimOwn("b"); len(got) != 1 {
		t.Fatalf("claimed %d traces after the lease expired, want 1", len(got))
	}
	if lease, err := e.store.RenewLease(ctx, "a", key); err != nil || lease.Held {
		t.Fatalf("RenewLease after losing the lease = %+v, %v; want refused", lease, err)
	}
	res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled())
	if err != nil || res.Marked {
		t.Fatalf("MarkAssembled after losing the lease = %+v, %v; want nothing marked", res, err)
	}
	if e.assembledFlag(key, 1) || e.traceRow(key).AssemblyCount != 0 {
		t.Fatal("a mark without the lease changed the trace")
	}
	if res, err := e.store.MarkAssembled(ctx, "b", key, lt.Gen, ReasonComplete, lt.Unassembled()); err != nil || !res.Marked {
		t.Fatalf("MarkAssembled by the new holder = %+v, %v", res, err)
	}
}

func TestDeferReleasesTheLease(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	_, lt := e.claimOne("a", key)
	later := e.clock.Now().Add(time.Second)

	if ok, err := e.store.Defer(ctx, "b", key, lt.Gen, later); err != nil || ok {
		t.Fatalf("Defer by another owner = %v, %v; want refused", ok, err)
	}
	if ok, err := e.store.Defer(ctx, "a", key, lt.Gen, later); err != nil || !ok {
		t.Fatalf("Defer by the holder = %v, %v", ok, err)
	}
	tr := e.traceRow(key)
	if !tr.ResolveAt.Equal(later) || !tr.LeaseExpires.IsZero() {
		t.Fatalf("after Defer resolve_at=%v lease=%v", tr.ResolveAt, tr.LeaseExpires)
	}
	if got := e.claimOwn("b"); len(got) != 0 {
		t.Fatal("a deferred trace was claimed before it was due again")
	}
	e.clock.Advance(time.Second)
	if got := e.claimOwn("b"); len(got) != 1 {
		t.Fatalf("claimed %d traces once the deferred one was due, want 1", len(got))
	}
}

// An expired lease is not a lease: even with no other claim on the
// trace, and the owner id unchanged, a stale assembly marks, renews and
// defers nothing.
func TestAnExpiredLeaseMarksRenewsAndDefersNothing(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	_, lt := e.claimOne("a", key)

	e.clock.Advance(LeaseTTL)
	if lease, err := e.store.RenewLease(ctx, "a", key); err != nil || !lease.Held {
		t.Fatalf("RenewLease at exactly the expiry = %+v, %v; want held", lease, err)
	}
	e.clock.Advance(LeaseTTL + time.Microsecond)
	before := e.traceRow(key)
	if lease, err := e.store.RenewLease(ctx, "a", key); err != nil || lease.Held {
		t.Fatalf("RenewLease of an expired lease = %+v, %v; want refused", lease, err)
	}
	if ok, err := e.store.Defer(ctx, "a", key, lt.Gen, e.clock.Now()); err != nil || ok {
		t.Fatalf("Defer of an expired lease = %v, %v; want refused", ok, err)
	}
	res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled())
	if err != nil || res.Marked {
		t.Fatalf("MarkAssembled of an expired lease = %+v, %v; want nothing marked", res, err)
	}
	after := e.traceRow(key)
	if e.assembledFlag(key, 1) || after.AssemblyCount != 0 || after.AssembledAt != nil ||
		!after.LeaseExpires.Equal(before.LeaseExpires) || !after.ResolveAt.Equal(before.ResolveAt) {
		t.Fatalf("an expired lease changed the trace: before %+v, after %+v", before, after)
	}
	// The trace is claimable again, and the new claim assembles it.
	got := e.claimOwn("a-2")
	if len(got) != 1 {
		t.Fatalf("claimed %d traces after the lease expired, want 1", len(got))
	}
	if res, err := e.store.MarkAssembled(ctx, "a-2", key, lt.Gen, ReasonComplete, lt.Unassembled()); err != nil || !res.Marked {
		t.Fatalf("MarkAssembled by the new claim = %+v, %v", res, err)
	}
}

func TestDeferNeverPassesTheMaxHold(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	_, lt := e.claimOne("a", key)

	if ok, err := e.store.Defer(ctx, "a", key, lt.Gen, testEpoch.Add(2*MaxTraceHold)); err != nil || !ok {
		t.Fatalf("Defer = %v, %v", ok, err)
	}
	if tr := e.traceRow(key); !tr.ResolveAt.Equal(testEpoch.Add(MaxTraceHold)) {
		t.Fatalf("resolve_at=%v, want the first record + max hold", tr.ResolveAt)
	}
}

// A record staged while the trace is claimed sets its timer; a deferral
// made on the older snapshot never moves that timer later.
func TestDeferKeepsTheTimerOfARecordStagedDuringTheClaim(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))
	_, lt := e.claimOne("a", key)

	e.stage(e.batch(key, span(2, 1)))
	staged := e.traceRow(key).ResolveAt
	if !staged.Equal(e.clock.Now().Add(RootGrace)) {
		t.Fatalf("the racing record set resolve_at=%v, want now + root grace", staged)
	}
	if ok, err := e.store.Defer(ctx, "a", key, lt.Gen, e.clock.Now().Add(AdkLogWait)); err != nil || !ok {
		t.Fatalf("Defer = %v, %v", ok, err)
	}
	if tr := e.traceRow(key); !tr.ResolveAt.Equal(staged) {
		t.Fatalf("resolve_at=%v after the deferral, want the racing record's %v", tr.ResolveAt, staged)
	}

	// With no record staged during the claim, the deferral stands, even
	// when it is later than the trace's last timer.
	_, lt = e.claimOne("a", key)
	want := e.clock.Now().Add(AdkLogWait)
	if ok, err := e.store.Defer(ctx, "a", key, lt.Gen, want); err != nil || !ok {
		t.Fatalf("Defer = %v, %v", ok, err)
	}
	if tr := e.traceRow(key); !tr.ResolveAt.Equal(want) {
		t.Fatalf("resolve_at=%v, want the deferral's %v", tr.ResolveAt, want)
	}
}

// A record without capture staged after the snapshot turns the trace
// off: the next lease renewal and the mark both say so, so the assembler
// drops the content it loaded.
func TestCaptureTurnedOffAfterTheSnapshotIsReported(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, captured(span(1, 0), `{"a":1}`)))
	_, lt := e.claimOne("a", key)
	if !lt.Capture || lt.Facts[0].Content == nil {
		t.Fatalf("snapshot capture=%v content=%s, want both", lt.Capture, lt.Facts[0].Content)
	}
	if lease, err := e.store.RenewLease(ctx, "a", key); err != nil || lease != (Lease{Held: true, Capture: true}) {
		t.Fatalf("RenewLease before the uncaptured record = %+v, %v", lease, err)
	}

	e.stage(e.batch(key, span(2, 1)))
	if lease, err := e.store.RenewLease(ctx, "a", key); err != nil || lease != (Lease{Held: true}) {
		t.Fatalf("RenewLease after the uncaptured record = %+v, %v; want held with capture off", lease, err)
	}
	res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, lt.Unassembled())
	if err != nil || res != (MarkResult{Marked: true, Pending: true}) {
		t.Fatalf("MarkAssembled = %+v, %v; want marked, pending, capture off", res, err)
	}
}

// A write that waited behind another for the trace's row lock dates the
// trace from when it could write, not from when it started.
func TestStageDatesTheTraceAfterTheRowLock(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0)))

	tx := e.beginIngest(e.batch(key, span(2, 1)))
	done := make(chan error, 1)
	go func() {
		_, err := e.store.Stage(ctx, []TraceBatch{e.batch(key, span(3, 1))})
		done <- err
	}()
	poll(t, "the second write to wait on the first's row lock", func() bool {
		return e.count(`
			SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'
			  AND query LIKE '%INSERT INTO otlp_traces%'`) > 0
	})
	e.clock.Advance(time.Second)
	writable := e.clock.Now()
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("waiting Stage: %v", err)
	}
	tr := e.traceRow(key)
	if !tr.LastReceivedAt.Equal(writable) || !tr.ResolveAt.Equal(writable.Add(RootGrace)) {
		t.Fatalf("last_received_at=%v resolve_at=%v, want %v and + root grace", tr.LastReceivedAt, tr.ResolveAt, writable)
	}
	var received time.Time
	if err := e.pool.QueryRow(ctx, `
		SELECT received_at FROM otlp_spans WHERE token_key = $1 AND trace_id = $2 AND span_id = $3`,
		key.TokenKey, key.TraceID[:], idBytes(3)).Scan(&received); err != nil {
		t.Fatal(err)
	}
	if !received.Equal(writable) {
		t.Fatalf("received_at=%v, want %v", received, writable)
	}
}

// A replica whose clock runs behind never moves last_received_at back.
func TestStageNeverMovesLastReceivedBack(t *testing.T) {
	e := newTestEnv(t)
	key := e.newKey()
	e.clock.Set(testEpoch.Add(10 * time.Second))
	e.stage(e.batch(key, span(1, 0)))
	e.clock.Set(testEpoch)
	e.stage(e.batch(key, span(2, 1)))
	if tr := e.traceRow(key); !tr.LastReceivedAt.Equal(testEpoch.Add(10*time.Second)) || tr.Gen != 2 {
		t.Fatalf("last_received_at=%v gen=%d, want the later time kept and gen 2", tr.LastReceivedAt, tr.Gen)
	}
}

// The retentions are the contract's values (ARCHITECTURE.md, OTLP ingest
// > GenAI dialect > Assembly), written out so a changed constant fails.
func TestSweepTracesKeepsEachRetention(t *testing.T) {
	const complete1h, degraded24h = time.Hour, 24 * time.Hour
	e := newTestEnv(t)
	ctx := context.Background()
	complete, degraded, repended, pending := e.newKey(), e.newKey(), e.newKey(), e.newKey()
	e.stage(e.batch(complete, span(1, 0)), e.batch(degraded, span(2, 1)),
		e.batch(repended, span(1, 0)), e.batch(pending, span(3, 1)))
	e.clock.Advance(QuietTimeout + time.Second)
	claimed := e.claimOwn("a")
	if len(claimed) != 4 {
		t.Fatalf("claimed %d traces, want 4", len(claimed))
	}
	for key, reason := range map[TraceKey]Reason{complete: ReasonComplete, degraded: ReasonQuiet, repended: ReasonComplete} {
		lt, err := e.store.LoadTrace(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, reason, lt.Unassembled()); err != nil {
			t.Fatal(err)
		}
	}
	// A late record makes an assembled trace pending again: it is
	// never swept while it waits, however old its last assembly.
	e.stage(e.batch(repended, span(4, 1)))
	exists := func(k TraceKey) bool {
		return e.count(`SELECT count(*) FROM otlp_traces WHERE token_key = $1 AND trace_id = $2`,
			k.TokenKey, k.TraceID[:]) == 1
	}
	sweep := func() {
		t.Helper()
		if _, err := e.store.SweepTraces(ctx); err != nil {
			t.Fatalf("SweepTraces: %v", err)
		}
	}

	e.clock.Advance(complete1h - time.Second)
	sweep()
	if !exists(complete) || !exists(degraded) || !exists(repended) || !exists(pending) {
		t.Fatal("a trace was swept before its retention")
	}
	e.clock.Advance(2 * time.Second)
	sweep()
	if exists(complete) || !exists(degraded) || !exists(repended) || !exists(pending) {
		t.Fatal("past the complete retention want only the complete trace swept")
	}
	if e.spanRows(complete) != 0 {
		t.Fatal("the swept trace's records were not removed with it")
	}
	e.clock.Advance(degraded24h - complete1h - 2*time.Second)
	sweep()
	if !exists(degraded) {
		t.Fatal("the degraded trace was swept before its retention")
	}
	e.clock.Advance(2 * time.Second)
	sweep()
	if exists(degraded) || !exists(repended) || !exists(pending) {
		t.Fatal("past the degraded retention want the degraded trace swept and the pending ones kept")
	}
}

func TestSweepContentIsTheBackstop(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, captured(span(1, 0), `{"a":1}`)))
	e.clock.Advance(time.Minute)
	e.stage(e.batch(key, captured(span(2, 1), `{"b":2}`)))

	// The contract's backstop age: more than 24 hours and 30 seconds.
	e.clock.Advance(24*time.Hour + 30*time.Second - time.Minute)
	if _, err := e.store.SweepContent(ctx); err != nil {
		t.Fatal(err)
	}
	if e.contentRows(key) != 2 {
		t.Fatalf("%d content rows at exactly the backstop age, want both kept", e.contentRows(key))
	}
	e.clock.Advance(time.Second)
	if _, err := e.store.SweepContent(ctx); err != nil {
		t.Fatal(err)
	}
	if e.contentRows(key) != 1 {
		t.Fatalf("%d content rows, want only the newer one kept", e.contentRows(key))
	}
	e.clock.Advance(time.Minute)
	if _, err := e.store.SweepContent(ctx); err != nil {
		t.Fatal(err)
	}
	if e.contentRows(key) != 0 || e.spanRows(key) != 2 {
		t.Fatalf("content=%d records=%d, want the content gone and the records kept", e.contentRows(key), e.spanRows(key))
	}
}

// schemaSnapshot lists the public schema's tables, columns, indexes and
// constraints, one line each, sorted.
func schemaSnapshot(t *testing.T, tx pgx.Tx) []string {
	t.Helper()
	rows, err := tx.Query(context.Background(), `
		SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
		       || ' default=' || COALESCE(column_default, '')
		FROM information_schema.columns WHERE table_schema = 'public'
		UNION ALL
		SELECT 'index ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
		UNION ALL
		SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
		FROM pg_constraint WHERE connamespace = 'public'::regnamespace
		UNION ALL
		SELECT 'relation ' || relname || ' ' || relkind::text FROM pg_class WHERE relnamespace = 'public'::regnamespace
		ORDER BY 1`)
	if err != nil {
		t.Fatalf("snapshot schema: %v", err)
	}
	lines, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatalf("snapshot schema: %v", err)
	}
	return lines
}

// The staging migrations, by number.
const (
	migrationStaging     = "000035_otlp_genai_staging"
	migrationAssembledIn = "000036_otlp_spans_assembled_in"
)

func migrationFile(t *testing.T, name, direction string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "docker", "postgres", "migrations",
		name+"."+direction+".sql"))
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	return string(b)
}

// Each down file removes exactly what its up file adds, newest first, and
// the up files run again restore the schema. All of it runs inside a
// transaction that is rolled back, so the database is left as it was.
func TestDownMigrationRestoresTheSchema(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	without := func(lines []string, marker string) []string {
		var out []string
		for _, line := range lines {
			if !strings.Contains(line, marker) {
				out = append(out, line)
			}
		}
		return out
	}
	migrated := schemaSnapshot(t, tx)
	if _, err := tx.Exec(ctx, migrationFile(t, migrationAssembledIn, "down")); err != nil {
		t.Fatalf("down 000036: %v", err)
	}
	down36 := schemaSnapshot(t, tx)
	if want := without(migrated, "assembled_in"); !slices.Equal(down36, want) {
		t.Fatalf("the 000036 down migration changed more than assembled_in:\nafter down: %v\nwant: %v", down36, want)
	}
	if len(down36) == len(migrated) {
		t.Fatal("the 000036 down migration removed nothing")
	}
	if _, err := tx.Exec(ctx, migrationFile(t, migrationStaging, "down")); err != nil {
		t.Fatalf("down 000035: %v", err)
	}
	down35 := schemaSnapshot(t, tx)
	if want := without(down36, "otlp_"); !slices.Equal(down35, want) {
		t.Fatalf("the 000035 down migration changed more than the staging tables:\nafter down: %v\nwant: %v", down35, want)
	}
	if len(down35) == len(down36) {
		t.Fatal("the 000035 down migration removed nothing")
	}
	if _, err := tx.Exec(ctx, migrationFile(t, migrationStaging, "up")); err != nil {
		t.Fatalf("up 000035: %v", err)
	}
	if again := schemaSnapshot(t, tx); !slices.Equal(again, down36) {
		t.Fatalf("up 000035 after down did not restore its schema:\ngot: %v\nwant: %v", again, down36)
	}
	if _, err := tx.Exec(ctx, migrationFile(t, migrationAssembledIn, "up")); err != nil {
		t.Fatalf("up 000036: %v", err)
	}
	if again := schemaSnapshot(t, tx); !slices.Equal(again, migrated) {
		t.Fatalf("up after down did not restore the schema:\ngot: %v\nwant: %v", again, migrated)
	}
}

// 000036 gives a record marked before it its trace's assembly_count,
// so the check it adds holds for every row. It runs inside a rolled-back
// transaction, against rows of this test's own token only.
func TestAssembledInMigrationBackfillsMarkedRecords(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	key := e.newKey()
	e.stage(e.batch(key, span(1, 0), span(2, 1)))
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, migrationFile(t, migrationAssembledIn, "down")); err != nil {
		t.Fatalf("down 000036: %v", err)
	}
	// As a store before 000036 marked: the flag only, and the count.
	if _, err := tx.Exec(ctx, `UPDATE otlp_traces SET assembly_count = 3 WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE otlp_spans SET assembled = true WHERE token_key = $1 AND trace_id = $2 AND span_id = $3`,
		key.TokenKey, key.TraceID[:], idBytes(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, migrationFile(t, migrationAssembledIn, "up")); err != nil {
		t.Fatalf("up 000036 over a marked record: %v", err)
	}
	rows, err := tx.Query(ctx, `SELECT span_id, assembled_in FROM otlp_spans WHERE token_key = $1 AND trace_id = $2 ORDER BY span_id`,
		key.TokenKey, key.TraceID[:])
	if err != nil {
		t.Fatal(err)
	}
	got := map[byte]*int32{}
	for rows.Next() {
		var id []byte
		var in *int32
		if err := rows.Scan(&id, &in); err != nil {
			t.Fatal(err)
		}
		got[id[7]] = in
	}
	rows.Close()
	if got[1] == nil || *got[1] != 3 || got[2] != nil {
		t.Fatalf("after 000036: marked record assembled_in=%v, unmarked=%v; want 3 and NULL", got[1], got[2])
	}
}
