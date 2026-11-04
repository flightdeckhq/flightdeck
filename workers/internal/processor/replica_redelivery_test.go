package processor

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
)

// testContent is a captured prompt in the shape the sensor sends.
var testContent = json.RawMessage(`{"provider":"anthropic","model":"claude-sonnet-4-6","system":null,` +
	`"messages":[{"role":"user","content":"replica"}],"tools":null,"response":{"content":[]}}`)

// cleanupSession removes a session's events (and their content, by
// cascade) and its row when the test ends.
func cleanupSession(t *testing.T, pool *pgxpool.Pool, sessionID string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM event_content WHERE session_id = $1::uuid`, sessionID)
		_, _ = pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, sessionID)
	})
}

func contentCall(sessionID, agentID string, final bool) consumer.EventPayload {
	tokens := 5
	return consumer.EventPayload{
		SessionID: sessionID, EventType: "post_call", Flavor: "replica-test",
		AgentID: agentID, AgentType: "coding", ClientType: "flightdeck_sensor",
		AgentName: "replica-test", User: "test", Hostname: "test-host",
		TokensTotal: &tokens, HasContent: true, Content: testContent,
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		FinalDelivery: final,
	}
}

// seedTestAgent inserts an agent for session_start events to name.
func seedTestAgent(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	agentID := randomID(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname)
		VALUES ($1::uuid, 'coding', 'flightdeck_sensor', 'replica-test', 'test', 'test-host')`, agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agents WHERE agent_id = $1::uuid`, agentID) })
	return agentID
}

func startEvent(sessionID, agentID string, capture bool) consumer.EventPayload {
	return consumer.EventPayload{
		SessionID: sessionID, EventType: "session_start", Flavor: "replica-test",
		AgentID: agentID, AgentType: "coding", ClientType: "flightdeck_sensor",
		AgentName: "replica-test", User: "test", Hostname: "test-host",
		CapturePrompts: capture,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql, sessionID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, sessionID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func storedContent(t *testing.T, pool *pgxpool.Pool, sessionID string) (events, withContent int) {
	t.Helper()
	events = countRows(t, pool, `SELECT count(*) FROM events WHERE session_id = $1::uuid AND event_type = 'post_call'`, sessionID)
	withContent = countRows(t, pool, `
		SELECT count(*) FROM events e JOIN event_content c ON c.event_id = e.id
		WHERE e.session_id = $1::uuid AND e.has_content`, sessionID)
	return events, withContent
}

// A content event that reaches the worker before its session_start (the
// start waiting in another replica's lane) is redelivered instead of
// landing on a lazily created row with no posture; once the start has
// stored the posture, the redelivered event keeps its content.
func TestProcess_ContentBeforeItsStartWaitsAndKeepsItsContent(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	agentID := seedTestAgent(t, pool)
	sessionID := randomID(t)
	cleanupSession(t, pool, sessionID)

	err := p.Process(ctx, contentCall(sessionID, agentID, false))
	if !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("content before its start: err = %v, want ErrRetryLater", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM sessions WHERE session_id = $1::uuid`, sessionID); n != 0 {
		t.Fatalf("a waiting event must not lazily create the row; rows = %d", n)
	}
	if err := p.Process(ctx, startEvent(sessionID, agentID, true)); err != nil {
		t.Fatalf("session_start: %v", err)
	}
	if err := p.Process(ctx, contentCall(sessionID, agentID, false)); err != nil {
		t.Fatalf("redelivered content: %v", err)
	}
	if events, withContent := storedContent(t, pool, sessionID); events != 1 || withContent != 1 {
		t.Fatalf("post_call rows = %d, with content = %d; want 1 and 1", events, withContent)
	}
}

// A row with no capture posture (lazily created by an earlier event, or
// a parent stub) is waited on the same way as a missing row.
func TestProcess_ContentOnARowWithNoPostureWaits(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	agentID := seedTestAgent(t, pool)
	sessionID := randomID(t)
	cleanupSession(t, pool, sessionID)

	// A heartbeat carries no content, so it lazily creates the row at once.
	if err := p.Process(ctx, consumer.EventPayload{
		SessionID: sessionID, EventType: "heartbeat", Flavor: "replica-test",
		AgentID: agentID, AgentType: "coding", ClientType: "flightdeck_sensor",
		AgentName: "replica-test", User: "test", Hostname: "test-host",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM sessions WHERE session_id = $1::uuid AND capture_prompts IS NULL`, sessionID); n != 1 {
		t.Fatalf("lazily created row with no posture: rows = %d, want 1", n)
	}
	if err := p.Process(ctx, contentCall(sessionID, agentID, false)); !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("content on a row with no posture: err = %v, want ErrRetryLater", err)
	}
	// A plugin tool failure's error text is content too.
	toolErr := consumer.EventPayload{
		SessionID: sessionID, EventType: "tool_call", Flavor: "replica-test",
		ClientType: "claude_code",
		Error:      json.RawMessage(`{"error_type":"other","message":"stderr"}`),
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
	}
	if err := p.Process(ctx, toolErr); !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("tool error text on a row with no posture: err = %v, want ErrRetryLater", err)
	}
}

// On the last delivery the budget allows, the event never waits: it
// takes the fallback (lazy creation, content dropped fail-safe) and is
// stored, so the wait can never end a message.
func TestProcess_ContentOnTheLastDeliveryFallsBackToLazyCreation(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	agentID := seedTestAgent(t, pool)
	sessionID := randomID(t)
	cleanupSession(t, pool, sessionID)

	if err := p.Process(ctx, contentCall(sessionID, agentID, true)); err != nil {
		t.Fatalf("content on the last delivery: err = %v, want nil", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM sessions WHERE session_id = $1::uuid`, sessionID); n != 1 {
		t.Fatalf("the fallback lazily creates the row; rows = %d", n)
	}
	events, withContent := storedContent(t, pool, sessionID)
	if events != 1 || withContent != 0 {
		t.Fatalf("post_call rows = %d, with content = %d; want 1 and 0 (no posture: content dropped)", events, withContent)
	}
}

// A session whose posture is known is not delayed, whichever posture it
// is, and an event without content never reads the posture.
func TestProcess_ContentOnASessionWithAPostureIsNotDelayed(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	agentID := seedTestAgent(t, pool)
	for _, capture := range []bool{true, false} {
		sessionID := randomID(t)
		cleanupSession(t, pool, sessionID)
		if err := p.Process(ctx, startEvent(sessionID, agentID, capture)); err != nil {
			t.Fatalf("session_start: %v", err)
		}
		if err := p.Process(ctx, contentCall(sessionID, agentID, false)); err != nil {
			t.Fatalf("capture=%v: err = %v, want nil", capture, err)
		}
		want := 0
		if capture {
			want = 1
		}
		if _, withContent := storedContent(t, pool, sessionID); withContent != want {
			t.Errorf("capture=%v: calls with content = %d, want %d", capture, withContent, want)
		}
	}

	// No content: lazily created at once, as before.
	sessionID := randomID(t)
	cleanupSession(t, pool, sessionID)
	call := contentCall(sessionID, agentID, false)
	call.HasContent, call.Content = false, nil
	if err := p.Process(ctx, call); err != nil {
		t.Fatalf("call without content before its start: err = %v, want nil", err)
	}
}

// A database error while reading the posture is retried as any other
// processing failure, never mistaken for "no posture yet".
func TestProcess_PostureReadErrorIsAFailureNotAWait(t *testing.T) {
	pool := dbPool(t)
	p := NewProcessor(pool)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := p.Process(ctx, contentCall(randomID(t), "", false))
	if err == nil || errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("err = %v, want the read's error", err)
	}
}

// seedClosedRow inserts a closed session with the given end sequence (0
// stores NULL) and context.
func seedClosedRow(t *testing.T, pool *pgxpool.Pool, closedSeq int64, contextJSON string) string {
	t.Helper()
	sessionID := randomID(t)
	cleanupSession(t, pool, sessionID)
	endedAt := time.Now().UTC().Add(-time.Minute)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO sessions (session_id, flavor, agent_type, state, ended_at, last_seen_at, closed_seq, tokens_used, context, capture_prompts)
		VALUES ($1::uuid, 'replica-test', 'coding', 'closed', $2, $2, NULLIF($3::bigint, 0), 0, $4::jsonb, false)`,
		sessionID, endedAt, closedSeq, contextJSON); err != nil {
		t.Fatalf("seed closed session: %v", err)
	}
	return sessionID
}

const assembledContext = `{"telemetry":"otlp","otel_trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"}`

func lateCall(sessionID, eventType string, tokens int, seq uint64, final bool) consumer.EventPayload {
	e := consumer.EventPayload{
		SessionID: sessionID, EventType: eventType, Flavor: "replica-test",
		AgentType: "coding", ClientType: "otlp",
		StreamSeq: seq, FinalDelivery: final,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	if tokens > 0 {
		e.TokensTotal = &tokens
	}
	return e
}

func tokensUsed(t *testing.T, pool *pgxpool.Pool, sessionID string) int {
	t.Helper()
	return countRows(t, pool, `SELECT tokens_used FROM sessions WHERE session_id = $1::uuid`, sessionID)
}

// A late call of an assembled session that finds the row still closed by
// the previous run's end is redelivered, so its re-attaching start
// (on another replica) lands first and the call's tokens count.
func TestProcess_LateCallOfAnAssembledSessionWaitsForItsReattachment(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	agentID := seedTestAgent(t, pool)
	sessionID := seedClosedRow(t, pool, 500, assembledContext)
	skipsBefore := metrics.Snapshot()[metrics.ReasonClosedSessionSkip]

	if err := p.Process(ctx, lateCall(sessionID, "post_call", 12, 502, false)); !errors.Is(err, consumer.ErrRetryLater) {
		t.Fatalf("late call before its re-attaching start: err = %v, want ErrRetryLater", err)
	}
	if got := metrics.Snapshot()[metrics.ReasonClosedSessionSkip] - skipsBefore; got != 0 {
		t.Errorf("a waiting call is not a closed-session skip; skips = %d", got)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM events WHERE session_id = $1::uuid`, sessionID); n != 0 {
		t.Fatalf("a waiting call stores no event row yet; rows = %d", n)
	}
	// The re-attaching start (sequence 501) reopens the row.
	start := startEvent(sessionID, agentID, false)
	start.StreamSeq = 501
	if err := p.Process(ctx, start); err != nil {
		t.Fatalf("re-attaching session_start: %v", err)
	}
	if err := p.Process(ctx, lateCall(sessionID, "post_call", 12, 502, false)); err != nil {
		t.Fatalf("redelivered late call: %v", err)
	}
	if got := tokensUsed(t, pool, sessionID); got != 12 {
		t.Fatalf("tokens_used = %d, want 12", got)
	}
}

// Every token-bearing call type waits; on the last delivery the call
// takes the closed-session skip with its event row stored.
func TestProcess_LateTokenBearingCallsWaitThenFallBackToTheSkip(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	for _, eventType := range []string{"post_call", "embeddings", "llm_error"} {
		sessionID := seedClosedRow(t, pool, 500, assembledContext)
		if err := p.Process(ctx, lateCall(sessionID, eventType, 9, 501, false)); !errors.Is(err, consumer.ErrRetryLater) {
			t.Errorf("%s: err = %v, want ErrRetryLater", eventType, err)
		}
		skipsBefore := metrics.Snapshot()[metrics.ReasonClosedSessionSkip]
		if err := p.Process(ctx, lateCall(sessionID, eventType, 9, 501, true)); err != nil {
			t.Errorf("%s on the last delivery: err = %v, want nil", eventType, err)
		}
		if got := metrics.Snapshot()[metrics.ReasonClosedSessionSkip] - skipsBefore; got != 1 {
			t.Errorf("%s on the last delivery: closed-session skips = %d, want 1", eventType, got)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM events WHERE session_id = $1::uuid`, sessionID); n != 1 {
			t.Errorf("%s on the last delivery: event rows = %d, want 1", eventType, n)
		}
		if got := tokensUsed(t, pool, sessionID); got != 0 {
			t.Errorf("%s on the last delivery: tokens_used = %d, want 0", eventType, got)
		}
	}
}

// The redelivery is scoped: a plugin's or sensor's straggler after its
// end, a call without tokens, any other event, a call published before
// the end, and a row whose end sequence is unknown are all handled at
// once, as before.
func TestProcess_ClosedRowRedeliveryIsScoped(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	cases := []struct {
		name      string
		context   string
		closedSeq int64
		event     func(sessionID string) consumer.EventPayload
		tokens    int
	}{
		{"plugin straggler after its end", `{"telemetry":"plugin"}`, 500,
			func(s string) consumer.EventPayload {
				e := lateCall(s, "post_call", 9, 501, false)
				e.ClientType = "claude_code"
				return e
			}, 0},
		{"sensor straggler with no context", `{}`, 500,
			func(s string) consumer.EventPayload {
				e := lateCall(s, "post_call", 9, 501, false)
				e.ClientType = "flightdeck_sensor"
				return e
			}, 0},
		{"llm_error without partial tokens", assembledContext, 500,
			func(s string) consumer.EventPayload { return lateCall(s, "llm_error", 0, 501, false) }, 0},
		{"tool_call after the end", assembledContext, 500,
			func(s string) consumer.EventPayload { return lateCall(s, "tool_call", 0, 501, false) }, 0},
		{"call published before the end", assembledContext, 500,
			func(s string) consumer.EventPayload { return lateCall(s, "post_call", 9, 499, false) }, 9},
		{"end sequence unknown", assembledContext, 0,
			func(s string) consumer.EventPayload { return lateCall(s, "post_call", 9, 501, false) }, 0},
		{"call sequence unknown", assembledContext, 500,
			func(s string) consumer.EventPayload { return lateCall(s, "post_call", 9, 0, false) }, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sessionID := seedClosedRow(t, pool, tc.closedSeq, tc.context)
			if err := p.Process(ctx, tc.event(sessionID)); err != nil {
				t.Fatalf("err = %v, want nil (handled at once)", err)
			}
			if n := countRows(t, pool, `SELECT count(*) FROM events WHERE session_id = $1::uuid`, sessionID); n != 1 {
				t.Errorf("event rows = %d, want 1", n)
			}
			if got := tokensUsed(t, pool, sessionID); got != tc.tokens {
				t.Errorf("tokens_used = %d, want %d", got, tc.tokens)
			}
		})
	}
}

func TestAwaitsReattachment(t *testing.T) {
	tokens := 3
	zero := 0
	call := func(eventType string, tok *int, seq uint64, final bool) consumer.EventPayload {
		return consumer.EventPayload{EventType: eventType, TokensTotal: tok, StreamSeq: seq, FinalDelivery: final}
	}
	cases := []struct {
		name      string
		e         consumer.EventPayload
		closedSeq int64
		assembled bool
		want      bool
	}{
		{"assembled post_call past the end", call("post_call", &tokens, 11, false), 10, true, true},
		{"assembled embeddings past the end", call("embeddings", &tokens, 11, false), 10, true, true},
		{"assembled llm_error with partial tokens", call("llm_error", &tokens, 11, false), 10, true, true},
		{"last delivery", call("post_call", &tokens, 11, true), 10, true, false},
		{"not assembled", call("post_call", &tokens, 11, false), 10, false, false},
		{"zero tokens", call("post_call", &zero, 11, false), 10, true, false},
		{"no tokens", call("llm_error", nil, 11, false), 10, true, false},
		{"heartbeat", call("heartbeat", &tokens, 11, false), 10, true, false},
		{"pre_call", call("pre_call", &tokens, 11, false), 10, true, false},
		{"before the end", call("post_call", &tokens, 9, false), 10, true, false},
		{"at the end", call("post_call", &tokens, 10, false), 10, true, false},
		{"end sequence unknown", call("post_call", &tokens, 11, false), 0, true, false},
		{"call sequence unknown", call("post_call", &tokens, 0, false), 10, true, false},
	}
	for _, tc := range cases {
		if got := awaitsReattachment(tc.e, tc.closedSeq, tc.assembled); got != tc.want {
			t.Errorf("%s: awaitsReattachment = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestCarriesContent(t *testing.T) {
	cases := []struct {
		name string
		e    consumer.EventPayload
		want bool
	}{
		{"has_content", consumer.EventPayload{EventType: "post_call", HasContent: true}, true},
		{"inline MCP content", consumer.EventPayload{EventType: "mcp_resource_read", Content: json.RawMessage(`{"a":1}`)}, true},
		{"plugin tool error text", consumer.EventPayload{EventType: "tool_call", ClientType: "claude_code", Error: json.RawMessage(`{"message":"x"}`)}, true},
		{"sensor tool error", consumer.EventPayload{EventType: "tool_call", ClientType: "flightdeck_sensor", Error: json.RawMessage(`{"message":"x"}`)}, false},
		{"plain post_call", consumer.EventPayload{EventType: "post_call"}, false},
	}
	for _, tc := range cases {
		if got := carriesContent(tc.e); got != tc.want {
			t.Errorf("%s: carriesContent = %v, want %v", tc.name, got, tc.want)
		}
	}
}
