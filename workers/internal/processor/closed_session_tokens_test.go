package processor

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
)

// dbPool connects to the dev database, skipping when none is set.
func dbPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		dsn = os.Getenv("FLIGHTDECK_POSTGRES_URL")
	}
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL or FLIGHTDECK_POSTGRES_URL set; skipping DB test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("postgres unavailable, skipping DB test: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable, skipping DB test: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func randomID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// A run's last post_call and its session_end are published back to
// back; when the worker pool applies the end first, the call's tokens
// must still reach the closed session, and a call published after the
// end must not.
func TestHandlePostCall_ClosedSessionTakesTokensOfACallPublishedBeforeTheEnd(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	sp := NewSessionProcessor(writer.New(pool), pool)
	sessionID := randomID(t)
	endedAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, state, ended_at, last_seen_at, closed_seq, tokens_used)
		VALUES ($1::uuid, 'processor-test', 'coding', 'closed', $2, $2, 500, 0)`, sessionID, endedAt); err != nil {
		t.Fatalf("seed closed session: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, sessionID) })

	tokens := 12
	call := func(seq uint64) consumer.EventPayload {
		return consumer.EventPayload{
			SessionID: sessionID, EventType: "post_call", Flavor: "processor-test",
			TokensTotal: &tokens, StreamSeq: seq,
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
	if err := pool.QueryRow(ctx, `SELECT tokens_used, state, last_seen_at FROM sessions WHERE session_id = $1::uuid`, sessionID).
		Scan(&used, &state, &lastSeen); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if used != 12 {
		t.Errorf("tokens_used = %d, want 12 (the call before the end only)", used)
	}
	if state != "closed" || !lastSeen.Equal(endedAt) {
		t.Errorf("the session must stay closed with last_seen_at untouched: state = %s, last_seen_at = %v", state, lastSeen)
	}
}
