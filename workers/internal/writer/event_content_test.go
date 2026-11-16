package writer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
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

// The content's system is read by its JSON type: text, a list of content
// blocks, or nothing; a value of any other type is dropped alone, and
// never makes the rest of the content unreadable.
func TestParseEventContent_SystemByJSONType(t *testing.T) {
	cases := []struct {
		name, system string // "" leaves the key out
		text         *string
		blocks       string
		dropped      string
	}{
		{name: "absent"},
		{name: "null", system: `null`},
		{name: "text", system: `"be brief"`, text: ptr("be brief")},
		{name: "empty text", system: `""`, text: ptr("")},
		{name: "text that reads as JSON", system: `"[{\"type\":\"text\",\"text\":\"x\"}]"`, text: ptr(`[{"type":"text","text":"x"}]`)},
		{name: "blocks", system: `[{"type":"text","text":"be brief","cache_control":{"type":"ephemeral"}}]`,
			blocks: `[{"type":"text","text":"be brief","cache_control":{"type":"ephemeral"}}]`},
		{name: "empty list", system: ` [] `, blocks: `[]`},
		{name: "object", system: `{"type":"text","text":"be brief"}`, dropped: "object"},
		{name: "number", system: `42`, dropped: "number"},
		{name: "negative number", system: `-1.5e3`, dropped: "number"},
		{name: "boolean", system: `true`, dropped: "boolean"},
	}
	for _, tc := range cases {
		blob := `{"provider":"anthropic","model":"m","messages":[{"role":"user","content":"hi"}],"response":{}`
		if tc.system != "" {
			blob += `,"system":` + tc.system
		}
		blob += `}`
		c, err := parseEventContent(json.RawMessage(blob))
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if (c.System.text == nil) != (tc.text == nil) || (c.System.text != nil && *c.System.text != *tc.text) {
			t.Errorf("%s: text = %v, want %v", tc.name, c.System.text, tc.text)
		}
		if string(c.System.blocks) != tc.blocks {
			t.Errorf("%s: blocks = %q, want %q", tc.name, c.System.blocks, tc.blocks)
		}
		if c.System.dropped != tc.dropped {
			t.Errorf("%s: dropped = %q, want %q", tc.name, c.System.dropped, tc.dropped)
		}
		if string(c.Messages) != `[{"role":"user","content":"hi"}]` {
			t.Errorf("%s: the rest of the content was not read: messages = %s", tc.name, c.Messages)
		}
	}
}

// storedSystem reads an event's two system columns: system_prompt as
// text, system_blocks as its JSON text, each nil when NULL.
func storedSystem(t *testing.T, db *storage.DB, eventID string) (text, blocks *string) {
	t.Helper()
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT system_prompt, CAST(system_blocks AS TEXT) FROM event_content WHERE event_id = $1`, eventID,
	).Scan(&text, &blocks); err != nil {
		t.Fatalf("read event_content: %v", err)
	}
	return text, blocks
}

// A system given as text is stored in system_prompt, one given as a list
// of content blocks in system_blocks as that list (cache_control and
// every other key kept); a row holds at most one. A system of another
// JSON type is left out and the rest of the content is stored, with a
// warning that names the type and never the value.
func TestInsertEventWithContent_SystemColumnByJSONType(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		sessionID := testSession(t, db)
		var logs bytes.Buffer
		previous := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
		t.Cleanup(func() { slog.SetDefault(previous) })

		const blocks = `[{"type":"text","text":"You are terse. SECRET-BLOCK","cache_control":{"type":"ephemeral"}},{"type":"text","text":"Answer in one word."}]`
		cases := []struct {
			name, system string
			wantText     *string
			wantBlocks   []any
		}{
			{name: "text", system: `"You are terse."`, wantText: ptr("You are terse.")},
			{name: "text that reads as JSON", system: `"[{\"type\":\"text\"}]"`, wantText: ptr(`[{"type":"text"}]`)},
			{name: "blocks", system: blocks, wantBlocks: []any{
				map[string]any{"type": "text", "text": "You are terse. SECRET-BLOCK", "cache_control": map[string]any{"type": "ephemeral"}},
				map[string]any{"type": "text", "text": "Answer in one word."},
			}},
			{name: "null", system: `null`},
			{name: "object", system: `{"type":"text","text":"SECRET-OBJECT"}`},
		}
		for _, tc := range cases {
			eventID := newUUID(t)
			_, err := insertWithContent(w, eventID, sessionID, json.RawMessage(
				`{"provider":"anthropic","model":"claude-haiku-4-5","system":`+tc.system+
					`,"messages":[{"role":"user","content":"hi"}],"response":{"content":[]}}`))
			if err != nil {
				t.Fatalf("%s: InsertEventWithContent: %v", tc.name, err)
			}
			text, stored := storedSystem(t, db, eventID)
			if (text == nil) != (tc.wantText == nil) || (text != nil && *text != *tc.wantText) {
				t.Errorf("%s: system_prompt = %v, want %v", tc.name, text, tc.wantText)
			}
			if tc.wantBlocks == nil {
				if stored != nil {
					t.Errorf("%s: system_blocks = %s, want NULL", tc.name, *stored)
				}
			} else {
				var got []any
				if stored == nil || json.Unmarshal([]byte(*stored), &got) != nil || !reflect.DeepEqual(got, tc.wantBlocks) {
					t.Errorf("%s: system_blocks = %v, want the list as sent", tc.name, stored)
				}
			}
			var hasContent bool
			var messages string
			if err := db.Reader().QueryRowContext(context.Background(), `
				SELECT e.has_content, CAST(c.messages AS TEXT)
				FROM events e JOIN event_content c ON c.event_id = e.id
				WHERE e.id = $1`, eventID).Scan(&hasContent, &messages); err != nil {
				t.Fatalf("%s: read event: %v", tc.name, err)
			}
			if !hasContent || !strings.Contains(messages, `"hi"`) {
				t.Errorf("%s: has_content = %v, messages = %s; want the rest of the content stored", tc.name, hasContent, messages)
			}
		}
		out := logs.String()
		if strings.Count(out, "neither text nor a list of content blocks") != 1 ||
			!strings.Contains(out, "json_type=object") || !strings.Contains(out, "event_type=post_call") {
			t.Errorf("want one warning naming the dropped system's JSON type, got:\n%s", out)
		}
		if strings.Contains(out, "SECRET") {
			t.Errorf("a log line carries captured content:\n%s", out)
		}
	})
}

// The database refuses a system_blocks that is not a list, and a row
// with both system columns set: the writer never writes either, and the
// checks keep a direct write from breaking the one-form rule.
func TestEventContent_SystemColumnChecks(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		sessionID := testSession(t, db)
		insert := func(text any, blocks any) error {
			_, err := db.ExecContext(context.Background(), `
				INSERT INTO event_content (event_id, session_id, provider, model, system_prompt, system_blocks, messages, response)
				VALUES ($1, $2, 'anthropic', 'm', $3, $4, '[]', '{}')`, newUUID(t), sessionID, text, blocks)
			return err
		}
		if err := insert(nil, `[{"type":"text","text":"x"}]`); err != nil {
			t.Fatalf("a list: %v", err)
		}
		if err := insert("x", nil); err != nil {
			t.Fatalf("text: %v", err)
		}
		for name, err := range map[string]error{
			"an object":    insert(nil, `{"type":"text","text":"x"}`),
			"a string":     insert(nil, `"x"`),
			"both columns": insert("x", `[{"type":"text","text":"x"}]`),
		} {
			if err == nil || !storage.IsDataError(err) {
				t.Errorf("%s in system_blocks: err = %v, want a check violation", name, err)
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
