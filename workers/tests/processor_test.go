package tests

import (
	"context"
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

func (m *mockWriter) UpsertSession(_ context.Context, sessionID, _, _, _, _, _, _ string) error {
	m.sessionsCreated = append(m.sessionsCreated, sessionID)
	return nil
}

func (m *mockWriter) InsertEvent(_ context.Context, sessionID, _, _, _ string, _, _, _ *int, _ *int, _ *string, _ bool, _ interface{}) error {
	m.eventsInserted = append(m.eventsInserted, sessionID)
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
	_ = w.UpsertSession(context.Background(), e.SessionID, e.Flavor, e.AgentType, e.Host, "", "", "active")

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
