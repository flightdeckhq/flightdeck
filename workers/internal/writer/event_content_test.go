package writer

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// testSession inserts a bare session row (the events and event_content
// foreign keys need one) and removes it with its events afterwards.
func testSession(t *testing.T, db *storage.DB) string {
	t.Helper()
	ctx := context.Background()
	sessionID := newUUID(t)
	if _, err := db.ExecContext(ctx,
		`INSERT INTO sessions (session_id, flavor, agent_type) VALUES ($1, 'writer-test', 'coding')`,
		sessionID); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM event_content WHERE session_id = $1`,
			`DELETE FROM events WHERE session_id = $1`,
			`DELETE FROM sessions WHERE session_id = $1`,
		} {
			if _, err := db.ExecContext(ctx, q, sessionID); err != nil {
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

func countRows(t *testing.T, db *storage.DB, table, sessionID string) int {
	t.Helper()
	var n int
	// table is one of two fixed names from these tests, never input.
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT count(*) FROM `+table+` WHERE session_id = $1`, sessionID).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func TestInsertEventWithContent_WritesEventAndContentTogether(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		sessionID := testSession(t, db)
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
		if err := db.Reader().QueryRowContext(context.Background(),
			`SELECT has_content FROM events WHERE id = $1`, eventID).Scan(&hasContent); err != nil {
			t.Fatalf("read event: %v", err)
		}
		if !hasContent {
			t.Fatal("event row has has_content = false")
		}
		var provider string
		if err := db.Reader().QueryRowContext(context.Background(),
			`SELECT provider FROM event_content WHERE event_id = $1`, eventID).Scan(&provider); err != nil {
			t.Fatalf("read event_content: %v", err)
		}
		if provider != "anthropic" {
			t.Fatalf("event_content.provider = %q, want anthropic", provider)
		}
	})
}

func TestInsertEventWithContent_UnparseableContentWritesNothing(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		sessionID := testSession(t, db)

		_, err := insertWithContent(w, newUUID(t), sessionID, json.RawMessage(`{"messages": [`))
		if !errors.Is(err, ErrEventContent) {
			t.Fatalf("error = %v, want one wrapping ErrEventContent", err)
		}
		if n := countRows(t, db, "events", sessionID); n != 0 {
			t.Fatalf("%d event rows written for content that does not parse", n)
		}
	})
}

// A content row the database rejects must roll the event back with it,
// so no event is left claiming content that does not exist. The
// response column is NOT NULL on both backends; Postgres also refuses a
// NUL byte in text, which SQLite stores.
func TestInsertEventWithContent_RejectedContentRollsBackTheEvent(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		sessionID := testSession(t, db)

		cases := map[string]json.RawMessage{
			"no response": json.RawMessage(`{"provider":"anthropic","messages":[]}`),
		}
		if db.Backend == storage.Postgres {
			cases["NUL byte"] = json.RawMessage(`{"provider":"anthropic","system":"before\u0000after","messages":[],"response":{}}`)
		}
		for name, content := range cases {
			_, err := insertWithContent(w, newUUID(t), sessionID, content)
			if !errors.Is(err, ErrEventContent) {
				t.Fatalf("%s: error = %v, want one wrapping ErrEventContent", name, err)
			}
			if !storage.IsDataError(err) {
				t.Errorf("%s: the refusal is not a data error: %v", name, err)
			}
			if n := countRows(t, db, "events", sessionID); n != 0 {
				t.Fatalf("%s: %d event rows left behind after the content row was rejected", name, n)
			}
			if n := countRows(t, db, "event_content", sessionID); n != 0 {
				t.Fatalf("%s: %d event_content rows written", name, n)
			}
		}
	})
}

// A redelivered event (same sensor id) is a no-op that still reports the
// event id, as InsertEvent's ON CONFLICT path does.
func TestInsertEventWithContent_RedeliveryIsIdempotent(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		sessionID := testSession(t, db)
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
		if n := countRows(t, db, "events", sessionID); n != 1 {
			t.Fatalf("%d event rows, want 1", n)
		}
		if n := countRows(t, db, "event_content", sessionID); n != 1 {
			t.Fatalf("%d event_content rows, want 1", n)
		}
	})
}

// An event without a client-minted id gets one from the writer, in the
// canonical form both backends store; an upper-case id is stored lower
// case and found again by either spelling.
func TestInsertEvent_IDsAreCanonical(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		sessionID := testSession(t, db)
		ctx := context.Background()

		minted, err := w.InsertEvent(ctx, EventRow{SessionID: sessionID, Flavor: "writer-test", EventType: "heartbeat", OccurredAt: time.Now().UTC()})
		if err != nil {
			t.Fatalf("insert without id: %v", err)
		}
		if !eventIDPattern.MatchString(minted) || minted != canonicalUUID(minted) {
			t.Errorf("minted id %q is not a canonical lower-case uuid", minted)
		}
		upper := "ABCDEF01-2345-4678-89AB-CDEF01234567"
		got, err := w.InsertEvent(ctx, EventRow{SensorEventID: upper, SessionID: sessionID, Flavor: "writer-test", EventType: "heartbeat", OccurredAt: time.Now().UTC()})
		if err != nil {
			t.Fatalf("insert with an upper-case id: %v", err)
		}
		if got != canonicalUUID(upper) {
			t.Errorf("stored id = %q, want %q", got, canonicalUUID(upper))
		}
		for _, lookup := range []string{upper, canonicalUUID(upper)} {
			exists, err := w.EventExists(ctx, lookup)
			if err != nil || !exists {
				t.Errorf("EventExists(%q) = %v, %v; want true", lookup, exists, err)
			}
		}
	})
}

// The token and cost columns round-trip; empty strings and nil pointers
// are stored as NULL.
func TestInsertEvent_TokenCostColumns(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		sessionID := testSession(t, db)
		w, _ := newTestWriter(db)
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
			if err := db.Reader().QueryRowContext(ctx, `
				SELECT tokens_reasoning, model_requested, model_served, provider,
				       billing_mode, platform, CAST(cost_reported AS DOUBLE PRECISION), cost_source
				FROM events WHERE id = $1`, id).Scan(
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
	})
}

func ptr(s string) *string { return &s }

func TestAddTokensBeforeEnd_OnlyACallPublishedBeforeTheEnd(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		sessionID := testSession(t, db)
		if _, err := db.ExecContext(ctx, `UPDATE sessions SET state = 'closed', ended_at = `+db.Dialect.Now()+`, closed_seq = 100, tokens_used = 5 WHERE session_id = $1`, sessionID); err != nil {
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
		if err := db.Reader().QueryRowContext(ctx, `SELECT tokens_used, state FROM sessions WHERE session_id = $1`, sessionID).Scan(&tokens, &state); err != nil {
			t.Fatalf("read session: %v", err)
		}
		if tokens != 15 || state != "closed" {
			t.Errorf("tokens_used = %d, state = %s; want 15, closed", tokens, state)
		}

		open := testSession(t, db)
		if added, err := w.AddTokensBeforeEnd(ctx, open, 1, 10); err != nil || added {
			t.Errorf("an open session must take tokens through the normal path: added = %v, %v", added, err)
		}
	})
}
