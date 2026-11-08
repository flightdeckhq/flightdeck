package processor

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// The equivalence test drives one fixed event sequence through Process
// on every covered backend, dumps the rows it produced in a normalised
// shape and asserts the dumps are identical. It is the pinned proof
// that the two query sets agree, beyond the per-feature tests.
//
// Two differences between the engines are normalised away on purpose
// and documented in ARCHITECTURE.md (Worker / Event Processing →
// Database access): JSON key order (Postgres jsonb reorders keys and
// SQLite stores the text as written, so documents are compared as
// decoded values), and timestamp precision (Postgres keeps
// microseconds, SQLite milliseconds, so timestamps are compared as
// millisecond offsets from the run's first event). Two more are
// properties of the run, not of the engine: ids differ per run and are
// replaced by their role names (event ids by their position in the
// sequence), wherever they appear, payload JSON included; and a time
// the database's clock wrote (last_seen_at, a non-assembled session's
// started_at and ended_at) depends on when the run happened, so such a
// time is reduced to "clock" when it falls inside the run's window.

// equivalenceRun is the fixed sequence: a child sub-agent whose start
// arrives before its parent's, the parent's call before its own start
// (lazy creation with a framework), the start without a framework (so
// the label is appended to the context), a call with content and its
// re-sent copy, a tool call, an MCP server attached twice, a failed
// stream with partial tokens, the ends, and a session that stays open.
func equivalenceRun(ids map[string]string, t0 time.Time) []consumer.EventPayload {
	at := func(i int) string { return t0.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano) }
	base := func(session, eventType string, i int) consumer.EventPayload {
		return consumer.EventPayload{
			SessionID: ids[session], EventType: eventType, Flavor: "equivalence",
			AgentID: ids["agent"], AgentType: "coding", ClientType: "flightdeck_sensor",
			AgentName: "equivalence-agent", User: "test", Hostname: "test-host",
			Host: "test-host", Timestamp: at(i), CapturePrompts: true, StreamSeq: uint64(i + 1),
		}
	}
	child := func(eventType string, i int) consumer.EventPayload {
		e := base("child", eventType, i)
		e.AgentID, e.AgentName = ids["child_agent"], "equivalence-child"
		e.ParentSessionID, e.AgentRole = strings.ToUpper(ids["parent"]), "researcher"
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
	cc := child("post_call", 9)
	cc.Model = "gpt-4o-mini"
	tok(&cc, 10, 5)
	ce := child("session_end", 10)
	pe := base("parent", "session_end", 11)
	is := base("idle", "session_start", 12)
	is.Context = map[string]interface{}{"os": "Linux"}
	return []consumer.EventPayload{cs, c1, ps, c2, c2dup, tc, mcp, mcp2, failed, cc, ce, pe, is}
}

// equivalenceDump is the normalised state of the rows the run wrote.
type equivalenceDump struct {
	Sessions []map[string]any `json:"sessions"`
	Events   []map[string]any `json:"events"`
	Content  []map[string]any `json:"event_content"`
	Agents   []map[string]any `json:"agents"`
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
		       provider, billing_mode, model_requested, tool_name, has_content, occurred_at, payload
		FROM events WHERE flavor = 'equivalence' ORDER BY occurred_at, event_type`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var sid, eventType string
		var model, provider, billing, requested, toolName *string
		var in, out, total *int
		var hasContent bool
		var occurredAt time.Time
		var payload []byte
		if err := rows.Scan(&sid, &eventType, &model, &in, &out, &total, &provider, &billing, &requested,
			&toolName, &hasContent, &occurredAt, &payload); err != nil {
			t.Fatal(err)
		}
		d.Events = append(d.Events, map[string]any{
			"session": label(&sid), "event_type": eventType, "model": model, "tokens_input": in,
			"tokens_output": out, "tokens_total": total, "provider": provider, "billing_mode": billing,
			"model_requested": requested, "tool_name": toolName, "has_content": hasContent,
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

// The one fixed sequence leaves identical rows on every backend. Each
// backend's dump is also checked against the expectations the sequence
// implies, so the test fails for the right reason on a single backend
// too; the cross-backend comparison runs when the run covers both.
func TestProcess_SameEventsLeaveIdenticalRowsOnBothBackends(t *testing.T) {
	dumps := map[storage.Backend]equivalenceDump{}
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ids := map[string]string{
			"agent": randomID(t), "child_agent": randomID(t),
			"parent": randomID(t), "child": randomID(t), "idle": randomID(t), "call": randomID(t),
		}
		for _, k := range []string{"agent", "child_agent"} {
			id := ids[k]
			t.Cleanup(func() { _, _ = db.ExecContext(context.Background(), `DELETE FROM agents WHERE agent_id = $1`, id) })
		}
		// The child references the parent: registered after it, removed first.
		cleanupSession(t, db, ids["parent"])
		cleanupSession(t, db, ids["idle"])
		cleanupSession(t, db, ids["child"])

		p := newTestProcessor(db)
		// The events are dated a minute before the run, so a time the
		// database's clock wrote is told apart from an event-dated one.
		t0 := time.Now().UTC().Add(-time.Minute).Truncate(time.Millisecond)
		from := databaseNow(t, db).Add(-time.Millisecond)
		for i, e := range equivalenceRun(ids, t0) {
			if err := p.Process(context.Background(), e); err != nil {
				t.Fatalf("event %d (%s): %v", i, e.EventType, err)
			}
		}
		to := databaseNow(t, db).Add(time.Millisecond)
		d := dumpEquivalence(t, db, ids, t0, from, to)

		if len(d.Sessions) != 3 || len(d.Events) != 12 || len(d.Content) != 1 || len(d.Agents) != 2 {
			t.Fatalf("rows: %d sessions, %d events, %d content, %d agents; want 3, 12 (the copy dropped), 1, 2",
				len(d.Sessions), len(d.Events), len(d.Content), len(d.Agents))
		}
		for _, s := range d.Sessions {
			if s["session"] != "parent" {
				continue
			}
			row := canonical(t, s)
			ctxDoc, _ := s["context"].(map[string]any)
			servers, _ := ctxDoc["mcp_servers"].([]any)
			if !strings.Contains(row, `"framework":"langchain"`) || !strings.Contains(row, `"state":"closed"`) ||
				fmt.Sprint(ctxDoc["frameworks"]) != "[langchain]" || s["tokens_used"] != 100+20+200+30+42 || len(servers) != 1 {
				t.Errorf("parent row: %s", row)
			}
		}
		dumps[db.Backend] = d
	})
	pg, okPG := dumps[storage.Postgres]
	sq, okSQ := dumps[storage.SQLite]
	if !okPG || !okSQ {
		return
	}
	if a, b := canonical(t, pg), canonical(t, sq); a != b {
		t.Errorf("the backends disagree.\npostgres: %s\nsqlite:   %s", a, b)
	}
}
