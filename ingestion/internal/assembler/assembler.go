// Package assembler runs the OTLP GenAI assembler: in every ingestion
// process it claims due traces from the staging store under a lease,
// decides whether each is complete, maps it with genai.Resolve and
// publishes the events through the receiver's publish path in chunks,
// renewing the lease before every chunk, then marks what it loaded. It
// also runs the staging store's two sweeps. All state is in Postgres:
// a process that stops, or loses its lease, leaves the trace for the
// next claim, which publishes the same deterministic event ids.
// ARCHITECTURE.md (OTLP ingest > GenAI dialect > Assembly) is the
// contract.
package assembler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync/atomic"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
)

// Schedules and bounds. ARCHITECTURE.md (OTLP ingest > GenAI dialect)
// states each value; the justification is beside it.
const (
	// ClaimInterval is how often an assembler claims due traces. A
	// trace is due 3 seconds after its root (RootGrace), so a claim a
	// second keeps the delay to the dashboard within a second of that;
	// with nothing staged a claim is one probe of the partial index of
	// pending traces, which is empty, so an idle replica costs one
	// sub-millisecond query a second.
	ClaimInterval = time.Second

	// ChunkSize is the most events published between two lease
	// renewals, so a trace of up to 20,000 events renews its lease at
	// least 40 times. Renewal does not rest on a chunk being fast: a
	// chunk is published in slices of PublishSlice, and the lease is
	// renewed again after any slice that ends renewEvery or more after
	// the last renewal.
	ChunkSize = 500

	// PublishSlice is how many events are published between two checks
	// of the time since the last renewal. One slice is what can pass
	// between a lease falling due for renewal and being renewed: 50
	// publishes take a few milliseconds on a healthy bus, and even a bus
	// slowed to a second a publish leaves the lease (LeaseTTL, two
	// minutes) more than a minute to spare.
	PublishSlice = 50

	// renewEvery is how long a lease may go without renewal while its
	// trace publishes: a quarter of its TTL, so a renewal that is due is
	// made with three quarters of the lease still left.
	renewEvery = otlpstage.LeaseTTL / 4

	// RetryDelayMin is how soon a trace whose load or publish failed is
	// due again after its first failure: the next claim but one, so a
	// brief bus or database hiccup is retried promptly.
	RetryDelayMin = time.Second

	// RetryDelayMax caps the retry delay, which doubles with each
	// consecutive failure of the same trace in this process. A trace that
	// cannot be published (the bus is down for long) is retried, and
	// warned about, at most twice a minute rather than every second until
	// its max hold, and is still published within half a minute of the
	// outage ending.
	RetryDelayMax = 30 * time.Second

	// maxTrackedFailures bounds the traces whose consecutive failures
	// this process counts for the retry delay. An outage fails every
	// pending trace, so without a bound the count would grow with the
	// backlog; a trace past the bound is retried after RetryDelayMax.
	maxTrackedFailures = 10000

	// batchRenewEvery is how often the leases of a claim's traces not yet
	// started are renewed while earlier ones of the same claim assemble:
	// at trace boundaries and after publish slices, once a quarter of the
	// lease's TTL has passed since the last renewal, so a waiting lease
	// is renewed on the same schedule as the one being published. Sizing
	// the claim to fit the TTL could not promise that, since one trace of
	// 20,000 events may itself take longer than two minutes.
	batchRenewEvery = otlpstage.LeaseTTL / 4

	// SweepContentInterval is how often the staged-content backstop
	// sweep runs. The backstop age is a day, so a minute of slack is
	// noise; frequent runs keep each one's batch small.
	SweepContentInterval = time.Minute

	// SweepTracesInterval is how often expired traces are deleted. The
	// shorter retention is an hour, so ten minutes keeps the table
	// within a sixth of an hour of its bound.
	SweepTracesInterval = 10 * time.Minute

	// releaseTimeout bounds the release (or mark) an assembly makes after
	// its run context was cancelled: shutdown must not wait on a stuck
	// database, and a lease that is not released lapses after LeaseTTL.
	releaseTimeout = 5 * time.Second
)

// Store is the staging store the assembler reads and marks.
type Store interface {
	ClaimDue(ctx context.Context, owner string) ([]otlpstage.Trace, error)
	LoadTrace(ctx context.Context, key otlpstage.TraceKey) (otlpstage.LoadedTrace, error)
	RenewLease(ctx context.Context, owner string, key otlpstage.TraceKey) (otlpstage.Lease, error)
	Defer(ctx context.Context, owner string, key otlpstage.TraceKey, gen int64, resolveAt time.Time) (bool, error)
	MarkAssembled(ctx context.Context, owner string, key otlpstage.TraceKey, gen int64, reason otlpstage.Reason, keys []otlpstage.FactKey) (otlpstage.MarkResult, error)
	SweepTraces(ctx context.Context) (int64, error)
	SweepContent(ctx context.Context) (int64, error)
}

// Publisher is the receiver's publish path.
type Publisher interface {
	Encode(payload map[string]any, now time.Time) ([]byte, string)
	OldestValid(now time.Time) time.Time
	Publish(ctx context.Context, token auth.ValidationResult, events []handlers.OTLPEvent) (int, error)
}

// Assembler assembles due traces. Create it with New and run it with
// Run; Tick and Sweep run one round each, for tests.
type Assembler struct {
	store     Store
	publisher Publisher
	now       func() time.Time
	interval  time.Duration
	chunkSize int
	slice     int
	// ownerBase names this process; each claim appends a counter, so
	// owner ids are unique per claim, never reused across claims.
	ownerBase string
	claims    atomic.Uint64
	// failures counts each trace's consecutive load or publish failures
	// in this process, for the retry delay. Tick runs on one goroutine at
	// a time (Run's), so it needs no lock.
	failures map[otlpstage.TraceKey]int
}

// Option configures an Assembler.
type Option func(*Assembler)

// WithClock replaces the assembler's clock; tests move it without
// waiting. The store has a clock of its own and must be given the same.
func WithClock(now func() time.Time) Option { return func(a *Assembler) { a.now = now } }

// WithInterval replaces ClaimInterval.
func WithInterval(d time.Duration) Option {
	return func(a *Assembler) {
		if d > 0 {
			a.interval = d
		}
	}
}

// WithChunkSize replaces ChunkSize; tests use small chunks.
func WithChunkSize(n int) Option {
	return func(a *Assembler) {
		if n > 0 {
			a.chunkSize = n
		}
	}
}

// WithPublishSlice replaces PublishSlice; tests use small slices.
func WithPublishSlice(n int) Option {
	return func(a *Assembler) {
		if n > 0 {
			a.slice = n
		}
	}
}

// New returns an assembler over store and publisher.
func New(store Store, publisher Publisher, opts ...Option) *Assembler {
	a := &Assembler{
		store: store, publisher: publisher, now: time.Now,
		interval: ClaimInterval, chunkSize: ChunkSize, slice: PublishSlice,
		ownerBase: processName(),
		failures:  map[otlpstage.TraceKey]int{},
	}
	for _, opt := range opts {
		opt(a)
	}
	return a
}

// processName is this process's part of every owner id: host, pid and
// a random nonce, since every container's process is pid 1 and a
// restarted one reuses its host name.
func processName() string {
	host, _ := os.Hostname()
	nonce := make([]byte, 4)
	_, _ = rand.Read(nonce)
	return fmt.Sprintf("%s/%d/%s", host, os.Getpid(), hex.EncodeToString(nonce))
}

func (a *Assembler) nextOwner() string {
	return fmt.Sprintf("%s/%d", a.ownerBase, a.claims.Add(1))
}

// Run claims and assembles due traces every interval, and runs the
// sweeps on their schedules, until ctx is cancelled. It then stops
// claiming, lets the assembly in progress finish the chunk it is
// publishing and release its lease, and returns.
func (a *Assembler) Run(ctx context.Context) {
	claim := time.NewTicker(a.interval)
	defer claim.Stop()
	content := time.NewTicker(SweepContentInterval)
	defer content.Stop()
	traces := time.NewTicker(SweepTracesInterval)
	defer traces.Stop()
	slog.Info("genai assembler running", "owner", a.ownerBase, "interval", a.interval.String())
	for {
		select {
		case <-ctx.Done():
			slog.Info("genai assembler stopped", "owner", a.ownerBase)
			return
		case <-claim.C:
			a.Tick(ctx)
		case <-content.C:
			a.sweepContent(ctx)
		case <-traces.C:
			a.sweepTraces(ctx)
		}
	}
}

// Sweep runs both sweeps once.
func (a *Assembler) Sweep(ctx context.Context) {
	a.sweepContent(ctx)
	a.sweepTraces(ctx)
}

func (a *Assembler) sweepContent(ctx context.Context) {
	if n, err := a.store.SweepContent(ctx); err != nil {
		if ctx.Err() == nil {
			slog.Warn("genai content sweep failed", "err", err)
		}
	} else if n > 0 {
		slog.Info("genai content sweep", "deleted", n)
	}
}

func (a *Assembler) sweepTraces(ctx context.Context) {
	if n, err := a.store.SweepTraces(ctx); err != nil {
		if ctx.Err() == nil {
			slog.Warn("genai trace sweep failed", "err", err)
		}
	} else if n > 0 {
		slog.Info("genai trace sweep", "deleted", n)
	}
}

// Tick claims due traces once and assembles each, and returns what each
// assembly did, in claim order. It stops after the trace in progress once
// ctx is done, releasing the rest of the claim. Tick is not safe for
// concurrent use; Run calls it from one goroutine.
func (a *Assembler) Tick(ctx context.Context) []Outcome {
	owner := a.nextOwner()
	claimed, err := a.store.ClaimDue(ctx, owner)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("genai claim failed", "err", err)
		}
		return nil
	}
	b := &batch{a: a, owner: owner, renewedAt: a.now(), lost: map[otlpstage.TraceKey]bool{}, gens: map[otlpstage.TraceKey]int64{}}
	for _, tr := range claimed {
		b.waiting = append(b.waiting, tr.Key)
		b.gens[tr.Key] = tr.Gen
	}
	outcomes := make([]Outcome, 0, len(claimed))
	for _, tr := range claimed {
		b.start(tr.Key)
		if ctx.Err() != nil {
			// Shutting down: release the rest of the claim at once,
			// so another process takes it without waiting for the
			// lease to lapse.
			a.release(ctx, owner, tr.Key, tr.Gen, a.now())
			outcomes = append(outcomes, Outcome{Key: tr.Key, Deferred: true})
			continue
		}
		b.keepAlive(ctx)
		if b.lost[tr.Key] {
			// Its lease was not renewed while it waited (another claim
			// holds it, or it lapsed): the next claim assembles it.
			delete(a.failures, tr.Key)
			outcomes = append(outcomes, Outcome{Key: tr.Key, LeaseLost: true})
			continue
		}
		out := a.assemble(ctx, b, tr)
		out.Key = tr.Key
		outcomes = append(outcomes, out)
	}
	return outcomes
}

// batch is one claim's traces: the owner they are leased to, and the
// ones still waiting their turn, whose leases are kept alive while
// earlier ones assemble.
type batch struct {
	a         *Assembler
	owner     string
	waiting   []otlpstage.TraceKey
	renewedAt time.Time
	lost      map[otlpstage.TraceKey]bool
	gens      map[otlpstage.TraceKey]int64 // each trace's gen at the claim
}

// start takes key off the waiting list: its own assembly renews it now.
func (b *batch) start(key otlpstage.TraceKey) {
	for i, k := range b.waiting {
		if k == key {
			b.waiting = append(b.waiting[:i], b.waiting[i+1:]...)
			return
		}
	}
}

// keepAlive renews the waiting traces' leases once batchRenewEvery has
// passed since the last renewal. A lease that is no longer held is
// marked lost, and its trace is left for the next claim. A renewal that
// errors may have left the lease held, so the trace is released, due
// now on a context of its own, before it is marked lost; a lease that
// was really lost matches no row.
func (b *batch) keepAlive(ctx context.Context) {
	now := b.a.now()
	if len(b.waiting) == 0 || now.Sub(b.renewedAt) < batchRenewEvery {
		return
	}
	b.renewedAt = now
	for _, key := range b.waiting {
		if b.lost[key] {
			continue
		}
		lease, err := b.a.store.RenewLease(ctx, b.owner, key)
		if err != nil {
			b.a.release(ctx, b.owner, key, b.gens[key], now)
		}
		if err != nil || !lease.Held {
			b.lost[key] = true
		}
	}
}

// Outcome is what one assembly did, for its log line and for tests.
type Outcome struct {
	Key       otlpstage.TraceKey
	Reason    otlpstage.Reason
	Deferred  bool // not complete yet, or released after a failure
	Published int
	Refused   int
	Chunks    int
	// Renewals counts the lease renewals made inside a chunk, after a
	// slice that ended renewEvery or more after the last renewal.
	Renewals  int
	LeaseLost bool
	Marked    bool
}

// assemble assembles one claimed trace of batch b.
func (a *Assembler) assemble(ctx context.Context, b *batch, tr otlpstage.Trace) Outcome {
	var out Outcome
	owner := b.owner
	lt, err := a.store.LoadTrace(ctx, tr.Key)
	if errors.Is(err, otlpstage.ErrTraceNotFound) {
		delete(a.failures, tr.Key)
		return out // swept since the claim
	}
	if err != nil {
		retry := a.retryDelay(tr.Key)
		slog.Warn("genai trace load failed", "trace", hex.EncodeToString(tr.Key.TraceID[:]),
			"retry_in", retry.String(), "err", err)
		a.release(ctx, owner, tr.Key, tr.Gen, a.now().Add(retry))
		out.Deferred = true
		return out
	}
	now := a.now()
	reason, ready, wait := Completeness(tr, lt, now)
	if !ready {
		// The claim's gen, not the snapshot's: a record staged between
		// the claim and the load moved the trace's timer, and Defer keeps
		// that time when it is the earlier one only if it sees the gen
		// moved from the one the claim read.
		a.release(ctx, owner, tr.Key, tr.Gen, wait)
		delete(a.failures, tr.Key)
		out.Deferred = true
		return out
	}
	out.Reason = reason

	in := genai.Input{Trace: tr, Facts: lt.Facts, Reason: reason, ValidFrom: a.publisher.OldestValid(now)}
	in.Trace.Capture = lt.Capture
	events := genai.Resolve(in)
	token := auth.ValidationResult{Valid: true, ID: tr.Key.TokenKey, Name: tr.TokenName}
	capture := lt.Capture

	// stop ends the assembly without a mark: nothing half-published is
	// marked, and the next claim publishes the same ids again.
	stop := func() Outcome {
		a.logAssembly(tr, lt, out, len(events))
		return out
	}
	var renewedAt time.Time
	for start := 0; start < len(events); {
		if ctx.Err() != nil {
			// Shutting down: the slice in flight was finished; the
			// lease is released so another process takes the trace now.
			a.release(ctx, owner, tr.Key, lt.Gen, a.now())
			out.Deferred = true
			return stop()
		}
		boundary := start%a.chunkSize == 0
		if boundary || a.now().Sub(renewedAt) >= renewEvery {
			b.keepAlive(ctx)
			lease, err := a.store.RenewLease(ctx, owner, tr.Key)
			if err != nil {
				// The lease may still be held (the renewal failed, or the
				// run context was cancelled under it): release it now, so
				// another process need not wait for it to lapse. A lease
				// that was really lost matches no row, and nothing happens.
				slog.Warn("genai lease renewal failed; releasing", "trace", hex.EncodeToString(tr.Key.TraceID[:]), "err", err)
				a.release(ctx, owner, tr.Key, lt.Gen, a.now())
				out.Deferred = true
				return stop()
			}
			if !lease.Held {
				slog.Warn("genai lease expired mid-assembly; the next claim publishes the trace again",
					"trace", hex.EncodeToString(tr.Key.TraceID[:]), "published", out.Published)
				out.LeaseLost = true
				delete(a.failures, tr.Key)
				return stop()
			}
			renewedAt = a.now()
			if boundary {
				out.Chunks++
			} else {
				out.Renewals++
			}
			if capture && !lease.Capture {
				// A record without capture turned the trace off: the rest
				// is mapped again without it, which changes no event's
				// place or id, only what capture governs.
				capture = false
				in.Trace.Capture = false
				events = withoutCapture(events, genai.Resolve(in))
			}
		}
		chunkEnd := (start/a.chunkSize + 1) * a.chunkSize
		end := min(start+a.slice, chunkEnd, len(events))
		slice, refused := a.encode(events[start:end], a.now(), capture)
		out.Refused += refused
		published, err := a.publisher.Publish(context.WithoutCancel(ctx), token, slice)
		out.Published += published
		if err != nil {
			retry := a.retryDelay(tr.Key)
			slog.Warn("genai publish failed; retrying", "trace", hex.EncodeToString(tr.Key.TraceID[:]),
				"published", out.Published, "retry_in", retry.String(), "err", err)
			a.release(ctx, owner, tr.Key, lt.Gen, a.now().Add(retry))
			out.Deferred = true
			return stop()
		}
		start = end
	}

	markCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), releaseTimeout)
	defer cancel()
	res, err := a.store.MarkAssembled(markCtx, owner, tr.Key, lt.Gen, reason, lt.Unassembled())
	switch {
	case err != nil:
		slog.Warn("genai mark failed; the next claim publishes the trace again",
			"trace", hex.EncodeToString(tr.Key.TraceID[:]), "err", err)
	case !res.Marked:
		slog.Warn("genai lease expired before the mark; the next claim publishes the trace again",
			"trace", hex.EncodeToString(tr.Key.TraceID[:]))
		out.LeaseLost = true
		delete(a.failures, tr.Key)
	default:
		out.Marked = true
		delete(a.failures, tr.Key)
	}
	a.logAssembly(tr, lt, out, len(events))
	return out
}

// retryDelay counts one more consecutive failure of the trace and
// returns how long to wait before retrying it: RetryDelayMin, doubling
// with each failure up to RetryDelayMax. A trace past maxTrackedFailures
// is not counted and waits RetryDelayMax.
func (a *Assembler) retryDelay(key otlpstage.TraceKey) time.Duration {
	n, tracked := a.failures[key]
	if !tracked && len(a.failures) >= maxTrackedFailures {
		return RetryDelayMax
	}
	a.failures[key] = n + 1
	delay := RetryDelayMin
	for range n {
		delay *= 2
		if delay >= RetryDelayMax {
			return RetryDelayMax
		}
	}
	return delay
}

// withoutCapture is the events of a mapping without capture, in place of
// the ones mapped with it. The two mappings hold the same events in the
// same order (capture changes only payload fields), which is checked:
// if they ever differ, the capture-on events are kept with their
// content stripped.
func withoutCapture(with, without []genai.Event) []genai.Event {
	if len(with) != len(without) {
		return stripAll(with)
	}
	for i := range with {
		if with[i].Payload["id"] != without[i].Payload["id"] {
			return stripAll(with)
		}
	}
	return without
}

func stripAll(events []genai.Event) []genai.Event {
	out := make([]genai.Event, len(events))
	for i, ev := range events {
		p := make(map[string]any, len(ev.Payload))
		for k, v := range ev.Payload {
			p[k] = v
		}
		stripContent(p)
		if ev.EventType == "session_start" {
			p["capture_prompts"] = false
		}
		out[i] = genai.Event{EventType: ev.EventType, SessionID: ev.SessionID, Attach: ev.Attach, Payload: p}
	}
	return out
}

// stripContent removes an event's content.
func stripContent(p map[string]any) {
	delete(p, "content")
	p["has_content"] = false
}

// encode validates and encodes a chunk's events; an event validation
// refuses is logged with its reason and left out, and the rest of the
// trace is published. With capture off no content is published, whatever
// an event holds.
func (a *Assembler) encode(events []genai.Event, now time.Time, capture bool) ([]handlers.OTLPEvent, int) {
	out := make([]handlers.OTLPEvent, 0, len(events))
	refused := 0
	for _, ev := range events {
		if !capture {
			stripContent(ev.Payload)
		}
		body, msg := a.publisher.Encode(ev.Payload, now)
		if msg != "" {
			refused++
			slog.Warn("genai event refused", "event_type", ev.EventType, "id", ev.Payload["id"], "reason", msg)
			continue
		}
		out = append(out, handlers.OTLPEvent{
			EventType:  ev.EventType,
			SessionID:  ev.SessionID,
			Payload:    body,
			SkipAttach: ev.EventType == "session_start" && !ev.Attach,
		})
	}
	return out, refused
}

// release releases owner's lease, due again at resolveAt (see
// otlpstage.Store.Defer), with gen the gen the decision was made on. It
// runs on a context of its own, so it still releases while the run
// context is being cancelled; a release that fails leaves the lease to
// lapse.
func (a *Assembler) release(ctx context.Context, owner string, key otlpstage.TraceKey, gen int64, resolveAt time.Time) {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), releaseTimeout)
	defer cancel()
	if _, err := a.store.Defer(rctx, owner, key, gen, resolveAt); err != nil {
		slog.Warn("genai lease release failed; it lapses", "trace", hex.EncodeToString(key.TraceID[:]), "err", err)
	}
}

func (a *Assembler) logAssembly(tr otlpstage.Trace, lt otlpstage.LoadedTrace, out Outcome, events int) {
	slog.Info("genai trace assembled",
		"trace", hex.EncodeToString(tr.Key.TraceID[:]),
		"reason", string(out.Reason),
		"records", len(lt.Facts),
		"events", events,
		"published", out.Published,
		"refused", out.Refused,
		"chunks", out.Chunks,
		"renewals_mid_chunk", out.Renewals,
		"lag_ms", a.now().Sub(tr.LastReceivedAt).Milliseconds(),
		"marked", out.Marked,
		"lease_lost", out.LeaseLost,
		"deferred", out.Deferred,
	)
}

// Completeness decides whether a claimed trace is ready at now, and
// why: complete (its root seen and RootGrace passed since its latest
// record, and for Google ADK every generate_content span with its log
// record), adk_log_timeout (an ADK trace AdkLogWait after its root),
// quiet (no root, QuietTimeout after its latest record) or max_hold
// (MaxTraceHold after its first record). When it is not ready, wait is
// when it is next due: a trace claimed before its own timer (a retry
// made it due early) waits for that timer, and an ADK trace missing log
// records for AdkLogWait after its root, a staged record making it due
// sooner.
func Completeness(tr otlpstage.Trace, lt otlpstage.LoadedTrace, now time.Time) (reason otlpstage.Reason, ready bool, wait time.Time) {
	hold := tr.FirstReceivedAt.Add(otlpstage.MaxTraceHold)
	held := !now.Before(hold)
	if tr.RootSeenAt == nil {
		quietAt := tr.LastReceivedAt.Add(otlpstage.QuietTimeout)
		switch {
		case held:
			return otlpstage.ReasonMaxHold, true, time.Time{}
		case !now.Before(quietAt):
			return otlpstage.ReasonQuiet, true, time.Time{}
		}
		return "", false, quietAt
	}
	if graceAt := tr.LastReceivedAt.Add(otlpstage.RootGrace); now.Before(graceAt) && !held {
		return "", false, graceAt
	}
	if tr.Source != genai.LabelGoogleADK || adkLogsComplete(lt) {
		return otlpstage.ReasonComplete, true, time.Time{}
	}
	logWaitAt := tr.RootSeenAt.Add(otlpstage.AdkLogWait)
	switch {
	case !now.Before(logWaitAt):
		return otlpstage.ReasonADKLogTimeout, true, time.Time{}
	case held:
		return otlpstage.ReasonMaxHold, true, time.Time{}
	}
	return "", false, logWaitAt
}

// adkLogsComplete reports whether every Google ADK generate_content span
// of the trace has its log record.
func adkLogsComplete(lt otlpstage.LoadedTrace) bool {
	logs := map[[8]byte]bool{}
	for _, f := range lt.Facts {
		if f.Kind == otlpstage.KindLog {
			logs[f.SpanID] = true
		}
	}
	for _, f := range lt.Facts {
		if f.Kind == otlpstage.KindSpan && f.Op == genai.OpGenerateContent && !logs[f.SpanID] {
			return false
		}
	}
	return true
}
