package processor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// The equivalence test drives one fixed sequence through the worker on
// both backends in one run, dumps the rows each left in a normalised
// shape and asserts the dumps are identical. It is the pinned proof
// that the two query sets agree, beyond the per-feature tests, so it
// opens the backends itself rather than through storagetest.Each
// (which runs one backend per process): SQLite always, Postgres when
// TEST_POSTGRES_URL is set, which both passes of
// scripts/go-db-tests.sh provide.
//
// Two differences between the engines are normalised away on purpose
// and documented in ARCHITECTURE.md (Worker / Event Processing →
// Database access): JSON key order (Postgres jsonb reorders keys and
// SQLite stores the text as written, so documents are compared as
// decoded values), and timestamp precision (Postgres keeps
// microseconds, SQLite milliseconds, so timestamps are compared as
// millisecond offsets from the sequence's reference time). Two more are
// properties of the run, not of the engine: ids differ per run and are
// replaced by their role names (event ids by their position in the
// sequence), wherever they appear, payload JSON included; and a time
// the database's clock wrote (last_seen_at, a non-assembled session's
// started_at and ended_at) depends on when the run happened, so such a
// time is reduced to "clock" when it falls inside the run's window.

// The sequence reaches every path the two query sets spell
// differently: the session_start upsert's framework append on a lazily
// created row (parent), UpdateSessionFromCall's append on a row whose
// start carried no framework (late), the context upgrade and the MCP
// server append, a parent marked stale by the reconciler and revived
// by its child's event, a session marked stale, then lost, then reaped
// with a synthetic session_end, an assembled OpenTelemetry session
// whose start and end date the row, a failed stream's partial tokens,
// a re-sent event, and a model-id backfill over a legacy row.
func equivalenceEvents(ids map[string]string, t0 time.Time) (before, revive, after []consumer.EventPayload) {
	at := func(secs int) string { return t0.Add(time.Duration(secs) * time.Second).Format(time.RFC3339Nano) }
	base := func(session, eventType string, secs int) consumer.EventPayload {
		return consumer.EventPayload{
			SessionID: ids[session], EventType: eventType, Flavor: "equivalence",
			AgentID: ids["agent"], AgentType: "coding", ClientType: "flightdeck_sensor",
			AgentName: "equivalence-agent", User: "test", Hostname: "test-host",
			Host: "test-host", Timestamp: at(secs), CapturePrompts: true, StreamSeq: uint64(secs + 1),
		}
	}
	child := func(eventType string, secs int) consumer.EventPayload {
		e := base("child", eventType, secs)
		e.AgentID, e.AgentName = ids["child_agent"], "equivalence-child"
		e.ParentSessionID, e.AgentRole = strings.ToUpper(ids["parent"]), "researcher"
		return e
	}
	otel := func(eventType string, secs int) consumer.EventPayload {
		e := base("otel", eventType, secs)
		e.ClientType, e.AgentType = "otlp", "production"
		e.AgentID, e.AgentName = ids["otel_agent"], "equivalence-otel"
		return e
	}
	tok := func(e *consumer.EventPayload, in, out int) {
		total := in + out
		e.TokensInput, e.TokensOutput, e.TokensTotal = &in, &out, &total
	}

	cs := child("session_start", 0)
	cs.Context = map[string]interface{}{"os": "Linux", "frameworks": []string{"claude_agent_sdk/0.2.1"}}
	c1 := base("parent", "post_call", 1)
	c1.Framework, c1.Model = "langchain", "gpt-4o-mini"
	tok(&c1, 100, 20)
	ps := base("parent", "session_start", 2)
	ps.Context = map[string]interface{}{"os": "Linux", "python_version": "3.12", "hostname": "test-host"}
	c2 := base("parent", "post_call", 3)
	c2.ID, c2.Framework, c2.Model = ids["call"], "langchain", "gpt-4o-mini"
	tok(&c2, 200, 30)
	c2.HasContent = true
	c2.Content = json.RawMessage(`{"provider":"openai","model":"gpt-4o-mini","messages":[{"role":"user","content":"equivalence"}],"response":{"choices":[]}}`)
	c2dup := c2
	c2dup.Timestamp = at(4)
	tc := base("parent", "tool_call", 5)
	name := "search"
	tc.ToolName = &name
	mcp := base("parent", "mcp_server_attached", 6)
	mcp.ServerName, mcp.ServerURLCanonical, mcp.Transport = "fs", "stdio://fs", "stdio"
	mcp2 := mcp
	mcp2.Timestamp = at(7)
	failed := base("parent", "llm_error", 8)
	failed.Model = "gpt-4o-mini"
	failed.Error = json.RawMessage(`{"error_type":"stream_error","partial_tokens_input":40,"partial_tokens_output":2}`)

	ls := base("late", "session_start", 9)
	ls.Context = map[string]interface{}{"os": "Linux"}
	lc := base("late", "post_call", 10)
	lc.Framework, lc.Model = "agno", "gpt-4o-mini"
	tok(&lc, 7, 3)
	lc2 := base("late", "post_call", 11)
	lc2.Framework, lc2.Model = "agno", "gpt-4o-mini"
	tok(&lc2, 7, 3)

	os_ := otel("session_start", 20)
	os_.Context = map[string]interface{}{"telemetry": "otlp", "otel_trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"}
	oc := otel("post_call", 30)
	oc.Model = "claude-sonnet-4-6"
	tok(&oc, 50, 5)
	oe := otel("session_end", 40)

	is := base("idle", "session_start", 12)
	is.Context = map[string]interface{}{"os": "Linux"}
	lg := base("legacy", "session_start", 13)

	before = []consumer.EventPayload{cs, c1, ps, c2, c2dup, tc, mcp, mcp2, failed, ls, lc, lc2, os_, oc, oe, is, lg}

	// The child's call after the reconciler marked the parent stale.
	cc := child("post_call", 50)
	cc.Model = "gpt-4o-mini"
	tok(&cc, 10, 5)
	revive = []consumer.EventPayload{cc}

	after = []consumer.EventPayload{child("session_end", 60), base("parent", "session_end", 61)}
	return before, revive, after
}

// equivalenceLead is how long before the run the sequence's first event
// is dated. The sequence spans a little over a minute (its last event is
// dated 61s after t0), and a time reads as "clock" when it falls in the
// run's window, which opens at the first database-clock read after t0 is
// taken. A lead of one minute put the 60s and 61s events at the run's
// own start, so whether the child's session_end (60s) counted as an
// event-dated time or as "clock" depended on how many milliseconds the
// first clock read took: a slow read on one backend and not the other
// made the dumps disagree. The lead must exceed the span of the
// sequence by more than any run could take; ten minutes does, and
// stays well inside the reconciler thresholds the test drives by
// backdating last_seen_at explicitly.
const equivalenceLead = 10 * time.Minute

// equivalenceDump is the normalised state of the rows the run wrote.
type equivalenceDump struct {
	Sessions []map[string]any `json:"sessions"`
	Events   []map[string]any `json:"events"`
	Content  []map[string]any `json:"event_content"`
	Agents   []map[string]any `json:"agents"`
}

// runEquivalence drives the sequence on db and returns the normalised
// dump, after the per-backend expectations the sequence implies have
// been checked, so a single-backend run fails for the right reason too.
func runEquivalence(t *testing.T, db *storage.DB) equivalenceDump {
	t.Helper()
	ctx := context.Background()
	ids := map[string]string{
		"agent": randomID(t), "child_agent": randomID(t), "otel_agent": randomID(t),
		"parent": randomID(t), "child": randomID(t), "late": randomID(t),
		"otel": randomID(t), "idle": randomID(t), "legacy": randomID(t), "call": randomID(t),
	}
	for _, k := range []string{"agent", "child_agent", "otel_agent"} {
		id := ids[k]
		t.Cleanup(func() { _, _ = db.ExecContext(context.Background(), `DELETE FROM agents WHERE agent_id = $1`, id) })
	}
	// The child references the parent: registered after it, removed first.
	for _, k := range []string{"parent", "late", "otel", "idle", "legacy", "child"} {
		cleanupSession(t, db, ids[k])
	}
	p := newTestProcessor(db)
	// The events are dated from t0, well before the run, so a time the
	// database's clock wrote is told apart from an event-dated one.
	t0 := time.Now().UTC().Add(-equivalenceLead).Truncate(time.Millisecond)
	from := databaseNow(t, db).Add(-time.Millisecond)
	process := func(events []consumer.EventPayload) {
		t.Helper()
		for i, e := range events {
			if err := p.Process(ctx, e); err != nil {
				t.Fatalf("%s event %d (%s): %v", db.Backend, i, e.EventType, err)
			}
		}
	}
	backdate := func(session string, ts time.Time) {
		t.Helper()
		if _, err := db.ExecContext(ctx, `UPDATE sessions SET last_seen_at = $2 WHERE session_id = $1`, ids[session], ts); err != nil {
			t.Fatal(err)
		}
	}
	state := func(session string) string {
		t.Helper()
		var s string
		if err := db.Reader().QueryRowContext(ctx, `SELECT state FROM sessions WHERE session_id = $1`, ids[session]).Scan(&s); err != nil {
			t.Fatalf("state of %s: %v", session, err)
		}
		return s
	}
	before, revive, after := equivalenceEvents(ids, t0)
	process(before)

	// The reconciler marks the silent parent and idle sessions stale;
	// the child's next call revives the parent, while idle goes lost and
	// is reaped as an orphan with a synthetic session_end.
	backdate("parent", t0.Add(-3*time.Minute))
	backdate("idle", t0.Add(-3*time.Minute))
	if err := p.w.ReconcileStaleSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := state("parent"); got != "stale" {
		t.Fatalf("%s: parent after the reconciler = %q, want stale", db.Backend, got)
	}
	process(revive)
	if got := state("parent"); got != "active" {
		t.Errorf("%s: parent after its child's call = %q, want active (revived)", db.Backend, got)
	}
	backdate("idle", t0.Add(-31*time.Minute))
	if err := p.w.ReconcileStaleSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := state("idle"); got != "lost" {
		t.Fatalf("%s: idle after the second pass = %q, want lost", db.Backend, got)
	}
	backdate("idle", t0.Add(-2*time.Hour))
	if n, err := p.w.ReapOrphanedLostSessions(ctx, time.Hour); err != nil || n != 1 {
		t.Fatalf("%s: reap = %d, %v; want 1", db.Backend, n, err)
	}
	process(after)

	// A legacy row (raw model, no model_requested) for the backfill.
	if _, err := db.ExecContext(ctx, `
		INSERT INTO events (session_id, flavor, event_type, model, payload, occurred_at)
		VALUES ($1, 'equivalence', 'post_call', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', $2, $3)`,
		ids["legacy"], `{"provider_metadata":{"platform":"bedrock"}}`, t0.Add(14*time.Second)); err != nil {
		t.Fatal(err)
	}
	p.w.RunModelBackfill(ctx)
	to := databaseNow(t, db).Add(time.Millisecond)

	d := dumpEquivalence(t, db, ids, t0, from, to)
	if len(d.Sessions) != 6 || len(d.Events) != 21 || len(d.Content) != 1 || len(d.Agents) != 3 {
		t.Fatalf("%s rows: %d sessions, %d events, %d content, %d agents; want 6, 21 (the copy dropped, the reaper's end added), 1, 3",
			db.Backend, len(d.Sessions), len(d.Events), len(d.Content), len(d.Agents))
	}
	for _, s := range d.Sessions {
		row := canonical(t, s)
		ctxDoc, _ := s["context"].(map[string]any)
		check := func(cond bool, what string) {
			if !cond {
				t.Errorf("%s %s row: %s (%s)", db.Backend, s["session"], what, row)
			}
		}
		switch s["session"] {
		case "parent":
			servers, _ := ctxDoc["mcp_servers"].([]any)
			check(strings.Contains(row, `"framework":"langchain"`) && fmt.Sprint(ctxDoc["frameworks"]) == "[langchain]", "framework appended once by the start")
			check(s["tokens_used"] == 100+20+200+30+42 && strings.Contains(row, `"state":"closed"`), "tokens and close")
			check(len(servers) == 1, "one MCP server")
		case "late":
			check(strings.Contains(row, `"framework":"agno"`) && fmt.Sprint(ctxDoc["frameworks"]) == "[agno]" && ctxDoc["os"] == "Linux",
				"framework appended once by the call")
		case "otel":
			check(s["started_at_ms"] == int64(20000) && s["ended_at_ms"] == int64(40000), "event-dated start and end")
		case "idle":
			check(strings.Contains(row, `"state":"closed"`) && s["last_seen_ms"] == int64(-2*time.Hour/time.Millisecond), "reaped")
		}
	}
	legacy, orphan := 0, 0
	for _, e := range d.Events {
		row := canonical(t, e)
		if e["session"] == "legacy" && e["event_type"] == "post_call" {
			legacy++
			if !strings.Contains(row, `"model_requested":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"`) ||
				!strings.Contains(row, `"model":"claude-sonnet-4-5-20250929"`) || !strings.Contains(row, `"inference_scope":"regional"`) ||
				!strings.Contains(row, `"platform":"bedrock"`) {
				t.Errorf("%s legacy row not backfilled: %s", db.Backend, row)
			}
		}
		if e["session"] == "idle" && e["event_type"] == "session_end" {
			orphan++
			if !strings.Contains(row, `"close_reason":"orphan_timeout"`) {
				t.Errorf("%s synthetic end: %s", db.Backend, row)
			}
		}
	}
	if legacy != 1 || orphan != 1 {
		t.Errorf("%s: %d legacy rows, %d synthetic ends; want 1 and 1", db.Backend, legacy, orphan)
	}
	return d
}

// dumpEquivalence reads the run's rows. Ids become role names (event
// ids their position), inside JSON documents too; JSON columns are
// decoded (key order is not compared); timestamps become millisecond
// offsets from t0 (precision is not compared), or "clock" when the
// database's clock wrote them during the run's window [from, to].
func dumpEquivalence(t *testing.T, db *storage.DB, ids map[string]string, t0, from, to time.Time) equivalenceDump {
	t.Helper()
	ctx := context.Background()
	name := make(map[string]string, len(ids))
	for k, v := range ids {
		name[v] = k
	}
	// Event ids, by position in the stored sequence.
	eventRows, err := db.Reader().QueryContext(ctx, `
		SELECT CAST(id AS TEXT) FROM events WHERE flavor = 'equivalence' ORDER BY occurred_at, event_type`)
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; eventRows.Next(); n++ {
		var id string
		if err := eventRows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		name[id] = fmt.Sprintf("event#%d", n)
	}
	_ = eventRows.Close()
	label := func(p *string) any {
		if p == nil {
			return nil
		}
		if n, ok := name[strings.ToLower(*p)]; ok {
			return n
		}
		return *p
	}
	var relabel func(v any) any
	relabel = func(v any) any {
		switch x := v.(type) {
		case string:
			if n, ok := name[strings.ToLower(x)]; ok {
				return n
			}
			return x
		case []any:
			for i := range x {
				x[i] = relabel(x[i])
			}
		case map[string]any:
			for k := range x {
				x[k] = relabel(x[k])
			}
		}
		return v
	}
	offset := func(ts *time.Time) any {
		if ts == nil {
			return nil
		}
		if !ts.Before(from) && !ts.After(to) {
			return "clock"
		}
		return ts.Sub(t0).Round(time.Millisecond).Milliseconds()
	}
	decode := func(raw []byte) any {
		if raw == nil {
			return nil
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode %s: %v", raw, err)
		}
		return relabel(v)
	}
	var d equivalenceDump

	rows, err := db.Reader().QueryContext(ctx, `
		SELECT CAST(session_id AS TEXT), state, flavor, agent_type, host, framework, model, client_type,
		       CAST(agent_id AS TEXT), agent_name, CAST(parent_session_id AS TEXT), agent_role,
		       tokens_used, context, capture_prompts, started_at, last_seen_at, ended_at, start_seq, closed_seq
		FROM sessions WHERE flavor IN ('equivalence', 'unknown') ORDER BY session_id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var sid, state, flavor, agentType string
		var host, framework, model, clientType, agentID, agentName, parent, role *string
		var tokens int
		var contextJSON []byte
		var posture *bool
		var startedAt, lastSeen time.Time
		var endedAt *time.Time
		var startSeq, closedSeq *int64
		if err := rows.Scan(&sid, &state, &flavor, &agentType, &host, &framework, &model, &clientType,
			&agentID, &agentName, &parent, &role, &tokens, &contextJSON, &posture, &startedAt, &lastSeen,
			&endedAt, &startSeq, &closedSeq); err != nil {
			t.Fatal(err)
		}
		d.Sessions = append(d.Sessions, map[string]any{
			"session": label(&sid), "state": state, "flavor": flavor, "agent_type": agentType,
			"host": host, "framework": framework, "model": model, "client_type": clientType,
			"agent": label(agentID), "agent_name": agentName, "parent": label(parent), "agent_role": role,
			"tokens_used": tokens, "context": decode(contextJSON), "capture_prompts": posture,
			"started_at_ms": offset(&startedAt), "last_seen_ms": offset(&lastSeen), "ended_at_ms": offset(endedAt),
			"start_seq": startSeq, "closed_seq": closedSeq,
		})
	}
	_ = rows.Close()

	rows, err = db.Reader().QueryContext(ctx, `
		SELECT CAST(session_id AS TEXT), event_type, model, tokens_input, tokens_output, tokens_total,
		       provider, billing_mode, model_requested, platform, tool_name, has_content, occurred_at, payload
		FROM events WHERE flavor = 'equivalence' ORDER BY occurred_at, event_type`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var sid, eventType string
		var model, provider, billing, requested, platform, toolName *string
		var in, out, total *int
		var hasContent bool
		var occurredAt time.Time
		var payload []byte
		if err := rows.Scan(&sid, &eventType, &model, &in, &out, &total, &provider, &billing, &requested,
			&platform, &toolName, &hasContent, &occurredAt, &payload); err != nil {
			t.Fatal(err)
		}
		d.Events = append(d.Events, map[string]any{
			"session": label(&sid), "event_type": eventType, "model": model, "tokens_input": in,
			"tokens_output": out, "tokens_total": total, "provider": provider, "billing_mode": billing,
			"model_requested": requested, "platform": platform, "tool_name": toolName, "has_content": hasContent,
			"occurred_at_ms": offset(&occurredAt), "payload": decode(payload),
		})
	}
	_ = rows.Close()

	rows, err = db.Reader().QueryContext(ctx, `
		SELECT CAST(c.session_id AS TEXT), c.provider, c.model, c.system_prompt, c.messages, c.response
		FROM event_content c JOIN sessions s ON s.session_id = c.session_id WHERE s.flavor = 'equivalence'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var sid, provider, model string
		var system *string
		var messages, response []byte
		if err := rows.Scan(&sid, &provider, &model, &system, &messages, &response); err != nil {
			t.Fatal(err)
		}
		d.Content = append(d.Content, map[string]any{
			"session": label(&sid), "provider": provider, "model": model, "system": system,
			"messages": decode(messages), "response": decode(response),
		})
	}
	_ = rows.Close()

	rows, err = db.Reader().QueryContext(ctx, `
		SELECT CAST(agent_id AS TEXT), agent_name, agent_type, client_type, total_sessions, total_tokens
		FROM agents WHERE agent_name LIKE 'equivalence%' ORDER BY agent_name`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, agentName, agentType, clientType string
		var sessions int
		var tokens int64
		if err := rows.Scan(&id, &agentName, &agentType, &clientType, &sessions, &tokens); err != nil {
			t.Fatal(err)
		}
		d.Agents = append(d.Agents, map[string]any{
			"agent": label(&id), "agent_name": agentName, "agent_type": agentType, "client_type": clientType,
			"total_sessions": sessions, "total_tokens": tokens,
		})
	}
	_ = rows.Close()
	for _, list := range [][]map[string]any{d.Sessions, d.Events, d.Content, d.Agents} {
		sort.Slice(list, func(i, j int) bool { return canonical(t, list[i]) < canonical(t, list[j]) })
	}
	return d
}

// canonical renders a row with sorted keys, so two rows compare as
// values whatever order the engine returned their JSON in.
func canonical(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// The one fixed sequence leaves identical rows on both backends.
func TestProcess_SameEventsLeaveIdenticalRowsOnBothBackends(t *testing.T) {
	sq := runEquivalence(t, storagetest.OpenSQLite(t))
	if os.Getenv(storagetest.PostgresURLEnv) == "" {
		t.Skipf("%s unset: the SQLite half ran; the Postgres half and the comparison need a database", storagetest.PostgresURLEnv)
	}
	pg := runEquivalence(t, storagetest.OpenPostgres(t))
	a, b := canonical(t, pg), canonical(t, sq)
	if a == b {
		return
	}
	// Name the first differing row per section, so the failure reads.
	for _, section := range []struct {
		name   string
		pg, sq []map[string]any
	}{{"sessions", pg.Sessions, sq.Sessions}, {"events", pg.Events, sq.Events}, {"event_content", pg.Content, sq.Content}, {"agents", pg.Agents, sq.Agents}} {
		for i := 0; i < len(section.pg) || i < len(section.sq); i++ {
			var x, y string
			if i < len(section.pg) {
				x = canonical(t, section.pg[i])
			}
			if i < len(section.sq) {
				y = canonical(t, section.sq[i])
			}
			if x != y {
				t.Errorf("the backends disagree on %s row %d:\npostgres: %s\nsqlite:   %s", section.name, i, x, y)
				break
			}
		}
	}
}
