package writer

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newUUID returns a random version-4 UUID string.
func newUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("random uuid: %v", err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// These tests run against a real Postgres with the migrations applied
// and skip cleanly when no TEST_POSTGRES_URL / FLIGHTDECK_POSTGRES_URL
// is set or the database is unreachable.

func testPool(t *testing.T) *pgxpool.Pool {
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

// testSession inserts a bare session row (the events and event_content
// foreign keys need one) and removes it with its events afterwards.
func testSession(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	sessionID := newUUID(t)
	if _, err := pool.Exec(ctx,
		`INSERT INTO sessions (session_id, flavor, agent_type) VALUES ($1::uuid, 'writer-test', 'coding')`,
		sessionID); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM event_content WHERE session_id = $1::uuid`,
			`DELETE FROM events WHERE session_id = $1::uuid`,
			`DELETE FROM sessions WHERE session_id = $1::uuid`,
		} {
			if _, err := pool.Exec(ctx, q, sessionID); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
	})
	return sessionID
}

func insertWithContent(w *Writer, eventID, sessionID string, content json.RawMessage) (string, error) {
	return w.InsertEventWithContent(
		context.Background(), eventID, sessionID, "writer-test", "post_call", "claude-sonnet-4-6",
		nil, nil, nil, nil, nil, nil, nil, true, time.Now().UTC(), nil, content,
	)
}

func countRows(t *testing.T, pool *pgxpool.Pool, table, sessionID string) int {
	t.Helper()
	var n int
	// table is one of two fixed names from these tests, never input.
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM `+table+` WHERE session_id = $1::uuid`, sessionID).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func TestInsertEventWithContent_WritesEventAndContentTogether(t *testing.T) {
	pool := testPool(t)
	w := New(pool)
	sessionID := testSession(t, pool)
	eventID := newUUID(t)

	got, err := insertWithContent(w, eventID, sessionID,
		json.RawMessage(`{"provider":"anthropic","model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}],"response":{"content":"hello"}}`))
	if err != nil {
		t.Fatalf("InsertEventWithContent: %v", err)
	}
	if got != eventID {
		t.Fatalf("event id = %q, want the sensor-minted %q", got, eventID)
	}
	var hasContent bool
	if err := pool.QueryRow(context.Background(),
		`SELECT has_content FROM events WHERE id = $1::uuid`, eventID).Scan(&hasContent); err != nil {
		t.Fatalf("read event: %v", err)
	}
	if !hasContent {
		t.Fatal("event row has has_content = false")
	}
	var provider string
	if err := pool.QueryRow(context.Background(),
		`SELECT provider FROM event_content WHERE event_id = $1::uuid`, eventID).Scan(&provider); err != nil {
		t.Fatalf("read event_content: %v", err)
	}
	if provider != "anthropic" {
		t.Fatalf("event_content.provider = %q, want anthropic", provider)
	}
}

func TestInsertEventWithContent_UnparseableContentWritesNothing(t *testing.T) {
	pool := testPool(t)
	w := New(pool)
	sessionID := testSession(t, pool)

	_, err := insertWithContent(w, newUUID(t), sessionID, json.RawMessage(`{"messages": [`))
	if !errors.Is(err, ErrEventContent) {
		t.Fatalf("error = %v, want one wrapping ErrEventContent", err)
	}
	if n := countRows(t, pool, "events", sessionID); n != 0 {
		t.Fatalf("%d event rows written for content that does not parse", n)
	}
}

// A content row Postgres rejects (text cannot hold a NUL byte) must roll
// the event back with it, so no event is left claiming content that
// does not exist.
func TestInsertEventWithContent_RejectedContentRollsBackTheEvent(t *testing.T) {
	pool := testPool(t)
	w := New(pool)
	sessionID := testSession(t, pool)

	_, err := insertWithContent(w, newUUID(t), sessionID,
		json.RawMessage(`{"provider":"anthropic","system":"before\u0000after","messages":[],"response":{}}`))
	if !errors.Is(err, ErrEventContent) {
		t.Fatalf("error = %v, want one wrapping ErrEventContent", err)
	}
	// The rejection must be the NUL byte itself (SQLSTATE 22021,
	// character_not_in_repertoire), not some other constraint.
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "22021" {
		t.Fatalf("error = %v, want Postgres rejecting the NUL byte (SQLSTATE 22021)", err)
	}
	if n := countRows(t, pool, "events", sessionID); n != 0 {
		t.Fatalf("%d event rows left behind after the content row was rejected", n)
	}
	if n := countRows(t, pool, "event_content", sessionID); n != 0 {
		t.Fatalf("%d event_content rows written", n)
	}
}

// A redelivered event (same sensor id) is a no-op that still reports the
// event id, as InsertEvent's ON CONFLICT path does.
func TestInsertEventWithContent_RedeliveryIsIdempotent(t *testing.T) {
	pool := testPool(t)
	w := New(pool)
	sessionID := testSession(t, pool)
	eventID := newUUID(t)
	content := json.RawMessage(`{"provider":"anthropic","messages":[],"response":{}}`)
	occurredAt := time.Now().UTC()

	for i := 0; i < 2; i++ {
		got, err := w.InsertEventWithContent(
			context.Background(), eventID, sessionID, "writer-test", "post_call", "",
			nil, nil, nil, nil, nil, nil, nil, true, occurredAt, nil, content,
		)
		if err != nil {
			t.Fatalf("attempt %d: %v", i+1, err)
		}
		if got != eventID {
			t.Fatalf("attempt %d: event id = %q, want %q", i+1, got, eventID)
		}
	}
	if n := countRows(t, pool, "events", sessionID); n != 1 {
		t.Fatalf("%d event rows, want 1", n)
	}
	if n := countRows(t, pool, "event_content", sessionID); n != 1 {
		t.Fatalf("%d event_content rows, want 1", n)
	}
}
