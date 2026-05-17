package store

import (
	"context"
	"testing"
	"time"
)

// TestGetEvents_AgentIDFilter exercises the agent_id filter added
// for the agent drawer's Events tab. The events table has no
// agent_id column, so the filter resolves through a sessions
// subquery; the test seeds two agents — each with one session and
// events — and asserts the filter returns only the targeted
// agent's events, and nothing for an agent with no sessions.
func TestGetEvents_AgentIDFilter(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)

	agentA := randomUUID(t)
	agentB := randomUUID(t)
	seedAgent(t, s, agentA, now.Add(-time.Hour), now.Add(-10*time.Minute), 1, 100)
	seedAgent(t, s, agentB, now.Add(-time.Hour), now.Add(-10*time.Minute), 1, 100)

	sessionA := randomUUID(t)
	sessionB := randomUUID(t)
	flavorA := "test-events-agentfilter-a-" + randomUUID(t)[:8]
	flavorB := "test-events-agentfilter-b-" + randomUUID(t)[:8]

	for _, sd := range []struct {
		sessionID, agentID, flavor string
	}{
		{sessionA, agentA, flavorA},
		{sessionB, agentB, flavorB},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type
			) VALUES (
				$1::uuid, $2::uuid, $3, 'closed',
				$4, $4, 100,
				'coding', 'flightdeck_sensor'
			)
		`, sd.sessionID, sd.agentID, sd.flavor, now.Add(-30*time.Minute)); err != nil {
			t.Fatalf("seed session: %v", err)
		}
	}

	// agentA gets two events, agentB one.
	for _, e := range []struct {
		sessionID, flavor, eventType string
	}{
		{sessionA, flavorA, "pre_call"},
		{sessionA, flavorA, "post_call"},
		{sessionB, flavorB, "post_call"},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, $3, $4, false
			)
		`, e.sessionID, e.flavor, e.eventType, now.Add(-20*time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM events WHERE session_id = ANY($1::uuid[])`,
			[]string{sessionA, sessionB})
	})

	// agentA — exactly its two events, none of agentB's.
	respA, err := s.GetEvents(ctx, EventsParams{
		From:    now.Add(-time.Hour),
		To:      now,
		AgentID: agentA,
		Limit:   100,
	})
	if err != nil {
		t.Fatalf("GetEvents(agentA): %v", err)
	}
	if respA.Total != 2 || len(respA.Events) != 2 {
		t.Fatalf("agentA: total=%d len=%d, want 2/2", respA.Total, len(respA.Events))
	}
	for _, ev := range respA.Events {
		if ev.SessionID != sessionA {
			t.Errorf("agentA query leaked an event from session %s", ev.SessionID)
		}
	}

	// An agent with no sessions resolves to an empty subquery.
	respNone, err := s.GetEvents(ctx, EventsParams{
		From:    now.Add(-time.Hour),
		To:      now,
		AgentID: randomUUID(t),
		Limit:   100,
	})
	if err != nil {
		t.Fatalf("GetEvents(unknown agent): %v", err)
	}
	if respNone.Total != 0 || len(respNone.Events) != 0 {
		t.Errorf("unknown agent: total=%d len=%d, want 0/0",
			respNone.Total, len(respNone.Events))
	}
}

// seedFacetSession seeds one agent + session and a fixed event set
// for the event-grain facet tests: two llm_error events (distinct
// error_type), one post_call (a model), one session_end (a
// close_reason). Returns the session_id; events are cleaned up via
// t.Cleanup.
func seedFacetSession(t *testing.T, s *Store) string {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-time.Hour), now.Add(-10*time.Minute), 1, 100)
	sessionID := randomUUID(t)
	flavor := "test-events-facets-" + randomUUID(t)[:8]
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 100,
			'coding', 'flightdeck_sensor'
		)
	`, sessionID, agentID, flavor, now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for _, e := range []struct {
		eventType, model, payload string
	}{
		{"llm_error", "", `{"error":{"error_type":"rate_limit"}}`},
		{"llm_error", "", `{"error":{"error_type":"timeout"}}`},
		{"post_call", "claude-sonnet-4-6", `{}`},
		{"session_end", "", `{"close_reason":"normal_exit"}`},
		{"mcp_tool_call", "", `{"server_name":"fixture-server"}`},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type, model,
				payload, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, $3, NULLIF($4,''),
				$5::jsonb, $6, false
			)
		`, sessionID, flavor, e.eventType, e.model, e.payload,
			now.Add(-20*time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
	})
	return sessionID
}

// TestGetEvents_FacetFilters exercises the event-grain facet filters
// — the multi-value event_type / model and the payload-JSONB
// error_type / close_reason predicates.
func TestGetEvents_FacetFilters(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	sessionID := seedFacetSession(t, s)
	from := time.Now().UTC().Add(-time.Hour)
	to := time.Now().UTC()

	// error_type filter — only the rate_limit llm_error.
	resp, err := s.GetEvents(ctx, EventsParams{
		From: from, To: to, SessionID: sessionID,
		ErrorTypes: []string{"rate_limit"}, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(error_type): %v", err)
	}
	if resp.Total != 1 {
		t.Errorf("error_type=rate_limit total=%d, want 1", resp.Total)
	}

	// event_type multi-value — both llm_error rows.
	resp, err = s.GetEvents(ctx, EventsParams{
		From: from, To: to, SessionID: sessionID,
		EventTypes: []string{"llm_error"}, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(event_type): %v", err)
	}
	if resp.Total != 2 {
		t.Errorf("event_type=llm_error total=%d, want 2", resp.Total)
	}

	// model filter — the one post_call.
	resp, err = s.GetEvents(ctx, EventsParams{
		From: from, To: to, SessionID: sessionID,
		Models: []string{"claude-sonnet-4-6"}, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(model): %v", err)
	}
	if resp.Total != 1 {
		t.Errorf("model filter total=%d, want 1", resp.Total)
	}

	// close_reason filter — the one session_end.
	resp, err = s.GetEvents(ctx, EventsParams{
		From: from, To: to, SessionID: sessionID,
		CloseReasons: []string{"normal_exit"}, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(close_reason): %v", err)
	}
	if resp.Total != 1 {
		t.Errorf("close_reason filter total=%d, want 1", resp.Total)
	}

	// mcp_server filter — the one mcp_tool_call.
	resp, err = s.GetEvents(ctx, EventsParams{
		From: from, To: to, SessionID: sessionID,
		MCPServers: []string{"fixture-server"}, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(mcp_server): %v", err)
	}
	if resp.Total != 1 {
		t.Errorf("mcp_server filter total=%d, want 1", resp.Total)
	}
}

// TestGetEventFacets exercises the facet-count query — per-dimension
// counts over the filtered event set.
func TestGetEventFacets(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	sessionID := seedFacetSession(t, s)

	facets, err := s.GetEventFacets(ctx, EventsParams{
		From:      time.Now().UTC().Add(-time.Hour),
		To:        time.Now().UTC(),
		SessionID: sessionID,
	})
	if err != nil {
		t.Fatalf("GetEventFacets: %v", err)
	}

	countOf := func(fvs []EventFacetValue, value string) int {
		for _, fv := range fvs {
			if fv.Value == value {
				return fv.Count
			}
		}
		return 0
	}

	if got := countOf(facets.EventType, "llm_error"); got != 2 {
		t.Errorf("EventType[llm_error]=%d, want 2", got)
	}
	if got := countOf(facets.EventType, "post_call"); got != 1 {
		t.Errorf("EventType[post_call]=%d, want 1", got)
	}
	if got := countOf(facets.ErrorType, "rate_limit"); got != 1 {
		t.Errorf("ErrorType[rate_limit]=%d, want 1", got)
	}
	if got := countOf(facets.ErrorType, "timeout"); got != 1 {
		t.Errorf("ErrorType[timeout]=%d, want 1", got)
	}
	if got := countOf(facets.Model, "claude-sonnet-4-6"); got != 1 {
		t.Errorf("Model[claude-sonnet-4-6]=%d, want 1", got)
	}
	if got := countOf(facets.CloseReason, "normal_exit"); got != 1 {
		t.Errorf("CloseReason[normal_exit]=%d, want 1", got)
	}
	if got := countOf(facets.MCPServer, "fixture-server"); got != 1 {
		t.Errorf("MCPServer[fixture-server]=%d, want 1", got)
	}
}

// seedPayloadFacetSession seeds one session with five events, each
// carrying a distinct payload-JSONB facet field, for the payload
// facet-filter tests. Returns the session_id; cleaned up via
// t.Cleanup.
func seedPayloadFacetSession(t *testing.T, s *Store) string {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-time.Hour), now.Add(-10*time.Minute), 1, 100)
	sessionID := randomUUID(t)
	flavor := "test-events-payload-" + randomUUID(t)[:8]
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 100, 'coding', 'flightdeck_sensor'
		)
	`, sessionID, agentID, flavor, now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for _, e := range []struct {
		eventType, payload string
	}{
		{"post_call", `{"estimated_via":"tiktoken"}`},
		{"policy_block", `{"policy_decision":{"matched_entry_id":"entry-7"}}`},
		{"tool_call", `{"originating_call_context":"sub_agent"}`},
		{"session_end", `{"terminal":true}`},
		{"session_end", `{"terminal":false}`},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type,
				payload, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, $5, false
			)
		`, sessionID, flavor, e.eventType, e.payload,
			now.Add(-20*time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
	})
	return sessionID
}

// TestGetEvents_PayloadFacetFilters covers the payload-JSONB facet
// filters TestGetEvents_FacetFilters does not — estimated_via,
// matched_entry_id, originating_call_context, and the boolean
// terminal filter — plus the terminal facet-count text values.
func TestGetEvents_PayloadFacetFilters(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	sessionID := seedPayloadFacetSession(t, s)
	from := time.Now().UTC().Add(-time.Hour)
	to := time.Now().UTC()

	tru, fls := true, false
	for _, tc := range []struct {
		name   string
		params EventsParams
		want   int
	}{
		{"estimated_via", EventsParams{EstimatedVia: []string{"tiktoken"}}, 1},
		{"matched_entry_id", EventsParams{MatchedEntryIDs: []string{"entry-7"}}, 1},
		{"originating_call_context",
			EventsParams{OriginatingCallContexts: []string{"sub_agent"}}, 1},
		{"terminal=true", EventsParams{Terminal: &tru}, 1},
		{"terminal=false", EventsParams{Terminal: &fls}, 1},
	} {
		p := tc.params
		p.From, p.To, p.SessionID, p.Limit = from, to, sessionID, 100
		resp, err := s.GetEvents(ctx, p)
		if err != nil {
			t.Fatalf("GetEvents(%s): %v", tc.name, err)
		}
		if resp.Total != tc.want {
			t.Errorf("%s: total=%d, want %d", tc.name, resp.Total, tc.want)
		}
	}

	facets, err := s.GetEventFacets(ctx, EventsParams{
		From: from, To: to, SessionID: sessionID,
	})
	if err != nil {
		t.Fatalf("GetEventFacets: %v", err)
	}
	countOf := func(fvs []EventFacetValue, value string) int {
		for _, fv := range fvs {
			if fv.Value == value {
				return fv.Count
			}
		}
		return 0
	}
	if got := countOf(facets.Terminal, "true"); got != 1 {
		t.Errorf("Terminal[true]=%d, want 1", got)
	}
	if got := countOf(facets.Terminal, "false"); got != 1 {
		t.Errorf("Terminal[false]=%d, want 1", got)
	}
	if got := countOf(facets.EstimatedVia, "tiktoken"); got != 1 {
		t.Errorf("EstimatedVia[tiktoken]=%d, want 1", got)
	}
	if got := countOf(facets.MatchedEntryID, "entry-7"); got != 1 {
		t.Errorf("MatchedEntryID[entry-7]=%d, want 1", got)
	}
	if got := countOf(facets.OriginatingCallContext, "sub_agent"); got != 1 {
		t.Errorf("OriginatingCallContext[sub_agent]=%d, want 1", got)
	}
}

// TestGetEvents_FrameworkFilter exercises the framework filter, which
// the events table cannot serve directly — it resolves through a
// sessions subquery matching the bare sessions.framework column.
func TestGetEvents_FrameworkFilter(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	from := now.Add(-time.Hour)

	type sess struct{ id, flavor, framework string }
	lc := sess{randomUUID(t), "test-fw-lc-" + randomUUID(t)[:8], "langchain"}
	cc := sess{randomUUID(t), "test-fw-cc-" + randomUUID(t)[:8], "claude-code"}
	for _, sd := range []sess{lc, cc} {
		agentID := randomUUID(t)
		seedAgent(t, s, agentID, from, now.Add(-10*time.Minute), 1, 100)
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state, framework,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type
			) VALUES (
				$1::uuid, $2::uuid, $3, 'closed', $4,
				$5, $5, 100, 'coding', 'flightdeck_sensor'
			)
		`, sd.id, agentID, sd.flavor, sd.framework,
			now.Add(-30*time.Minute)); err != nil {
			t.Fatalf("seed session: %v", err)
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, 'post_call', $3, false
			)
		`, sd.id, sd.flavor, now.Add(-20*time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM events WHERE session_id = ANY($1::uuid[])`,
			[]string{lc.id, cc.id})
	})

	resp, err := s.GetEvents(ctx, EventsParams{
		From: from, To: now, Frameworks: []string{"langchain"}, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(framework): %v", err)
	}
	foundLC := false
	for _, ev := range resp.Events {
		if ev.SessionID == cc.id {
			t.Errorf("framework=langchain leaked claude-code session %s", cc.id)
		}
		if ev.SessionID == lc.id {
			foundLC = true
		}
	}
	if !foundLC {
		t.Error("framework=langchain did not return the seeded langchain event")
	}
}

// TestGetEvents_QueryFilter exercises the free-text `q` filter
// powering the `/events` page search bar. It seeds two sessions —
// a match session carrying a per-run-unique token in both its
// agent_name and framework, and a non-match session — each with one
// event. Every assertion keys off the unique token so the test is
// self-isolating against any leftover rows from prior runs or other
// tests sharing the events table. It covers the three ILIKE paths:
// agent_name and framework (resolved via the sessions subquery) and
// event_type (an events-table column).
func TestGetEvents_QueryFilter(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	from := now.Add(-time.Hour)

	// A per-run-unique token. Both the match session's agent_name and
	// framework embed it, and the event_type does too, so each ILIKE
	// path can be exercised with a query that cannot collide with any
	// other row in the table.
	token := "qfilter" + randomUUID(t)[:8]

	// Match session: agent_name + framework both carry the token.
	matchID := randomUUID(t)
	matchFlavor := "test-events-q-match-" + randomUUID(t)[:8]
	matchAgent := randomUUID(t)
	seedAgent(t, s, matchAgent, from, now.Add(-10*time.Minute), 1, 100)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state, agent_name, framework,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed', $4, $5,
			$6, $6, 100, 'coding', 'flightdeck_sensor'
		)
	`, matchID, matchAgent, matchFlavor,
		"agent-"+token, "fw-"+token,
		now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed match session: %v", err)
	}

	// Non-match session: an unrelated agent_name + framework.
	otherID := randomUUID(t)
	otherFlavor := "test-events-q-other-" + randomUUID(t)[:8]
	otherAgent := randomUUID(t)
	seedAgent(t, s, otherAgent, from, now.Add(-10*time.Minute), 1, 100)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state, agent_name, framework,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed', 'unrelated-bot', 'langchain',
			$4, $4, 100, 'coding', 'flightdeck_sensor'
		)
	`, otherID, otherAgent, otherFlavor,
		now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed other session: %v", err)
	}

	// The match event's event_type also embeds the token so the
	// events-table-column ILIKE path can be exercised with the same
	// collision-proof query string.
	for _, sd := range []struct{ sessionID, flavor, eventType string }{
		{matchID, matchFlavor, "evt-" + token},
		{otherID, otherFlavor, "pre_call"},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, $3, $4, false
			)
		`, sd.sessionID, sd.flavor, sd.eventType,
			now.Add(-20*time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM events WHERE session_id = ANY($1::uuid[])`,
			[]string{matchID, otherID})
	})

	// assertOnlyMatch runs GetEvents with the given query and asserts
	// the result is exactly the one match event — nothing else, and
	// never the non-match session's event.
	assertOnlyMatch := func(label, query string) {
		t.Helper()
		resp, err := s.GetEvents(ctx, EventsParams{
			From: from, To: now, Query: query, Limit: 100,
		})
		if err != nil {
			t.Fatalf("GetEvents(%s): %v", label, err)
		}
		if resp.Total != 1 || len(resp.Events) != 1 {
			t.Fatalf("%s: total=%d len=%d, want 1/1",
				label, resp.Total, len(resp.Events))
		}
		if resp.Events[0].SessionID != matchID {
			t.Errorf("%s returned session %s, want %s",
				label, resp.Events[0].SessionID, matchID)
		}
	}

	// agent_name path — resolved via the sessions subquery.
	assertOnlyMatch("q=agent_name", "agent-"+token)
	// framework path — resolved via the sessions subquery.
	assertOnlyMatch("q=framework", "fw-"+token)
	// event_type path — a direct events-table column.
	assertOnlyMatch("q=event_type", "evt-"+token)

	// A query matching nothing returns an empty result.
	respNone, err := s.GetEvents(ctx, EventsParams{
		From: from, To: now, Query: "no-such-token-" + token, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(no-match): %v", err)
	}
	if respNone.Total != 0 || len(respNone.Events) != 0 {
		t.Errorf("no-match query: total=%d len=%d, want 0/0",
			respNone.Total, len(respNone.Events))
	}
}

// TestGetEvents_SessionIdentityColumns verifies GetEvents projects the
// session-level identity attributes (framework, client_type,
// agent_type) onto each Event via the LEFT JOIN to `sessions`. It
// covers a session with a framework set and one with a NULL framework
// (a Claude Code session), asserting the latter scans back as a nil
// pointer rather than an empty string.
func TestGetEvents_SessionIdentityColumns(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	from := now.Add(-time.Hour)

	// Session 1: sensor / production / langchain.
	sensorID := randomUUID(t)
	sensorFlavor := "test-events-identity-sensor-" + randomUUID(t)[:8]
	agentSensor := randomUUID(t)
	seedAgent(t, s, agentSensor, from, now.Add(-10*time.Minute), 1, 100)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state, framework,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed', 'langchain',
			$4, $4, 100, 'production', 'flightdeck_sensor'
		)
	`, sensorID, agentSensor, sensorFlavor, now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed sensor session: %v", err)
	}

	// Session 2: claude_code / coding with the framework column left
	// unset so it defaults to NULL.
	ccID := randomUUID(t)
	ccFlavor := "test-events-identity-cc-" + randomUUID(t)[:8]
	agentCC := randomUUID(t)
	seedAgent(t, s, agentCC, from, now.Add(-10*time.Minute), 1, 100)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 100, 'coding', 'claude_code'
		)
	`, ccID, agentCC, ccFlavor, now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed claude-code session: %v", err)
	}

	for _, sd := range []struct{ sessionID, flavor string }{
		{sensorID, sensorFlavor},
		{ccID, ccFlavor},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, 'post_call', $3, false
			)
		`, sd.sessionID, sd.flavor, now.Add(-20*time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM events WHERE session_id = ANY($1::uuid[])`,
			[]string{sensorID, ccID})
	})

	// Sensor session: every identity column populated from the join.
	respSensor, err := s.GetEvents(ctx, EventsParams{
		From: from, To: now, SessionID: sensorID, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(sensor): %v", err)
	}
	if len(respSensor.Events) != 1 {
		t.Fatalf("sensor: len(events)=%d, want 1", len(respSensor.Events))
	}
	ev := respSensor.Events[0]
	if ev.Framework == nil {
		t.Error("sensor Framework = nil, want langchain")
	} else if *ev.Framework != "langchain" {
		t.Errorf("sensor Framework = %q, want langchain", *ev.Framework)
	}
	if ev.ClientType == nil {
		t.Error("sensor ClientType = nil, want flightdeck_sensor")
	} else if *ev.ClientType != "flightdeck_sensor" {
		t.Errorf("sensor ClientType = %q, want flightdeck_sensor", *ev.ClientType)
	}
	if ev.AgentType == nil {
		t.Error("sensor AgentType = nil, want production")
	} else if *ev.AgentType != "production" {
		t.Errorf("sensor AgentType = %q, want production", *ev.AgentType)
	}

	// Claude Code session: client/agent type populated, framework nil.
	respCC, err := s.GetEvents(ctx, EventsParams{
		From: from, To: now, SessionID: ccID, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents(claude-code): %v", err)
	}
	if len(respCC.Events) != 1 {
		t.Fatalf("claude-code: len(events)=%d, want 1", len(respCC.Events))
	}
	ev = respCC.Events[0]
	if ev.Framework != nil {
		t.Errorf("claude-code Framework = %q, want nil", *ev.Framework)
	}
	if ev.ClientType == nil {
		t.Error("claude-code ClientType = nil, want claude_code")
	} else if *ev.ClientType != "claude_code" {
		t.Errorf("claude-code ClientType = %q, want claude_code", *ev.ClientType)
	}
	if ev.AgentType == nil {
		t.Error("claude-code AgentType = nil, want coding")
	} else if *ev.AgentType != "coding" {
		t.Errorf("claude-code AgentType = %q, want coding", *ev.AgentType)
	}
}

// TestGetEvents_SessionIdentityColumns_NullClientType verifies the
// LEFT JOIN scans a NULL `sessions.client_type` cleanly as a nil
// pointer. `client_type` carries a CHECK but no NOT NULL constraint,
// so a session row can legitimately omit it; the join must not error
// or panic on the null column.
func TestGetEvents_SessionIdentityColumns_NullClientType(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	from := now.Add(-time.Hour)

	agentID := randomUUID(t)
	sessionID := randomUUID(t)
	flavor := "test-events-identity-null-ct-" + randomUUID(t)[:8]
	seedAgent(t, s, agentID, from, now.Add(-10*time.Minute), 1, 100)

	// Insert a session with no client_type column value (legal: the
	// column has a CHECK but no NOT NULL constraint).
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used, agent_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 100, 'coding'
		)
	`, sessionID, agentID, flavor, now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO events (
			id, session_id, flavor, event_type, occurred_at, has_content
		) VALUES (
			gen_random_uuid(), $1::uuid, $2, 'post_call', $3, false
		)
	`, sessionID, flavor, now.Add(-20*time.Minute)); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
	})

	resp, err := s.GetEvents(ctx, EventsParams{
		From: from, To: now, SessionID: sessionID, Limit: 100,
	})
	if err != nil {
		t.Fatalf("GetEvents: %v", err)
	}
	if len(resp.Events) != 1 {
		t.Fatalf("len(events)=%d, want 1", len(resp.Events))
	}
	ev := resp.Events[0]
	if ev.ClientType != nil {
		t.Errorf("ClientType = %q, want nil for a session with no client_type",
			*ev.ClientType)
	}
	// agent_type was set, so it scans as a non-nil pointer.
	if ev.AgentType == nil {
		t.Error("AgentType = nil, want coding")
	} else if *ev.AgentType != "coding" {
		t.Errorf("AgentType = %q, want coding", *ev.AgentType)
	}
}
