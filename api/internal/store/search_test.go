package store

import (
	"context"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestSanitizeQueryEscapesWildcards(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"research_agent", "%research\\_agent%"},
		{"100%", "%100\\%%"},
		{"normal", "%normal%"},
		{"back\\slash", "%back\\\\slash%"},
		{"all_%\\chars", "%all\\_\\%\\\\chars%"},
	}
	for _, tc := range tests {
		got := sanitizeQuery(tc.input)
		if got != tc.expected {
			t.Errorf("sanitizeQuery(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}

func TestSanitizePrefixAndExact(t *testing.T) {
	if got := sanitizePrefix("post_call"); got != "post\\_call%" {
		t.Errorf("sanitizePrefix: got %q", got)
	}
	if got := sanitizeExact("post_call"); got != "post\\_call" {
		t.Errorf("sanitizeExact: got %q", got)
	}
	if got := sanitizeExact("100%"); got != "100\\%" {
		t.Errorf("sanitizeExact wildcards: got %q", got)
	}
}

func TestExpandCuratedTerms(t *testing.T) {
	cases := []struct {
		query string
		want  []string
	}{
		{"llm", []string{"pre_call", "post_call", "llm_error"}},
		{"LLM", []string{"pre_call", "post_call", "llm_error"}},
		{"  Llm  ", []string{"pre_call", "post_call", "llm_error"}},
		{"tool", []string{"tool_call", "mcp_tool_list", "mcp_tool_call"}},
		{"policy", []string{
			"policy_warn", "policy_degrade", "policy_block",
			"policy_mcp_warn", "policy_mcp_block",
		}},
		{"error", []string{"llm_error", "policy_block", "policy_mcp_block"}},
		{"embedding", []string{"embeddings"}},
		{"mcp", []string{
			"mcp_tool_list", "mcp_tool_call",
			"mcp_resource_list", "mcp_resource_read",
			"mcp_prompt_list", "mcp_prompt_get",
			"policy_mcp_warn", "policy_mcp_block",
			"mcp_server_name_changed", "mcp_server_attached",
		}},
		{"session", []string{"session_start", "session_end"}},
		{"block", []string{"policy_block", "policy_mcp_block"}},
		{"directive", []string{"directive_result"}},
		{"post_call", nil},
		{"", nil},
		{"unknown-term", nil},
	}
	for _, tc := range cases {
		got := expandCuratedTerms(tc.query)
		gotSorted := append([]string(nil), got...)
		wantSorted := append([]string(nil), tc.want...)
		sort.Strings(gotSorted)
		sort.Strings(wantSorted)
		if !reflect.DeepEqual(gotSorted, wantSorted) {
			t.Errorf("expandCuratedTerms(%q): got %v, want %v", tc.query, got, tc.want)
		}
	}
}

// seedSearchAgent inserts an agents row with caller-supplied name /
// hostname / user_name so the search tests can drive each ranking
// dimension independently. last_seen_at is set far in the future so
// the row outranks the dev DB's existing data on the
// occurred_at-DESC tiebreak. Cleanup deletes the row.
func seedSearchAgent(
	t *testing.T, s *Store,
	agentName, hostname, userName string,
) string {
	t.Helper()
	ctx := context.Background()
	agentID := randomUUID(t)
	future := time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO agents (
			agent_id, agent_type, client_type, agent_name,
			user_name, hostname,
			first_seen_at, last_seen_at,
			total_sessions, total_tokens
		) VALUES (
			$1::uuid, 'production', 'flightdeck_sensor', $2,
			$3, $4,
			$5, $5, 0, 0
		)
	`, agentID, agentName, userName, hostname, future); err != nil {
		t.Fatalf("seedSearchAgent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM agents WHERE agent_id = $1::uuid`, agentID)
	})
	return agentID
}

// seedSearchSessionWithEvents creates one session under agentID and
// inserts the supplied events. Timestamps are far-future so the
// fresh rows always win occurred_at DESC ties against dev-DB data.
// Cleanup deletes events before the session to respect the events
// → sessions FK.
func seedSearchSessionWithEvents(
	t *testing.T, s *Store, agentID, flavor string,
	events []struct {
		EventType string
		ToolName  string
		Model     string
	},
) string {
	t.Helper()
	ctx := context.Background()
	sessionID := randomUUID(t)
	future := time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 0,
			'coding', 'flightdeck_sensor'
		)
	`, sessionID, agentID, flavor, future); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for i, e := range events {
		// Stagger occurred_at so per-row ordering inside the
		// fixture is deterministic.
		ts := future.Add(time.Duration(i) * time.Second)
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type,
				tool_name, model, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, $3,
				NULLIF($4, ''), NULLIF($5, ''), $6, false
			)
		`, sessionID, flavor, e.EventType, e.ToolName, e.Model, ts); err != nil {
			t.Fatalf("seed event #%d: %v", i, err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, sessionID)
	})
	return sessionID
}

func TestSearch_AgentMatchesHostnameAndUserName(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	hostMarker := "search-host-" + suffix
	userMarker := "search-user-" + suffix
	nameMarker := "search-name-" + suffix

	// Agent only matched by hostname (name and user are unrelated).
	_ = seedSearchAgent(t, s,
		"unrelated-name-"+suffix, hostMarker, "unrelated-user-"+suffix)
	// Agent only matched by user_name.
	_ = seedSearchAgent(t, s,
		"other-name-"+suffix, "other-host-"+suffix, userMarker)
	// Agent only matched by agent_name (parity sanity).
	_ = seedSearchAgent(t, s,
		nameMarker, "n-host-"+suffix, "n-user-"+suffix)

	for _, q := range []string{hostMarker, userMarker, nameMarker} {
		results, err := s.Search(ctx, q)
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if len(results.Agents) == 0 {
			t.Errorf("Search(%q): expected ≥1 agent hit, got 0", q)
		}
	}
}

func TestSearch_AgentRankExactBeatsPrefixBeatsSubstring(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	exactQuery := "agent-rank-" + suffix

	// Substring-only: query appears in the middle of agent_name.
	subID := seedSearchAgent(t, s,
		"x-"+exactQuery+"-y", "host-sub-"+suffix, "user-sub-"+suffix)
	// Prefix-only: agent_name starts with query.
	prefixID := seedSearchAgent(t, s,
		exactQuery+"-tail", "host-pref-"+suffix, "user-pref-"+suffix)
	// Exact: agent_name equals query.
	exactID := seedSearchAgent(t, s,
		exactQuery, "host-exact-"+suffix, "user-exact-"+suffix)

	results, err := s.Search(ctx, exactQuery)
	if err != nil {
		t.Fatalf("Search(%q): %v", exactQuery, err)
	}
	if len(results.Agents) < 3 {
		t.Fatalf("expected 3 agent hits, got %d", len(results.Agents))
	}
	gotOrder := []string{
		results.Agents[0].AgentID,
		results.Agents[1].AgentID,
		results.Agents[2].AgentID,
	}
	wantOrder := []string{exactID, prefixID, subID}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Errorf("agent rank order: got %v, want %v", gotOrder, wantOrder)
	}
}

func TestSearch_AgentCrossFieldPrecedence(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	marker := "xfield-" + suffix

	// All three agents exact-match the query, each via a different
	// field. agent_name (rank 0) outranks hostname (rank 1) outranks
	// user_name (rank 2).
	userID := seedSearchAgent(t, s,
		"u-name-"+suffix, "u-host-"+suffix, marker)
	hostID := seedSearchAgent(t, s,
		"h-name-"+suffix, marker, "h-user-"+suffix)
	nameID := seedSearchAgent(t, s,
		marker, "n-host-"+suffix, "n-user-"+suffix)

	results, err := s.Search(ctx, marker)
	if err != nil {
		t.Fatalf("Search(%q): %v", marker, err)
	}
	if len(results.Agents) < 3 {
		t.Fatalf("expected 3 agent hits, got %d", len(results.Agents))
	}
	gotOrder := []string{
		results.Agents[0].AgentID,
		results.Agents[1].AgentID,
		results.Agents[2].AgentID,
	}
	wantOrder := []string{nameID, hostID, userID}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Errorf("agent cross-field order: got %v, want %v", gotOrder, wantOrder)
	}
}

func TestSearch_EventTypeLiteralMatch(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	agentID := seedSearchAgent(t, s,
		"event-literal-"+suffix, "h-"+suffix, "u-"+suffix)
	_ = seedSearchSessionWithEvents(t, s, agentID, "search-flavor-"+suffix,
		[]struct {
			EventType string
			ToolName  string
			Model     string
		}{
			{EventType: "post_call", Model: "test-model-search-" + suffix},
		})

	// Searching for the rare model substring uniquely identifies
	// our fresh row and exercises the events path end-to-end.
	results, err := s.Search(ctx, "test-model-search-"+suffix)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results.Events) != 1 {
		t.Fatalf("expected 1 event hit, got %d", len(results.Events))
	}
	if results.Events[0].EventType != "post_call" {
		t.Errorf("EventType: got %q, want post_call", results.Events[0].EventType)
	}
}

func TestSearch_EventTypeBareLiteralRanksFirst(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	agentID := seedSearchAgent(t, s,
		"event-bare-"+suffix, "h-"+suffix, "u-"+suffix)

	// Seed three events that all match the literal ``post_call``
	// via different fields:
	//   - event_type=post_call         → rank 0 (event_type exact)
	//   - tool_name="post_call"        → rank 1 (tool_name exact)
	//   - model="post_call-derivative" → rank 9 (model substring)
	_ = seedSearchSessionWithEvents(t, s, agentID, "bare-"+suffix,
		[]struct {
			EventType string
			ToolName  string
			Model     string
		}{
			{EventType: "post_call", Model: "uniqmodel-" + suffix},
			{EventType: "tool_call", ToolName: "post_call", Model: "uniqmodel2-" + suffix},
			{EventType: "tool_call", Model: "post_call-derivative-" + suffix},
		})

	results, err := s.Search(ctx, "post_call")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results.Events) == 0 {
		t.Fatalf("expected ≥1 event hit, got 0")
	}
	if results.Events[0].EventType != "post_call" {
		t.Errorf("rank 0 row: want event_type=post_call, got %q (tool=%q model=%q)",
			results.Events[0].EventType, results.Events[0].ToolName, results.Events[0].Model)
	}
}

func TestSearch_CuratedTermReturnsMappedEventTypes(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	agentID := seedSearchAgent(t, s,
		"curated-"+suffix, "h-"+suffix, "u-"+suffix)

	// Seed one event for each curated llm type. Future-dated, so the
	// query that opens the events group sees these rows ahead of the
	// dev-DB pool.
	_ = seedSearchSessionWithEvents(t, s, agentID, "curated-"+suffix,
		[]struct {
			EventType string
			ToolName  string
			Model     string
		}{
			{EventType: "llm_error"},
			{EventType: "post_call"},
			{EventType: "pre_call"},
		})

	results, err := s.Search(ctx, "LLM")
	if err != nil {
		t.Fatalf("Search(LLM): %v", err)
	}
	if len(results.Events) == 0 {
		t.Fatalf("expected ≥1 event hit for LLM, got 0")
	}
	allowed := map[string]bool{
		"pre_call": true, "post_call": true, "llm_error": true,
	}
	for _, e := range results.Events {
		if !allowed[e.EventType] {
			t.Errorf("LLM query returned event_type %q not in curated llm list", e.EventType)
		}
	}
}

func TestSearch_CuratedPolicyTermSurfacesPolicyEvents(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	agentID := seedSearchAgent(t, s,
		"policy-curated-"+suffix, "h-"+suffix, "u-"+suffix)
	_ = seedSearchSessionWithEvents(t, s, agentID, "policy-curated-"+suffix,
		[]struct {
			EventType string
			ToolName  string
			Model     string
		}{
			{EventType: "policy_warn"},
			{EventType: "policy_mcp_block"},
		})

	results, err := s.Search(ctx, "policy")
	if err != nil {
		t.Fatalf("Search(policy): %v", err)
	}
	if len(results.Events) == 0 {
		t.Fatalf("expected ≥1 event hit, got 0")
	}
	allowed := map[string]bool{
		"policy_warn": true, "policy_degrade": true, "policy_block": true,
		"policy_mcp_warn": true, "policy_mcp_block": true,
	}
	for _, e := range results.Events {
		if !allowed[e.EventType] {
			t.Errorf("policy query returned event_type %q not in curated policy list", e.EventType)
		}
	}
}

func TestSearch_EventCrossFieldPrecedence(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	suffix := randomUUID(t)[:8]
	marker := "xfev-" + suffix
	agentID := seedSearchAgent(t, s,
		"xf-"+suffix, "h-"+suffix, "u-"+suffix)

	// All three rows exact-match the marker, each via a different
	// field. With cross-field precedence event_type > tool_name >
	// model the row order should follow.
	//
	// event_type accepts any TEXT in this schema; we use the marker
	// as the literal value.
	_ = seedSearchSessionWithEvents(t, s, agentID, "xf-"+suffix,
		[]struct {
			EventType string
			ToolName  string
			Model     string
		}{
			{EventType: "tool_call", Model: marker},  // rank 2: model exact
			{EventType: "tool_call", ToolName: marker}, // rank 1: tool_name exact
			{EventType: marker},                       // rank 0: event_type exact
		})

	results, err := s.Search(ctx, marker)
	if err != nil {
		t.Fatalf("Search(%q): %v", marker, err)
	}
	if len(results.Events) < 3 {
		t.Fatalf("expected ≥3 event hits, got %d", len(results.Events))
	}
	if results.Events[0].EventType != marker {
		t.Errorf("rank 0: want event_type=%q, got %q", marker, results.Events[0].EventType)
	}
	if results.Events[1].ToolName != marker {
		t.Errorf("rank 1: want tool_name=%q, got %q", marker, results.Events[1].ToolName)
	}
	if results.Events[2].Model != marker {
		t.Errorf("rank 2: want model=%q, got %q", marker, results.Events[2].Model)
	}
}
