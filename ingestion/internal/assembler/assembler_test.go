package assembler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---- pure tests ----

func TestCompleteness(t *testing.T) {
	first := time.Date(2004, 1, 1, 0, 0, 0, 0, time.UTC)
	root := first.Add(time.Second)
	last := first.Add(2 * time.Second)
	adkFacts := func(withLog bool) otlpstage.LoadedTrace {
		lt := otlpstage.LoadedTrace{Facts: []otlpstage.StagedFact{
			{Fact: otlpstage.Fact{SpanID: [8]byte{1}, Kind: otlpstage.KindSpan, Op: genai.OpGenerateContent}},
		}}
		if withLog {
			lt.Facts = append(lt.Facts, otlpstage.StagedFact{Fact: otlpstage.Fact{SpanID: [8]byte{1}, Kind: otlpstage.KindLog}})
		}
		return lt
	}
	cases := []struct {
		name   string
		source string
		root   bool
		lt     otlpstage.LoadedTrace
		now    time.Time
		reason otlpstage.Reason
		wait   time.Time // zero when ready
	}{
		{"no root, before quiet", "pydantic_ai", false, otlpstage.LoadedTrace{}, last.Add(time.Minute), "", last.Add(otlpstage.QuietTimeout)},
		{"no root, quiet", "pydantic_ai", false, otlpstage.LoadedTrace{}, last.Add(otlpstage.QuietTimeout), otlpstage.ReasonQuiet, time.Time{}},
		{"no root, max hold", "pydantic_ai", false, otlpstage.LoadedTrace{}, first.Add(otlpstage.MaxTraceHold), otlpstage.ReasonMaxHold, time.Time{}},
		{"root, inside the grace", "pydantic_ai", true, otlpstage.LoadedTrace{}, last.Add(time.Second), "", last.Add(otlpstage.RootGrace)},
		{"root, complete", "pydantic_ai", true, otlpstage.LoadedTrace{}, last.Add(otlpstage.RootGrace), otlpstage.ReasonComplete, time.Time{}},
		{"ADK with every log record", "google_adk", true, adkFacts(true), last.Add(otlpstage.RootGrace), otlpstage.ReasonComplete, time.Time{}},
		{"ADK missing a log record waits for it", "google_adk", true, adkFacts(false), last.Add(otlpstage.RootGrace), "", root.Add(otlpstage.AdkLogWait)},
		{"ADK log timeout", "google_adk", true, adkFacts(false), root.Add(otlpstage.AdkLogWait), otlpstage.ReasonADKLogTimeout, time.Time{}},
		{"a non-ADK trace ignores log records", "strands", true, adkFacts(false), last.Add(otlpstage.RootGrace), otlpstage.ReasonComplete, time.Time{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tr := otlpstage.Trace{Source: tc.source, FirstReceivedAt: first, LastReceivedAt: last}
			if tc.root {
				r := root
				tr.RootSeenAt = &r
			}
			reason, ready, wait := Completeness(tr, tc.lt, tc.now)
			if ready != tc.wait.IsZero() || reason != tc.reason || !wait.Equal(tc.wait) {
				t.Errorf("Completeness = %q ready=%v wait=%v; want %q wait=%v", reason, ready, wait, tc.reason, tc.wait)
			}
		})
	}
}

func TestOwnerIDsAreUniquePerClaim(t *testing.T) {
	a, b := New(nil, nil), New(nil, nil)
	seen := map[string]bool{}
	for _, as := range []*Assembler{a, b} {
		for range 3 {
			o := as.nextOwner()
			if seen[o] {
				t.Fatalf("owner %s reused", o)
			}
			seen[o] = true
		}
	}
	if !strings.Contains(a.ownerBase, "/") || a.ownerBase == b.ownerBase {
		t.Errorf("process names %q and %q", a.ownerBase, b.ownerBase)
	}
}

// With capture off no content is published, whatever an event holds;
// with it on, the content goes through. The mapping carries no content
// yet, so content is put on a mapped event here.
func TestEncodeDropsContentWithCaptureOff(t *testing.T) {
	now := time.Date(2004, 1, 1, 0, 0, 10, 0, time.UTC)
	meta, _ := json.Marshal(map[string]any{"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "a"})
	facts := []otlpstage.StagedFact{{Fact: otlpstage.Fact{
		SpanID: [8]byte{1}, Kind: otlpstage.KindSpan, ScopeName: "pydantic-ai", Op: "invoke_agent", AgentName: "a",
		StartNs: now.Add(-5 * time.Second).UnixNano(), EndNs: now.Add(-time.Second).UnixNano(), Status: 1, Meta: meta,
	}}}
	pub := handlers.NewOTLPPublisher(&recordingBus{}, nil)
	a := New(nil, pub)
	for _, capture := range []bool{true, false} {
		events := genai.Resolve(genai.Input{
			Trace: otlpstage.Trace{Key: otlpstage.TraceKey{TokenKey: "t", TraceID: [16]byte{1}}, Source: "pydantic_ai",
				Resource: json.RawMessage(`{}`), Capture: true, FirstReceivedAt: now},
			Facts: facts, Reason: otlpstage.ReasonComplete,
		})
		end := events[len(events)-1]
		end.Payload["has_content"] = true
		end.Payload["content"] = map[string]any{"provider": "otel_genai", "model": "", "messages": []any{"hello"}}
		out, refused := a.encode(events, now, capture)
		if refused != 0 || len(out) != len(events) {
			t.Fatalf("capture %v: %d refused of %d", capture, refused, len(events))
		}
		var body map[string]any
		if err := json.Unmarshal(out[len(out)-1].Payload, &body); err != nil {
			t.Fatal(err)
		}
		if _, has := body["content"]; has != capture || body["has_content"] != capture {
			t.Errorf("capture %v: content present %v, has_content %v", capture, has, body["has_content"])
		}
	}
}

// The retry delay doubles per consecutive failure up to its cap, and a
// trace past the tracked bound waits the cap without being counted.
func TestRetryDelayIsCappedAndBounded(t *testing.T) {
	a := New(nil, nil)
	key := otlpstage.TraceKey{TokenKey: "t"}
	var got []time.Duration
	for range 8 {
		got = append(got, a.retryDelay(key))
	}
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30, 30}
	for i := range want {
		if got[i] != want[i]*time.Second {
			t.Fatalf("delays = %v, want %v seconds", got, want)
		}
	}
	a.failures = map[otlpstage.TraceKey]int{}
	for i := range maxTrackedFailures {
		a.failures[otlpstage.TraceKey{TokenKey: strconv.Itoa(i)}] = 1
	}
	other := otlpstage.TraceKey{TokenKey: "untracked"}
	if d := a.retryDelay(other); d != RetryDelayMax {
		t.Errorf("a trace past the bound waits %v, want %v", d, RetryDelayMax)
	}
	if _, tracked := a.failures[other]; tracked || len(a.failures) != maxTrackedFailures {
		t.Errorf("the failure map grew past its bound: %d", len(a.failures))
	}
}

// countingStore is a store that records the calls an idle assembler
// makes.
type countingStore struct {
	mu    sync.Mutex
	calls map[string]int
}

func (s *countingStore) hit(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls[name]++
}

func (s *countingStore) ClaimDue(context.Context, string) ([]otlpstage.Trace, error) {
	s.hit("claim")
	return nil, nil
}

func (s *countingStore) LoadTrace(context.Context, otlpstage.TraceKey) (otlpstage.LoadedTrace, error) {
	s.hit("load")
	return otlpstage.LoadedTrace{}, nil
}

func (s *countingStore) RenewLease(context.Context, string, otlpstage.TraceKey) (otlpstage.Lease, error) {
	s.hit("renew")
	return otlpstage.Lease{}, nil
}

func (s *countingStore) Defer(context.Context, string, otlpstage.TraceKey, int64, time.Time) (bool, error) {
	s.hit("defer")
	return false, nil
}

func (s *countingStore) MarkAssembled(context.Context, string, otlpstage.TraceKey, int64, otlpstage.Reason, []otlpstage.FactKey) (otlpstage.MarkResult, error) {
	s.hit("mark")
	return otlpstage.MarkResult{}, nil
}

func (s *countingStore) SweepTraces(context.Context) (int64, error) {
	s.hit("sweep_traces")
	return 0, nil
}

func (s *countingStore) SweepContent(context.Context) (int64, error) {
	s.hit("sweep_content")
	return 0, nil
}

// With nothing staged a round is one claim and nothing else.
func TestIdleTickIsOneClaim(t *testing.T) {
	s := &countingStore{calls: map[string]int{}}
	a := New(s, handlers.NewOTLPPublisher(&recordingBus{}, nil))
	for range 5 {
		if out := a.Tick(context.Background()); len(out) != 0 {
			t.Fatalf("idle tick assembled %v", out)
		}
	}
	if len(s.calls) != 1 || s.calls["claim"] != 5 {
		t.Errorf("idle calls = %v, want 5 claims and nothing else", s.calls)
	}
}

// Run stops when its context is cancelled.
func TestRunStopsOnCancel(t *testing.T) {
	s := &countingStore{calls: map[string]int{}}
	a := New(s, handlers.NewOTLPPublisher(&recordingBus{}, nil), WithInterval(time.Millisecond))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.Run(ctx)
	}()
	poll(t, "the first claims", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.calls["claim"] >= 3
	})
	cancel()
	poll(t, "Run to return", func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
}

// ---- database tests ----
//
// These run against a real Postgres at TEST_ASSEMBLER_POSTGRES_URL,
// migrated through 000036, and skip when it is not set. The database must
// be one of their own: an assembler claims every due trace in the
// database, so it must share it neither with an ingestion process nor
// with the otlpstage package's tests, which run concurrently under
// go test ./... and whose 2001-dated traces this package's later clock
// would find due. Each test stages under a token key of its own and
// deletes its rows when it ends.

const (
	pollTimeout  = 10 * time.Second
	pollInterval = 5 * time.Millisecond
)

// testEpoch is the clock every database test starts at, after the
// otlpstage tests' 2001, and before any real deployment's rows.
var testEpoch = time.Date(2004, 1, 1, 0, 0, 0, 0, time.UTC)

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

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// published is one event the bus received.
type published struct {
	subject string
	payload map[string]any
}

// recordingBus is the message bus: it records what is published, and
// after each publish runs a hook (to move the clock, cancel, stage a
// record or fail mid-assembly).
type recordingBus struct {
	mu     sync.Mutex
	events []published
	fail   bool
	after  func(n int)
}

func (b *recordingBus) Publish(subject string, data []byte) (uint64, error) {
	b.mu.Lock()
	if b.fail {
		b.mu.Unlock()
		return 0, errors.New("bus down")
	}
	var p map[string]any
	_ = json.Unmarshal(data, &p)
	b.events = append(b.events, published{subject: subject, payload: p})
	n := len(b.events)
	hook := b.after
	b.mu.Unlock()
	if hook != nil {
		hook(n)
	}
	return uint64(n), nil
}

func (b *recordingBus) snapshot() []published {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]published(nil), b.events...)
}

func (b *recordingBus) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events, b.after, b.fail = nil, nil, false
}

// recordingAttacher records the attachment checks the publish path runs.
type recordingAttacher struct {
	mu       sync.Mutex
	attached []string
	recorded []string
}

func (a *recordingAttacher) Attach(_ context.Context, sessionID string) (bool, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.attached = append(a.attached, sessionID)
	return true, "closed", nil
}

func (a *recordingAttacher) RecordStart(_ context.Context, sessionID string, _ uint64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.recorded = append(a.recorded, sessionID)
	return nil
}

func (a *recordingAttacher) checks() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.attached...)
}

// renewCounter wraps the store to count lease renewals (per trace), to
// fail the next renewal, and to run a hook just before a trace loads.
type renewCounter struct {
	*otlpstage.Store
	mu         sync.Mutex
	renewed    int
	renewedFor map[otlpstage.TraceKey]int
	failRenew  bool
	// failWaiting fails, once, the first renewal of a trace other than
	// the first one renewed: a waiting trace's keep-alive renewal.
	failWaiting bool
	firstKey    *otlpstage.TraceKey
	beforeLoad  func(otlpstage.TraceKey)
}

func (r *renewCounter) RenewLease(ctx context.Context, owner string, key otlpstage.TraceKey) (otlpstage.Lease, error) {
	r.mu.Lock()
	r.renewed++
	if r.renewedFor == nil {
		r.renewedFor = map[otlpstage.TraceKey]int{}
	}
	r.renewedFor[key]++
	if r.firstKey == nil {
		k := key
		r.firstKey = &k
	}
	fail := r.failRenew
	r.failRenew = false
	if r.failWaiting && key != *r.firstKey {
		fail, r.failWaiting = true, false
	}
	r.mu.Unlock()
	if fail {
		return otlpstage.Lease{}, errors.New("renewal failed")
	}
	return r.Store.RenewLease(ctx, owner, key)
}

func (r *renewCounter) LoadTrace(ctx context.Context, key otlpstage.TraceKey) (otlpstage.LoadedTrace, error) {
	r.mu.Lock()
	hook := r.beforeLoad
	r.beforeLoad = nil
	r.mu.Unlock()
	if hook != nil {
		hook(key)
	}
	return r.Store.LoadTrace(ctx, key)
}

type env struct {
	t        *testing.T
	pool     *pgxpool.Pool
	store    *renewCounter
	clock    *clock
	bus      *recordingBus
	attacher *recordingAttacher
	asm      *Assembler
	token    string
}

func newEnv(t *testing.T, opts ...Option) *env {
	t.Helper()
	dsn := os.Getenv("TEST_ASSEMBLER_POSTGRES_URL")
	if dsn == "" {
		t.Skip("no TEST_ASSEMBLER_POSTGRES_URL set; skipping DB test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_name = 'otlp_spans' AND column_name = 'assembled_in')`).Scan(&ok); err != nil || !ok {
		t.Fatalf("the test database is not migrated through 000036 (%v)", err)
	}
	c := &clock{now: testEpoch}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	token := "assembler-test-" + hex.EncodeToString(b)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM otlp_traces WHERE token_key = $1`, token)
	})
	store := &renewCounter{Store: otlpstage.NewStore(pool, otlpstage.WithClock(c.Now))}
	bus := &recordingBus{}
	att := &recordingAttacher{}
	opts = append([]Option{WithClock(c.Now)}, opts...)
	return &env{
		t: t, pool: pool, store: store, clock: c, bus: bus, attacher: att, token: token,
		asm: New(store, handlers.NewOTLPPublisher(bus, att), opts...),
	}
}

func (e *env) key() otlpstage.TraceKey {
	k := otlpstage.TraceKey{TokenKey: e.token}
	_, _ = rand.Read(k.TraceID[:])
	return k
}

// span is a record dated relative to the clock: it starts startAgo
// before now and lasts dur.
func (e *env) span(id, parent byte, scope, op, agent string, startAgo, dur time.Duration, meta map[string]any) otlpstage.Record {
	m := map[string]any{"gen_ai.operation.name": op}
	if agent != "" {
		m["gen_ai.agent.name"] = agent
	}
	for k, v := range meta {
		m[k] = v
	}
	raw, _ := json.Marshal(m)
	start := e.clock.Now().Add(-startAgo)
	f := otlpstage.Fact{
		SpanID: [8]byte{0xb0, 7: id}, Kind: otlpstage.KindSpan, ScopeName: scope, ScopeVersion: "1.0.0",
		Name: op, Op: op, AgentName: agent, StartNs: start.UnixNano(), EndNs: start.Add(dur).UnixNano(),
		Status: 1, Meta: raw,
	}
	if parent != 0 {
		f.ParentSpanID = [8]byte{0xb0, 7: parent}
	}
	return otlpstage.Record{Fact: f, Capture: true}
}

func (e *env) stage(key otlpstage.TraceKey, source string, records ...otlpstage.Record) {
	e.t.Helper()
	if _, err := e.store.Stage(context.Background(), []otlpstage.TraceBatch{{
		Key: key, TokenName: "assembler test", Source: source, SourceVersion: "1.0.0",
		Resource: json.RawMessage(`{"flightdeck.agent_type":"coding"}`), Records: records,
	}}); err != nil {
		e.t.Fatalf("Stage: %v", err)
	}
}

// tick runs one round and returns the outcomes of this test's traces.
func (e *env) tick() []Outcome {
	e.t.Helper()
	var out []Outcome
	for _, o := range e.asm.Tick(context.Background()) {
		if o.Key.TokenKey == e.token {
			out = append(out, o)
		}
	}
	return out
}

func (e *env) tickOne() Outcome {
	e.t.Helper()
	out := e.tick()
	if len(out) != 1 {
		e.t.Fatalf("claimed %d of this test's traces, want 1", len(out))
	}
	return out[0]
}

func (e *env) load(key otlpstage.TraceKey) otlpstage.LoadedTrace {
	e.t.Helper()
	lt, err := e.store.LoadTrace(context.Background(), key)
	if err != nil {
		e.t.Fatal(err)
	}
	return lt
}

func (e *env) traceState(key otlpstage.TraceKey) (pending bool, owner *string, resolveAt time.Time, count int) {
	e.t.Helper()
	if err := e.pool.QueryRow(context.Background(), `
		SELECT pending, lease_owner, resolve_at, assembly_count FROM otlp_traces WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:]).Scan(&pending, &owner, &resolveAt, &count); err != nil {
		e.t.Fatal(err)
	}
	return pending, owner, resolveAt.UTC(), count
}

// agentRun is one agent with a model call and a tool call.
func (e *env) agentRun(key otlpstage.TraceKey) {
	e.stage(key, "pydantic_ai",
		e.span(1, 0, "pydantic-ai", "invoke_agent", "a", 10*time.Second, 9*time.Second, nil),
		e.span(2, 1, "pydantic-ai", "chat", "a", 9*time.Second, time.Second,
			map[string]any{"gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 2}),
		e.span(3, 1, "pydantic-ai", "execute_tool", "a", 7*time.Second, time.Second,
			map[string]any{"gen_ai.tool.name": "t"}),
	)
}

func types(evs []published) []string {
	var out []string
	for _, ev := range evs {
		out = append(out, ev.payload["event_type"].(string))
	}
	return out
}

// A complete trace is published in order through the receiver's path,
// stamped with its token, without the attachment check on a first
// start, and marked with its assembly; it is not claimed again.
func TestAssemblesACompleteTrace(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.agentRun(key)
	if out := e.tick(); len(out) != 0 {
		t.Fatalf("assembled inside the root grace: %v", out)
	}
	e.clock.Advance(otlpstage.RootGrace)
	out := e.tickOne()
	if out.Reason != otlpstage.ReasonComplete || !out.Marked || out.Published != 4 || out.Refused != 0 {
		t.Fatalf("outcome = %+v", out)
	}
	evs := e.bus.snapshot()
	if got := strings.Join(types(evs), ","); got != "session_start,post_call,tool_call,session_end" {
		t.Fatalf("published %s", got)
	}
	st := evs[0].payload
	if st["token_id"] != e.token || st["token_name"] != "assembler test" || evs[0].subject != "events.session_start" {
		t.Errorf("start = %s %v", evs[0].subject, st)
	}
	if len(e.attacher.checks()) != 0 {
		t.Errorf("a first start ran the attachment check: %v", e.attacher.checks())
	}
	for _, f := range e.load(key).Facts {
		if !f.Assembled || f.AssembledIn != 1 {
			t.Errorf("record %x assembled=%v in=%d", f.SpanID, f.Assembled, f.AssembledIn)
		}
	}
	if pending, _, _, count := e.traceState(key); pending || count != 1 {
		t.Errorf("after the assembly pending=%v count=%d", pending, count)
	}
	e.clock.Advance(time.Hour / 2)
	if out := e.tick(); len(out) != 0 {
		t.Errorf("claimed again: %v", out)
	}
}

// A Google ADK trace whose generate_content span lacks its log record is
// released until 30 seconds after its root, and assembled as soon as the
// record arrives; one whose record never arrives is assembled at the
// timeout.
func TestADKDefersForItsLogRecords(t *testing.T) {
	e := newEnv(t)
	adk := func(key otlpstage.TraceKey) otlpstage.Record {
		e.stage(key, "google_adk",
			e.span(1, 0, "gcp.vertex.agent", "invoke_agent", "a", 10*time.Second, 9*time.Second, nil),
			e.span(2, 1, "gcp.vertex.agent", genai.OpGenerateContent, "a", 9*time.Second, time.Second,
				map[string]any{"gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 1}))
		lr := otlpstage.Record{Fact: otlpstage.Fact{
			SpanID: [8]byte{0xb0, 7: 2}, Kind: otlpstage.KindLog, ScopeName: "gcp.vertex.agent",
			Name: "gen_ai.client.inference.operation.details", StartNs: e.clock.Now().UnixNano(), EndNs: e.clock.Now().UnixNano(),
			Meta: json.RawMessage(`{"has_messages":false}`),
		}}
		return lr
	}
	staged := e.clock.Now()
	withLog, withoutLog := e.key(), e.key()
	lr := adk(withLog)
	adk(withoutLog)
	e.clock.Advance(otlpstage.RootGrace)
	for _, out := range e.tick() {
		if !out.Deferred || out.Marked {
			t.Fatalf("an ADK trace missing its log record was assembled: %+v", out)
		}
	}
	for _, k := range []otlpstage.TraceKey{withLog, withoutLog} {
		if _, owner, at, _ := e.traceState(k); owner != nil || !at.Equal(staged.Add(otlpstage.AdkLogWait)) {
			t.Errorf("deferred to %v (owner %v), want 30s after the root %v", at, owner, staged.Add(otlpstage.AdkLogWait))
		}
	}

	e.stage(withLog, "google_adk", lr)
	e.clock.Advance(otlpstage.RootGrace)
	out := e.tickOne()
	if out.Key != withLog || out.Reason != otlpstage.ReasonComplete || !out.Marked {
		t.Fatalf("after its log record: %+v", out)
	}

	e.clock.Advance(otlpstage.AdkLogWait)
	out = e.tickOne()
	if out.Key != withoutLog || out.Reason != otlpstage.ReasonADKLogTimeout || !out.Marked {
		t.Fatalf("at the log timeout: %+v", out)
	}
}

// A long trace is published in chunks with the lease renewed before
// each, the first included, so the lease outlives a publish longer than
// its TTL.
func TestChunkedPublishRenewsTheLease(t *testing.T) {
	e := newEnv(t, WithChunkSize(1))
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	// Each chunk takes most of a lease: four chunks take twice its TTL.
	e.bus.after = func(int) { e.clock.Advance(otlpstage.LeaseTTL / 2) }
	out := e.tickOne()
	if !out.Marked || out.Chunks != 4 || out.Published != 4 {
		t.Fatalf("outcome = %+v", out)
	}
	if e.store.renewed != 4 {
		t.Errorf("%d renewals for 4 chunks, want one before each", e.store.renewed)
	}
}

// A lease lost mid-publish stops the assembly: nothing is marked, and
// the next claim publishes every event again under the same ids.
func TestLeaseLostMidPublish(t *testing.T) {
	e := newEnv(t, WithChunkSize(2))
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	e.bus.after = func(n int) {
		if n == 2 {
			e.clock.Advance(otlpstage.LeaseTTL + time.Second)
		}
	}
	out := e.tickOne()
	if !out.LeaseLost || out.Marked || out.Published != 2 {
		t.Fatalf("outcome = %+v", out)
	}
	for _, f := range e.load(key).Facts {
		if f.Assembled {
			t.Fatal("a record was marked after the lease was lost")
		}
	}
	first := e.bus.snapshot()
	e.bus.reset()
	out = e.tickOne()
	if !out.Marked || out.Published != 4 {
		t.Fatalf("the next claim: %+v", out)
	}
	again := e.bus.snapshot()
	for i := range first {
		if first[i].payload["id"] != again[i].payload["id"] {
			t.Errorf("event %d republished as %v, was %v", i, again[i].payload["id"], first[i].payload["id"])
		}
	}
}

// Shutdown between chunks marks nothing and releases the lease, so the
// trace is due at once for another process.
func TestShutdownBetweenChunksReleases(t *testing.T) {
	e := newEnv(t, WithChunkSize(2))
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	ctx, cancel := context.WithCancel(context.Background())
	e.bus.after = func(n int) {
		if n == 1 {
			cancel() // mid-chunk: the chunk is still finished
		}
	}
	outs := e.asm.Tick(ctx)
	var out Outcome
	for _, o := range outs {
		if o.Key == key {
			out = o
		}
	}
	if !out.Deferred || out.Marked || out.Published != 2 {
		t.Fatalf("outcome = %+v, want the first chunk whole, then a release", out)
	}
	pending, owner, at, count := e.traceState(key)
	if !pending || owner != nil || at.After(e.clock.Now()) || count != 0 {
		t.Fatalf("after shutdown pending=%v owner=%v resolve_at=%v count=%d", pending, owner, at, count)
	}
	e.bus.reset()
	if out := e.tickOne(); !out.Marked || out.Published != 4 {
		t.Fatalf("another process's claim: %+v", out)
	}
}

// A record without capture staged between two chunks turns the trace
// off: the sessions started after it carry capture_prompts=false and a
// failed tool's message is the placeholder.
func TestCaptureFlipBetweenChunks(t *testing.T) {
	e := newEnv(t, WithChunkSize(1))
	key := e.key()
	failed := e.span(4, 3, "pydantic-ai", "execute_tool", "b", 3*time.Second, time.Second, map[string]any{"gen_ai.tool.name": "x", "error.type": "ValueError"})
	failed.Status = 2
	e.stage(key, "pydantic_ai",
		e.span(1, 0, "pydantic-ai", "invoke_agent", "a", 10*time.Second, 9*time.Second, nil),
		e.span(2, 1, "pydantic-ai", "execute_tool", "a", 8*time.Second, 6*time.Second, map[string]any{"gen_ai.tool.name": "ask"}),
		e.span(3, 2, "pydantic-ai", "invoke_agent", "b", 7*time.Second, 5*time.Second, nil),
		failed,
	)
	e.clock.Advance(otlpstage.RootGrace)
	e.bus.after = func(n int) {
		if n == 1 {
			off := e.span(9, 1, "pydantic-ai", "chat", "a", time.Second, time.Second, nil)
			off.Capture = false
			e.stage(key, "pydantic_ai", off)
		}
	}
	out := e.tickOne()
	if !out.Marked {
		t.Fatalf("outcome = %+v", out)
	}
	evs := e.bus.snapshot()
	if evs[0].payload["capture_prompts"] != true || evs[1].payload["event_type"] != "session_start" || evs[1].payload["capture_prompts"] != false {
		t.Errorf("starts: %v / %v", evs[0].payload["capture_prompts"], evs[1].payload["capture_prompts"])
	}
	for _, ev := range evs {
		if ev.payload["event_type"] == "tool_call" && ev.payload["tool_name"] == "x" {
			if msg := ev.payload["error"].(map[string]any)["message"]; msg != "<redacted>" {
				t.Errorf("tool error message after capture went off = %v", msg)
			}
		}
		if ev.payload["has_content"] != false {
			t.Errorf("%v carries content", ev.payload["event_type"])
		}
	}
	// The record staged during the claim keeps the trace due.
	if pending, _, _, _ := e.traceState(key); !pending {
		t.Error("the trace is not due after a record was staged during its assembly")
	}
}

// A record that arrives after its trace was assembled is published in a
// re-attaching start (with the attachment check) and an end, and marked
// with the second assembly.
func TestLateRecordRevivesItsSession(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	if out := e.tickOne(); !out.Marked {
		t.Fatalf("first assembly: %+v", out)
	}
	first := e.bus.snapshot()
	e.bus.reset()

	e.stage(key, "pydantic_ai", e.span(5, 1, "pydantic-ai", "execute_tool", "a", 5*time.Second, time.Second,
		map[string]any{"gen_ai.tool.name": "late"}))
	e.clock.Advance(otlpstage.RootGrace)
	out := e.tickOne()
	if !out.Marked || out.Published != 3 {
		t.Fatalf("late assembly: %+v", out)
	}
	evs := e.bus.snapshot()
	if got := strings.Join(types(evs), ","); got != "session_start,tool_call,session_end" {
		t.Fatalf("late assembly published %s", got)
	}
	if evs[0].payload["session_id"] != first[0].payload["session_id"] || evs[0].payload["id"] == first[0].payload["id"] {
		t.Errorf("re-attach start %v of session %v", evs[0].payload["id"], evs[0].payload["session_id"])
	}
	if checks := e.attacher.checks(); len(checks) != 1 || checks[0] != evs[0].payload["session_id"] {
		t.Errorf("attachment checks = %v, want the re-attaching start's", checks)
	}
	for _, f := range e.load(key).Facts {
		want := 1
		if f.SpanID[7] == 5 {
			want = 2
		}
		if f.AssembledIn != want {
			t.Errorf("record %d assembled in %d, want %d", f.SpanID[7], f.AssembledIn, want)
		}
	}
}

// A failed publish releases the trace to be retried a second later,
// marking nothing.
func TestPublishFailureRetries(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	e.bus.fail = true
	out := e.tickOne()
	if !out.Deferred || out.Marked || out.Published != 0 {
		t.Fatalf("outcome = %+v", out)
	}
	if _, owner, at, _ := e.traceState(key); owner != nil || !at.Equal(e.clock.Now().Add(RetryDelayMin)) {
		t.Errorf("released to %v (owner %v), want a second later", at, owner)
	}
	e.bus.fail = false
	if out := e.tick(); len(out) != 0 {
		t.Fatalf("retried before its delay: %v", out)
	}
	e.clock.Advance(RetryDelayMin)
	if out := e.tickOne(); !out.Marked || out.Published != 4 {
		t.Fatalf("the retry: %+v", out)
	}
}

// A trace that keeps failing to publish is retried after a delay that
// doubles from RetryDelayMin up to RetryDelayMax, and starts again from
// the minimum once it is published.
func TestPublishFailureBacksOff(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	e.bus.fail = true
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, RetryDelayMax, RetryDelayMax}
	for i, delay := range want {
		if out := e.tickOne(); !out.Deferred || out.Marked {
			t.Fatalf("failure %d: %+v", i+1, out)
		}
		if _, _, at, _ := e.traceState(key); !at.Equal(e.clock.Now().Add(delay)) {
			t.Fatalf("failure %d released to %v, want %v later", i+1, at.Sub(e.clock.Now()), delay)
		}
		e.clock.Advance(delay)
	}
	e.bus.fail = false
	if out := e.tickOne(); !out.Marked {
		t.Fatalf("after the outage: %+v", out)
	}
	if n := len(e.asm.failures); n != 0 {
		t.Errorf("%d traces still counted as failing after the publish", n)
	}
}

// A lease renewal that errors (the run context cancelled under it, or
// the database) releases the lease at once instead of leaving it to
// lapse, so another process can take the trace.
func TestRenewalErrorReleasesTheLease(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	e.store.failRenew = true
	out := e.tickOne()
	if !out.Deferred || out.Marked || out.Published != 0 {
		t.Fatalf("outcome = %+v", out)
	}
	if pending, owner, at, _ := e.traceState(key); !pending || owner != nil || at.After(e.clock.Now()) {
		t.Fatalf("after the failed renewal pending=%v owner=%v resolve_at=%v, want released and due now", pending, owner, at)
	}
	if out := e.tickOne(); !out.Marked {
		t.Fatalf("the next claim: %+v", out)
	}
}

// The leases of a claim's traces still waiting their turn are kept
// alive while an earlier, long assembly runs, so they are assembled in
// the same round rather than lapsing.
func TestWaitingLeasesInABatchAreRenewed(t *testing.T) {
	e := newEnv(t, WithChunkSize(1))
	first, second := e.key(), e.key()
	e.agentRun(first)
	e.agentRun(second)
	e.clock.Advance(otlpstage.RootGrace)
	// Each chunk takes half a lease: one trace's four chunks take twice
	// the TTL, which a waiting lease would not survive unrenewed.
	e.bus.after = func(int) { e.clock.Advance(otlpstage.LeaseTTL / 2) }
	outs := e.tick()
	if len(outs) != 2 {
		t.Fatalf("claimed %d traces, want both", len(outs))
	}
	for _, out := range outs {
		if !out.Marked || out.Published != 4 || out.LeaseLost {
			t.Errorf("trace %x: %+v", out.Key.TraceID[:2], out)
		}
	}
	waited := outs[1].Key
	// Its own four chunk renewals, plus at least one while it waited.
	if n := e.store.renewedFor[waited]; n < 5 {
		t.Errorf("the waiting trace's lease was renewed %d times, want at least 5", n)
	}
}

// A waiting trace whose keep-alive renewal errors is released at once,
// due now, rather than left to lapse; the next claim assembles it.
func TestWaitingRenewalErrorReleases(t *testing.T) {
	e := newEnv(t, WithChunkSize(1))
	first, second := e.key(), e.key()
	e.agentRun(first)
	e.agentRun(second)
	e.clock.Advance(otlpstage.RootGrace)
	e.bus.after = func(int) { e.clock.Advance(otlpstage.LeaseTTL / 2) }
	e.store.failWaiting = true
	outs := e.tick()
	if len(outs) != 2 || !outs[0].Marked || !outs[1].LeaseLost || outs[1].Published != 0 {
		t.Fatalf("outcomes = %+v", outs)
	}
	waited := outs[1].Key
	if pending, owner, at, _ := e.traceState(waited); !pending || owner != nil || at.After(e.clock.Now()) {
		t.Fatalf("the waiting trace: pending=%v owner=%v resolve_at=%v, want released and due now", pending, owner, at)
	}
	e.bus.after = nil
	if out := e.tickOne(); out.Key != waited || !out.Marked {
		t.Fatalf("the next claim: %+v", out)
	}
}

// A long chunk renews its lease after any publish slice that ends a
// quarter of the TTL or more after the last renewal, so a slow bus never
// lets the lease lapse inside one chunk.
func TestLongChunkRenewsByTime(t *testing.T) {
	e := newEnv(t, WithChunkSize(ChunkSize), WithPublishSlice(1))
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	// Each publish takes half a lease: the trace's four events take
	// twice the TTL, all inside one chunk.
	e.bus.after = func(int) { e.clock.Advance(otlpstage.LeaseTTL / 2) }
	out := e.tickOne()
	if !out.Marked || out.Chunks != 1 || out.Renewals != 3 || out.LeaseLost {
		t.Fatalf("outcome = %+v, want one chunk renewed after each of its first three slices", out)
	}
}

// A trace's failure count is dropped when it comes back not ready or
// loses its lease, so a later failure starts the backoff again.
func TestFailureCountDroppedWhenNotReadyOrLost(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.agentRun(key)
	e.asm.failures[key] = 4
	// Due now, as a retry would make it, though still inside its grace.
	if _, err := e.pool.Exec(context.Background(), `UPDATE otlp_traces SET resolve_at = $3 WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:], e.clock.Now()); err != nil {
		t.Fatal(err)
	}
	if out := e.tickOne(); !out.Deferred || out.Marked {
		t.Fatalf("inside the grace: %+v", out)
	}
	if _, counted := e.asm.failures[key]; counted {
		t.Error("a trace that came back not ready keeps its failure count")
	}

	e.clock.Advance(otlpstage.RootGrace)
	e.asm.failures[key] = 4
	e.bus.after = func(int) { e.clock.Advance(otlpstage.LeaseTTL + time.Second) }
	if out := e.tickOne(); !out.LeaseLost {
		t.Fatalf("lease lapse: %+v", out)
	}
	if _, counted := e.asm.failures[key]; counted {
		t.Error("a trace that lost its lease keeps its failure count")
	}
}

// A record staged between the claim and the load moves the trace's
// timer earlier; releasing a trace that is not ready keeps that time,
// since the release passes the claim's gen and sees it moved.
func TestNotReadyReleaseKeepsARacingRecordsTime(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	// A Google ADK trace missing its log record: due 30 s after its root.
	e.stage(key, "google_adk",
		e.span(1, 0, "gcp.vertex.agent", "invoke_agent", "a", 10*time.Second, 9*time.Second, nil),
		e.span(2, 1, "gcp.vertex.agent", genai.OpGenerateContent, "a", 9*time.Second, time.Second,
			map[string]any{"gen_ai.usage.input_tokens": 5}))
	e.clock.Advance(otlpstage.RootGrace)
	e.store.beforeLoad = func(k otlpstage.TraceKey) {
		// The racing record: staged after the claim read the trace,
		// it makes the trace due RootGrace from now.
		e.stage(k, "google_adk", e.span(3, 1, "gcp.vertex.agent", "execute_tool", "a", 2*time.Second, time.Second,
			map[string]any{"gen_ai.tool.name": "t"}))
	}
	if out := e.tickOne(); !out.Deferred || out.Marked {
		t.Fatalf("outcome = %+v", out)
	}
	if _, _, at, _ := e.traceState(key); !at.Equal(e.clock.Now().Add(otlpstage.RootGrace)) {
		t.Errorf("released to %v, want the racing record's %v, not the log wait",
			at, e.clock.Now().Add(otlpstage.RootGrace))
	}
}

// A trace made due early (by a retry) is not judged quiet before its
// quiet timeout: it is released to its own timer.
func TestEarlyClaimWaitsForItsTimer(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.stage(key, "pydantic_ai", e.span(2, 1, "pydantic-ai", "chat", "", 5*time.Second, time.Second,
		map[string]any{"gen_ai.usage.input_tokens": 1}))
	last := e.clock.Now()
	if _, err := e.pool.Exec(context.Background(), `UPDATE otlp_traces SET resolve_at = $3 WHERE token_key = $1 AND trace_id = $2`,
		key.TokenKey, key.TraceID[:], e.clock.Now()); err != nil {
		t.Fatal(err)
	}
	out := e.tickOne()
	if !out.Deferred || out.Marked {
		t.Fatalf("a rootless trace was assembled before its quiet timeout: %+v", out)
	}
	if _, _, at, _ := e.traceState(key); !at.Equal(last.Add(otlpstage.QuietTimeout)) {
		t.Errorf("released to %v, want its quiet timeout %v", at, last.Add(otlpstage.QuietTimeout))
	}
	e.clock.Advance(otlpstage.QuietTimeout)
	if out := e.tickOne(); out.Reason != otlpstage.ReasonQuiet || !out.Marked {
		t.Fatalf("at the quiet timeout: %+v", out)
	}
	if evs := e.bus.snapshot(); len(evs) != 3 || evs[0].payload["context"].(map[string]any)["otel_assembly"] != "quiet" {
		t.Errorf("quiet assembly published %v", types(evs))
	}
}

// The sweeps delete a trace past its retention.
func TestSweepDeletesExpiredTraces(t *testing.T) {
	e := newEnv(t)
	key := e.key()
	e.agentRun(key)
	e.clock.Advance(otlpstage.RootGrace)
	if out := e.tickOne(); !out.Marked {
		t.Fatalf("outcome = %+v", out)
	}
	e.clock.Advance(otlpstage.CompleteRetention + time.Second)
	e.asm.Sweep(context.Background())
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM otlp_traces WHERE token_key = $1`, e.token).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("%d traces left after the sweep", n)
	}
}
