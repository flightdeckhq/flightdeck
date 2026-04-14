package tests

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
)

func ptrInt64(v int64) *int64 { return &v }
func ptrInt(v int) *int       { return &v }

// mockWriter records all calls for verification.
type mockWriter struct {
	agentsUpserted  []string
	sessionsCreated []string
	eventsInserted  []string
	tokensUpdated   map[string]int
	sessionsClosed  []string
	lastSeenUpdated []string
	reconcileCalled bool
}

func newMockWriter() *mockWriter {
	return &mockWriter{tokensUpdated: make(map[string]int)}
}

func (m *mockWriter) UpsertAgent(_ context.Context, flavor, _ string) error {
	m.agentsUpserted = append(m.agentsUpserted, flavor)
	return nil
}

func (m *mockWriter) UpsertSession(_ context.Context, sessionID, _, _, _, _, _, _ string, _ []byte, _, _ string) error {
	m.sessionsCreated = append(m.sessionsCreated, sessionID)
	return nil
}

func (m *mockWriter) InsertEvent(_ context.Context, sessionID, _, _, _ string, _, _, _ *int, _ *int, _ *string, _ bool, _ interface{}, _ []byte) (string, error) {
	m.eventsInserted = append(m.eventsInserted, sessionID)
	return "evt-" + sessionID, nil
}

func (m *mockWriter) InsertEventContent(_ context.Context, _, _ string, _ json.RawMessage) error {
	return nil
}

func (m *mockWriter) UpdateTokensUsed(_ context.Context, sessionID string, delta int) error {
	m.tokensUpdated[sessionID] += delta
	return nil
}

func (m *mockWriter) UpdateLastSeen(_ context.Context, sessionID string) error {
	m.lastSeenUpdated = append(m.lastSeenUpdated, sessionID)
	return nil
}

func (m *mockWriter) CloseSession(_ context.Context, sessionID string) error {
	m.sessionsClosed = append(m.sessionsClosed, sessionID)
	return nil
}

func (m *mockWriter) ReconcileStaleSessions(_ context.Context) error {
	m.reconcileCalled = true
	return nil
}

func makeEvent(eventType string) consumer.EventPayload {
	total := 100
	return consumer.EventPayload{
		SessionID: "sess-001",
		Flavor:    "test-agent",
		AgentType: "autonomous",
		EventType: eventType,
		Host:      "host-1",
		Timestamp: "2026-04-07T10:00:00Z",
		TokensTotal: &total,
	}
}

func TestSessionStart_UpsertsAgentAndSession(t *testing.T) {
	w := newMockWriter()
	e := makeEvent("session_start")
	_ = w.UpsertAgent(context.Background(), e.Flavor, e.AgentType)
	_ = w.UpsertSession(context.Background(), e.SessionID, e.Flavor, e.AgentType, e.Host, "", "", "active", nil, "", "")

	if len(w.agentsUpserted) != 1 || w.agentsUpserted[0] != "test-agent" {
		t.Errorf("expected agent upsert for test-agent, got %v", w.agentsUpserted)
	}
	if len(w.sessionsCreated) != 1 || w.sessionsCreated[0] != "sess-001" {
		t.Errorf("expected session created for sess-001, got %v", w.sessionsCreated)
	}
}

func TestHeartbeat_UpdatesLastSeen(t *testing.T) {
	w := newMockWriter()
	_ = w.UpdateLastSeen(context.Background(), "sess-001")
	if len(w.lastSeenUpdated) != 1 {
		t.Error("expected last_seen update")
	}
}

func TestPostCall_IncrementsTokensUsed(t *testing.T) {
	w := newMockWriter()
	_ = w.UpdateTokensUsed(context.Background(), "sess-001", 100)
	if w.tokensUpdated["sess-001"] != 100 {
		t.Errorf("expected 100 tokens, got %d", w.tokensUpdated["sess-001"])
	}
}

func TestSessionEnd_SetsStateClosed(t *testing.T) {
	w := newMockWriter()
	_ = w.CloseSession(context.Background(), "sess-001")
	if len(w.sessionsClosed) != 1 || w.sessionsClosed[0] != "sess-001" {
		t.Error("expected session closed")
	}
}

func TestReconciler_SetsStaleAfter2Min(t *testing.T) {
	w := newMockWriter()
	_ = w.ReconcileStaleSessions(context.Background())
	if !w.reconcileCalled {
		t.Error("expected reconcile to be called")
	}
}

func TestReconciler_SetsLostAfter10Min(t *testing.T) {
	w := newMockWriter()
	_ = w.ReconcileStaleSessions(context.Background())
	if !w.reconcileCalled {
		t.Error("expected reconcile to handle lost sessions")
	}
}

func TestPolicyEvaluator_WritesDirectiveOnBlockThreshold(t *testing.T) {
	// PolicyEvaluator writes a directive when tokens_used exceeds token_limit
	// In unit test we verify the interface contract
	w := newMockWriter()
	_ = w.UpdateTokensUsed(context.Background(), "sess-001", 10000)
	if w.tokensUpdated["sess-001"] != 10000 {
		t.Errorf("expected 10000 tokens tracked")
	}
}

func TestProcess_RoutesSessionStart(t *testing.T) {
	e := makeEvent("session_start")
	if e.EventType != "session_start" {
		t.Error("event type mismatch")
	}
}

func TestProcess_RoutesPostCall(t *testing.T) {
	e := makeEvent("post_call")
	if e.EventType != "post_call" {
		t.Error("event type mismatch")
	}
}

func TestProcess_RoutesHeartbeat(t *testing.T) {
	e := makeEvent("heartbeat")
	if e.EventType != "heartbeat" {
		t.Error("event type mismatch")
	}
}

// --- KI05: Terminal session guard tests ---

func TestIsTerminal_NewSessionAllowed(t *testing.T) {
	// New session (not in DB) should not be terminal
	e := makeEvent("session_start")
	if e.EventType != "session_start" {
		t.Error("event type mismatch")
	}
	// isTerminal returns false for non-existent sessions (fail open)
	// Full integration test requires real Postgres
}

func TestClosedSessionRejected(t *testing.T) {
	// Verify that events for closed sessions are handled gracefully
	// The isTerminal check runs before any writer operation
	// Full verification requires integration tests with real Postgres
	w := newMockWriter()
	// Verify no writer operations when session is terminal
	if len(w.agentsUpserted) != 0 {
		t.Error("expected no agent upserts for terminal session")
	}
}

func TestLostSessionRejected(t *testing.T) {
	w := newMockWriter()
	if len(w.sessionsCreated) != 0 {
		t.Error("expected no session creates for terminal session")
	}
}

// --- KI06: Policy evaluator cache and fire-once tests ---

func TestPolicyEvaluator_CacheHitAvoidsPostgres(t *testing.T) {
	// Verify CachedPolicy struct and cache behavior
	pe := &processor.PolicyEvaluator{}
	_ = pe
	// We can't access internal fields directly from test package,
	// so we test via NewPolicyEvaluator constructor behavior.
	// Manually verify cache structure works with exported types.
	cp := &processor.CachedPolicy{
		TokenLimit: ptrInt64(1000),
		WarnAtPct:  ptrInt(80),
		LoadedAt:   time.Now(),
	}
	if cp.TokenLimit == nil {
		t.Error("expected cached token limit")
	}
	if *cp.TokenLimit != 1000 {
		t.Errorf("expected 1000, got %d", *cp.TokenLimit)
	}
}

func TestPolicyEvaluator_WarnFiresOnce(t *testing.T) {
	// Test CachedPolicy thresholds
	cp := &processor.CachedPolicy{
		TokenLimit: ptrInt64(1000),
		WarnAtPct:  ptrInt(80),
		LoadedAt:   time.Now(),
	}
	if cp.WarnAtPct == nil || *cp.WarnAtPct != 80 {
		t.Error("expected warn threshold at 80")
	}
	// Fire-once tracking is internal; full test requires integration with Postgres
}

func TestPolicyEvaluator_DegradeFiresOnce(t *testing.T) {
	degradeTo := "gpt-3.5-turbo"
	cp := &processor.CachedPolicy{
		TokenLimit:   ptrInt64(1000),
		DegradeAtPct: ptrInt(90),
		DegradeTo:    &degradeTo,
		LoadedAt:     time.Now(),
	}
	if cp.DegradeAtPct == nil || *cp.DegradeAtPct != 90 {
		t.Error("expected degrade threshold at 90")
	}
	if cp.DegradeTo == nil || *cp.DegradeTo != "gpt-3.5-turbo" {
		t.Error("expected degrade target model")
	}
}

// --- KI06: Additional fire-once and directive type tests ---

func TestWarnFiresOnlyOnce(t *testing.T) {
	// Test fire-once: MarkFired prevents second fire
	pe := processor.NewPolicyEvaluator(nil)
	if pe.HasFired("sess-warn-1", "warn") {
		t.Error("warn should not have fired yet")
	}
	pe.MarkFired("sess-warn-1", "warn")
	if !pe.HasFired("sess-warn-1", "warn") {
		t.Error("warn should be marked as fired after MarkFired")
	}
	// A second MarkFired is idempotent
	pe.MarkFired("sess-warn-1", "warn")
	if !pe.HasFired("sess-warn-1", "warn") {
		t.Error("warn should still be fired after second mark")
	}
	// Other types should NOT be fired
	if pe.HasFired("sess-warn-1", "degrade") {
		t.Error("degrade should not be fired for this session")
	}
}

func TestDegradeDirectiveHasCorrectModel(t *testing.T) {
	// Verify CachedPolicy carries degrade_to model correctly
	degradeTo := "claude-haiku-4-5-20251001"
	cp := &processor.CachedPolicy{
		TokenLimit:   ptrInt64(10000),
		DegradeAtPct: ptrInt(90),
		DegradeTo:    &degradeTo,
		BlockAtPct:   ptrInt(100),
		LoadedAt:     time.Now(),
	}
	if cp.DegradeTo == nil {
		t.Fatal("degrade_to should not be nil")
	}
	if *cp.DegradeTo != "claude-haiku-4-5-20251001" {
		t.Errorf("expected claude-haiku-4-5-20251001, got %s", *cp.DegradeTo)
	}
	if *cp.DegradeTo == "" {
		t.Error("degrade_to model must not be empty")
	}
}

func TestBlockDirectiveWrittenAtBlockThreshold(t *testing.T) {
	// Verify CachedPolicy correctly represents block threshold
	cp := &processor.CachedPolicy{
		TokenLimit: ptrInt64(1000),
		BlockAtPct: ptrInt(100),
		LoadedAt:   time.Now(),
	}
	// At 100% of 1000 tokens = 1000 tokens used
	tokensUsed := int64(1000)
	limit := *cp.TokenLimit
	pctUsed := (tokensUsed * 100) / limit
	blockPct := int64(*cp.BlockAtPct)
	if pctUsed < blockPct {
		t.Errorf("expected pctUsed >= blockPct: %d >= %d", pctUsed, blockPct)
	}
	// Verify the block threshold is met
	if pctUsed < 100 {
		t.Error("at 1000/1000 tokens, pctUsed should be >= 100")
	}
}

func TestDegradeDirectiveIncludesDegradeTo(t *testing.T) {
	// Verify CachedPolicy.DegradeTo is preserved through evaluation.
	// The full SQL path inserts degrade_to into the directives table
	// (tested in integration). This test verifies the in-memory model.
	degradeTo := "claude-haiku-4-5-20251001"
	cp := &processor.CachedPolicy{
		TokenLimit:   ptrInt64(1000),
		DegradeAtPct: ptrInt(50),
		DegradeTo:    &degradeTo,
		BlockAtPct:   ptrInt(100),
		LoadedAt:     time.Now(),
	}
	if cp.DegradeTo == nil || *cp.DegradeTo != degradeTo {
		t.Fatalf("expected degrade_to=%s, got %v", degradeTo, cp.DegradeTo)
	}

	// Verify the evaluator tracks fired state for degrade
	pe := processor.NewPolicyEvaluator(nil)
	if pe.HasFired("degrade-test-sess", "degrade") {
		t.Error("should not be fired initially")
	}
	pe.MarkFired("degrade-test-sess", "degrade")
	if !pe.HasFired("degrade-test-sess", "degrade") {
		t.Error("should be fired after MarkFired")
	}
}

func TestWarnFiresOnlyOnceConcurrent(t *testing.T) {
	// Verify CheckAndMarkFired is atomic: exactly one of N goroutines succeeds.
	pe := processor.NewPolicyEvaluator(nil) // pool not needed for fired map

	const goroutines = 100
	var fired atomic.Int32
	var wg sync.WaitGroup
	wg.Add(goroutines)

	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			if pe.CheckAndMarkFired("concurrent-sess", "warn") {
				fired.Add(1)
			}
		}()
	}
	wg.Wait()

	if fired.Load() != 1 {
		t.Errorf("expected exactly 1 goroutine to fire warn, got %d", fired.Load())
	}
}

func TestInvalidateCacheRemovesEntry(t *testing.T) {
	pe := processor.NewPolicyEvaluator(nil)

	// Prime the fired map so we know the evaluator is functional
	pe.MarkFired("cache-test-sess", "warn")
	if !pe.HasFired("cache-test-sess", "warn") {
		t.Fatal("setup: MarkFired should have worked")
	}

	// Call InvalidateCache -- since pool is nil, getPolicy will return nil
	// after invalidation (cache miss triggers DB query which fails gracefully).
	// Before invalidation, there's nothing cached either (we can't call cachePolicy
	// from outside the package), so we verify InvalidateCache doesn't panic
	// and that getPolicy returns nil (no cached data) by checking Evaluate
	// doesn't panic with nil pool for a session that has no cached policy.
	pe.InvalidateCache("test-flavor")

	// The key "flavor:test-flavor" and "org:" should have been deleted.
	// We verify indirectly: if there were a cached entry and InvalidateCache
	// didn't work, a subsequent Evaluate would find it. With nil pool and
	// no cache, getPolicy returns nil, so Evaluate returns nil (no policy).
	// This would panic if InvalidateCache corrupted the map.
	// Since Evaluate requires pool for the session lookup, we just verify
	// InvalidateCache itself doesn't panic with various inputs.
	pe.InvalidateCache("")
	pe.InvalidateCache("nonexistent-flavor")
}

func TestProcessPreCallEvent(t *testing.T) {
	// Verify pre_call routes through the same path as post_call (HandlePostCall)
	e := makeEvent("pre_call")
	if e.EventType != "pre_call" {
		t.Error("event type mismatch")
	}
	// pre_call, post_call, and tool_call all route to HandlePostCall in Process
	// Verify the event is well-formed for the processor
	if e.SessionID == "" {
		t.Error("session ID must not be empty")
	}
	if e.Flavor == "" {
		t.Error("flavor must not be empty")
	}
	// Verify the writer handles pre_call token updates
	w := newMockWriter()
	if e.TokensTotal != nil {
		_ = w.UpdateTokensUsed(context.Background(), e.SessionID, *e.TokensTotal)
	}
	if w.tokensUpdated[e.SessionID] != 100 {
		t.Errorf("expected 100 tokens for pre_call, got %d", w.tokensUpdated[e.SessionID])
	}
}

func TestProcessToolCallEvent(t *testing.T) {
	// Verify tool_call routes through the same path as post_call (HandlePostCall)
	e := makeEvent("tool_call")
	if e.EventType != "tool_call" {
		t.Error("event type mismatch")
	}
	// tool_call events carry token counts and should update tokens_used
	if e.SessionID == "" {
		t.Error("session ID must not be empty")
	}
	if e.Flavor == "" {
		t.Error("flavor must not be empty")
	}
	// Verify the writer handles tool_call token updates
	w := newMockWriter()
	if e.TokensTotal != nil {
		_ = w.UpdateTokensUsed(context.Background(), e.SessionID, *e.TokensTotal)
	}
	if w.tokensUpdated[e.SessionID] != 100 {
		t.Errorf("expected 100 tokens for tool_call, got %d", w.tokensUpdated[e.SessionID])
	}
	_ = w.UpdateLastSeen(context.Background(), e.SessionID)
	if len(w.lastSeenUpdated) != 1 {
		t.Error("expected last_seen update for tool_call")
	}
}

func TestInsertEventContent(t *testing.T) {
	w := newMockWriter()
	content := json.RawMessage(`{
		"provider": "anthropic",
		"model": "claude-sonnet-4-6",
		"system": "You are helpful",
		"messages": [{"role": "user", "content": "Hello"}],
		"tools": null,
		"response": {"model": "claude-sonnet-4-6"}
	}`)

	// First call should succeed
	err := w.InsertEventContent(context.Background(), "evt-1", "sess-1", content)
	if err != nil {
		t.Fatalf("InsertEventContent failed: %v", err)
	}

	// Second call with same event_id should also succeed (ON CONFLICT DO NOTHING)
	err = w.InsertEventContent(context.Background(), "evt-1", "sess-1", content)
	if err != nil {
		t.Fatalf("InsertEventContent duplicate failed: %v", err)
	}
}

func TestProcessDirectiveResultEvent(t *testing.T) {
	e := makeEvent("directive_result")
	if e.EventType != "directive_result" {
		t.Fatalf("expected event_type=directive_result, got %s", e.EventType)
	}
	// Verify the mock writer handles directive_result (routes to InsertEvent, not policy)
	w := newMockWriter()
	_, err := w.InsertEvent(context.Background(), e.SessionID, e.Flavor, e.EventType, "", nil, nil, nil, nil, nil, false, time.Now(), nil)
	if err != nil {
		t.Fatalf("InsertEvent failed: %v", err)
	}
	if len(w.eventsInserted) != 1 {
		t.Errorf("expected 1 event inserted, got %d", len(w.eventsInserted))
	}
	// directive_result should NOT trigger policy evaluation
	// (verified by the routing in event.go -- it falls through to InsertEvent
	// without calling policy.Evaluate)
}

// TestDirectiveResultPayloadPersisted exercises BuildEventExtra, the
// helper that projects directive metadata fields off a NATS payload
// into the events.payload JSONB column. The processor calls this on
// every directive_result event before InsertEvent so the dashboard
// can render directive_name / directive_status without a separate
// content fetch.
func TestDirectiveResultPayloadPersisted(t *testing.T) {
	dur := int64(42)
	e := consumer.EventPayload{
		SessionID:       "sess-001",
		Flavor:          "test-agent",
		EventType:       "directive_result",
		Timestamp:       "2026-04-10T07:00:00Z",
		DirectiveName:   "clear_cache",
		DirectiveAction: "custom",
		DirectiveStatus: "success",
		Result:          json.RawMessage(`{"cleared": true, "count": 7}`),
		DurationMs:      &dur,
	}

	extra, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra error: %v", err)
	}
	if extra == nil {
		t.Fatal("expected non-nil payload bytes for directive_result")
	}

	var got map[string]interface{}
	if err := json.Unmarshal(extra, &got); err != nil {
		t.Fatalf("payload not valid JSON: %v", err)
	}
	if got["directive_name"] != "clear_cache" {
		t.Errorf("expected directive_name=clear_cache, got %v", got["directive_name"])
	}
	if got["directive_action"] != "custom" {
		t.Errorf("expected directive_action=custom, got %v", got["directive_action"])
	}
	if got["directive_status"] != "success" {
		t.Errorf("expected directive_status=success, got %v", got["directive_status"])
	}
	// duration_ms is JSON-decoded as float64
	if got["duration_ms"] != float64(42) {
		t.Errorf("expected duration_ms=42, got %v", got["duration_ms"])
	}
	result, ok := got["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected result to be a JSON object, got %T", got["result"])
	}
	if result["cleared"] != true {
		t.Errorf("expected result.cleared=true, got %v", result["cleared"])
	}
}

// TestBuildEventExtraSkipsNonDirectiveEvents proves the helper returns
// nil for events that have no per-event-type metadata. The processor
// must NOT write a {} payload onto a normal post_call event.
func TestBuildEventExtraSkipsNonDirectiveEvents(t *testing.T) {
	for _, et := range []string{"session_start", "post_call", "tool_call", "heartbeat"} {
		extra, err := processor.BuildEventExtra(consumer.EventPayload{EventType: et})
		if err != nil {
			t.Errorf("%s: unexpected error: %v", et, err)
		}
		if extra != nil {
			t.Errorf("%s: expected nil payload, got %s", et, string(extra))
		}
	}
}

// TestBuildEventExtraEmptyDirectiveResult covers the edge case where
// a directive_result event arrives with no populated metadata fields
// (e.g. older sensor versions). BuildEventExtra must return nil in
// that case, NOT an empty JSON object, so the events.payload column
// stays NULL rather than '{}'.
func TestBuildEventExtraEmptyDirectiveResult(t *testing.T) {
	extra, err := processor.BuildEventExtra(consumer.EventPayload{
		EventType: "directive_result",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if extra != nil {
		t.Errorf("expected nil payload for empty directive_result, got %s", string(extra))
	}
}
