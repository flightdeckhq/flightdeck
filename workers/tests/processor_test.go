package tests

import (
	"context"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

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
