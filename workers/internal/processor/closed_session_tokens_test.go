package processor

import (
	"context"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// A run's last post_call and its session_end are published back to
// back; when the worker pool applies the end first, the call's tokens
// must still reach the closed session, and a call published after the
// end must not.
func TestHandlePostCall_ClosedSessionTakesTokensOfACallPublishedBeforeTheEnd(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		agentID := seedAgent(t, db, "coding", "flightdeck_sensor", "processor-test")
		sessionID := seedClosedSession(t, db, agentID, 500)
		endedAt := sessionEndedAt(t, db, sessionID)

		tokens := 12
		call := func(seq uint64) consumer.EventPayload {
			return consumer.EventPayload{
				SessionID: sessionID, AgentID: agentID, EventType: "post_call",
				Flavor: "processor-test", TokensTotal: &tokens, StreamSeq: seq,
			}
		}
		if err := sp.HandlePostCall(ctx, call(499)); err != nil {
			t.Fatalf("post_call before the end: %v", err)
		}
		if err := sp.HandlePostCall(ctx, call(501)); err != nil {
			t.Fatalf("post_call after the end: %v", err)
		}

		var used int
		var state string
		var lastSeen time.Time
		if err := db.Reader().QueryRowContext(ctx, `SELECT tokens_used, state, last_seen_at FROM sessions WHERE session_id = $1`, sessionID).
			Scan(&used, &state, &lastSeen); err != nil {
			t.Fatalf("read session: %v", err)
		}
		if used != 12 {
			t.Errorf("tokens_used = %d, want 12 (the call before the end only)", used)
		}
		if state != "closed" || !lastSeen.Equal(endedAt) {
			t.Errorf("the session must stay closed with last_seen_at untouched: state = %s, last_seen_at = %v", state, lastSeen)
		}
		var agentTokens int64
		if err := db.Reader().QueryRowContext(ctx, `SELECT total_tokens FROM agents WHERE agent_id = $1`, agentID).Scan(&agentTokens); err != nil {
			t.Fatalf("read agent: %v", err)
		}
		if agentTokens != 12 {
			t.Errorf("agent total_tokens = %d, want 12 (rolled up with the session)", agentTokens)
		}
	})
}

// A session closed without a recorded end sequence (the reconciler's
// orphan close, or a stream recreate that cleared it) cannot order a
// late call, so the call is skipped as before.
func TestHandlePostCall_ClosedSessionWithoutAnEndSequenceSkipsTheCall(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		sessionID := seedClosedSession(t, db, "", 0)

		tokens := 12
		if err := sp.HandlePostCall(ctx, consumer.EventPayload{
			SessionID: sessionID, EventType: "post_call", Flavor: "processor-test",
			TokensTotal: &tokens, StreamSeq: 10,
		}); err != nil {
			t.Fatalf("post_call: %v", err)
		}
		if used := tokensUsed(t, db, sessionID); used != 0 {
			t.Errorf("tokens_used = %d, want 0", used)
		}
	})
}

// seedClosedSession inserts a session closed a minute ago with the given
// end sequence (0 stores NULL) and agent (empty stores NULL).
func seedClosedSession(t *testing.T, db *storage.DB, agentID string, closedSeq int64) string {
	t.Helper()
	ctx := context.Background()
	sessionID := randomID(t)
	endedAt := minutesAgo(1)
	var agent, seq any
	if agentID != "" {
		agent = agentID
	}
	if closedSeq != 0 {
		seq = closedSeq
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO sessions (session_id, agent_id, flavor, agent_type, state, ended_at, last_seen_at, closed_seq, tokens_used)
		VALUES ($1, $2, 'processor-test', 'coding', 'closed', $3, $3, $4, 0)`,
		sessionID, agent, endedAt, seq); err != nil {
		t.Fatalf("seed closed session: %v", err)
	}
	cleanupSession(t, db, sessionID)
	return sessionID
}

func sessionEndedAt(t *testing.T, db *storage.DB, sessionID string) time.Time {
	t.Helper()
	var endedAt time.Time
	if err := db.Reader().QueryRowContext(context.Background(), `SELECT ended_at FROM sessions WHERE session_id = $1`, sessionID).Scan(&endedAt); err != nil {
		t.Fatalf("read ended_at: %v", err)
	}
	return endedAt
}
