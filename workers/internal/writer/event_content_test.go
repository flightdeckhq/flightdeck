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
	return w.InsertEventWithContent(context.Background(), EventRow{
		SensorEventID: eventID, SessionID: sessionID, Flavor: "writer-test",
		EventType: "post_call", Model: "claude-sonnet-4-6",
		HasContent: true, OccurredAt: time.Now().UTC(),
	}, content)
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
		got, err := w.InsertEventWithContent(context.Background(), EventRow{
			SensorEventID: eventID, SessionID: sessionID, Flavor: "writer-test",
			EventType: "post_call", HasContent: true, OccurredAt: occurredAt,
		}, content)
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

func TestPermanentContentError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"NUL byte in text (22021)", &pgconn.PgError{Code: "22021"}, true},
		{"not-null violation (23502)", &pgconn.PgError{Code: "23502"}, true},
		{"program limit (54000)", &pgconn.PgError{Code: "54000"}, true},
		{"wrapped data exception", fmt.Errorf("insert event content: %w", &pgconn.PgError{Code: "22P05"}), true},
		{"statement timeout (57014)", &pgconn.PgError{Code: "57014"}, false},
		{"serialization failure (40001)", &pgconn.PgError{Code: "40001"}, false},
		{"deadlock (40P01)", &pgconn.PgError{Code: "40P01"}, false},
		{"connection error", errors.New("conn closed"), false},
	}
	for _, c := range cases {
		if got := permanentContentError(c.err); got != c.want {
			t.Errorf("%s: permanentContentError = %v, want %v", c.name, got, c.want)
		}
	}
}

// The token and cost columns round-trip; empty strings and nil pointers
// are stored as NULL.
func TestInsertEvent_TokenCostColumns(t *testing.T) {
	pool := testPool(t)
	sessionID := testSession(t, pool)
	w := New(pool)
	ctx := context.Background()

	reasoning := int64(40)
	cost := 0.0125
	withFields, err := w.InsertEvent(ctx, EventRow{
		SessionID: sessionID, Flavor: "writer-test", EventType: "post_call",
		Model: "claude-sonnet-4-5", TokensReasoning: &reasoning,
		ModelRequested: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		ModelServed:    "claude-sonnet-4-5-20250929",
		Provider:       "anthropic", BillingMode: "metered", Platform: "bedrock",
		CostReported: &cost, CostSource: "agent",
		OccurredAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("insert with fields: %v", err)
	}
	without, err := w.InsertEvent(ctx, EventRow{
		SessionID: sessionID, Flavor: "writer-test", EventType: "post_call",
		OccurredAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("insert without fields: %v", err)
	}

	var (
		gotReasoning                                     *int64
		gotRequested, gotServed, gotProvider, gotBilling *string
		gotPlatform, gotSource                           *string
		gotCost                                          *float64
	)
	read := func(id string) {
		t.Helper()
		if err := pool.QueryRow(ctx, `
			SELECT tokens_reasoning, model_requested, model_served, provider,
			       billing_mode, platform, cost_reported::float8, cost_source
			FROM events WHERE id = $1::uuid`, id).Scan(
			&gotReasoning, &gotRequested, &gotServed, &gotProvider,
			&gotBilling, &gotPlatform, &gotCost, &gotSource,
		); err != nil {
			t.Fatalf("read event %s: %v", id, err)
		}
	}

	read(withFields)
	if gotReasoning == nil || *gotReasoning != 40 {
		t.Errorf("tokens_reasoning = %v, want 40", gotReasoning)
	}
	for name, pair := range map[string][2]*string{
		"model_requested": {gotRequested, ptr("us.anthropic.claude-sonnet-4-5-20250929-v1:0")},
		"model_served":    {gotServed, ptr("claude-sonnet-4-5-20250929")},
		"provider":        {gotProvider, ptr("anthropic")},
		"billing_mode":    {gotBilling, ptr("metered")},
		"platform":        {gotPlatform, ptr("bedrock")},
		"cost_source":     {gotSource, ptr("agent")},
	} {
		if pair[0] == nil || *pair[0] != *pair[1] {
			t.Errorf("%s = %v, want %q", name, pair[0], *pair[1])
		}
	}
	if gotCost == nil || *gotCost != 0.0125 {
		t.Errorf("cost_reported = %v, want 0.0125", gotCost)
	}

	read(without)
	if gotReasoning != nil || gotRequested != nil || gotServed != nil || gotProvider != nil ||
		gotBilling != nil || gotPlatform != nil || gotCost != nil || gotSource != nil {
		t.Error("absent token and cost fields must be stored as NULL")
	}
}

func ptr(s string) *string { return &s }

func TestAddTokensBeforeEnd_OnlyACallPublishedBeforeTheEnd(t *testing.T) {
	pool := testPool(t)
	w := New(pool)
	ctx := context.Background()
	sessionID := testSession(t, pool)
	if _, err := pool.Exec(ctx, `UPDATE sessions SET state = 'closed', ended_at = NOW(), closed_seq = 100, tokens_used = 5 WHERE session_id = $1::uuid`, sessionID); err != nil {
		t.Fatalf("close session: %v", err)
	}

	for _, tc := range []struct {
		name string
		seq  uint64
		want bool
	}{
		{"published before the end", 99, true},
		{"published after the end", 101, false},
		{"the end itself", 100, false},
		{"unknown sequence", 0, false},
	} {
		added, err := w.AddTokensBeforeEnd(ctx, sessionID, tc.seq, 10)
		if err != nil || added != tc.want {
			t.Errorf("%s: added = %v, %v; want %v", tc.name, added, err, tc.want)
		}
	}
	var tokens int
	var state string
	if err := pool.QueryRow(ctx, `SELECT tokens_used, state FROM sessions WHERE session_id = $1::uuid`, sessionID).Scan(&tokens, &state); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if tokens != 15 || state != "closed" {
		t.Errorf("tokens_used = %d, state = %s; want 15, closed", tokens, state)
	}

	open := testSession(t, pool)
	if added, err := w.AddTokensBeforeEnd(ctx, open, 1, 10); err != nil || added {
		t.Errorf("an open session must take tokens through the normal path: added = %v, %v", added, err)
	}
}
