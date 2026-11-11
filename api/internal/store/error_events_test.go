package store

import (
	"context"
	"slices"
	"testing"
	"time"
)

func TestExpandMCPServerFilter(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []string
		want []string
	}{
		{"empty", nil, nil},
		{"plain server unchanged", []string{"github"}, []string{"github"}},
		{"plugin colon key adds the flattened key",
			[]string{"plugin:claude-mem:mcp-search"},
			[]string{"plugin:claude-mem:mcp-search", "plugin_claude-mem_mcp-search"}},
		{"server part with underscores",
			[]string{"plugin:foo:bar_baz"},
			[]string{"plugin:foo:bar_baz", "plugin_foo_bar_baz"}},
		// A plugin name with an underscore cannot have come from the
		// flattened key (the rebuild splits at the first underscore),
		// so there is no older spelling to add.
		{"plugin name with underscore",
			[]string{"plugin:my_plugin:srv"}, []string{"plugin:my_plugin:srv"}},
		{"flattened key passes through",
			[]string{"plugin_foo_bar"}, []string{"plugin_foo_bar"}},
		{"empty server part", []string{"plugin:foo:"}, []string{"plugin:foo:"}},
		{"mixed",
			[]string{"github", "plugin:a:b"},
			[]string{"github", "plugin:a:b", "plugin_a_b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := expandMCPServerFilter(tc.in); !slices.Equal(got, tc.want) {
				t.Errorf("expandMCPServerFilter(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// errorEventsScenario is one agent with three sessions:
//
//   - mixed: an llm_error (rate_limit), a failed tool_call (other), a
//     successful tool_call, tool_calls whose error is a plain string,
//     a JSON null and an array (none of them an object, so none is an
//     error), and a failed mcp_tool_call (invalid_params);
//   - toolOnly: one failed tool_call (other) and nothing else;
//   - mcpOnly: one failed mcp_tool_call carrying error_type=other, as
//     the plugin stores an MCP tool failure.
type errorEventsScenario struct {
	agentID, flavor           string
	mixed, toolOnly, mcpOnly  string
	from, to                  time.Time
	wantErrors                int64
	wantMixedTypes, wantTools []string
}

func seedErrorEventsScenario(t *testing.T, s *Store) errorEventsScenario {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	sc := errorEventsScenario{
		agentID: randomUUID(t), flavor: "test-error-events-" + randomUUID(t)[:8],
		mixed: randomUUID(t), toolOnly: randomUUID(t), mcpOnly: randomUUID(t),
		from: now.Add(-2 * time.Hour), to: now,
		// The llm_error and the two failed tool_calls.
		wantErrors:     3,
		wantMixedTypes: []string{"other", "rate_limit"},
		wantTools:      []string{"other"},
	}
	seedAgent(t, s, sc.agentID, now.Add(-time.Hour), now, 3, 0)
	for _, sid := range []string{sc.mixed, sc.toolOnly, sc.mcpOnly} {
		seedSession(t, s, sc.agentID, sid, now.Add(-time.Hour), now.Add(-time.Minute), 0)
	}
	toolErr := `{"error":{"error_type":"other","error_class":"PluginToolError","message":"<redacted>"}}`
	for _, e := range []struct{ sid, eventType, payload string }{
		{sc.mixed, "llm_error", `{"error":{"error_type":"rate_limit","provider":"anthropic"}}`},
		{sc.mixed, "tool_call", toolErr},
		{sc.mixed, "tool_call", `{"tool_use_id":"toolu_ok"}`},
		{sc.mixed, "tool_call", `{"error":"not a structured block"}`},
		{sc.mixed, "tool_call", `{"error":null}`},
		{sc.mixed, "tool_call", `{"error":[{"error_type":"other"}]}`},
		{sc.mixed, "mcp_tool_call", `{"server_name":"github","error":{"error_type":"invalid_params","error_class":"McpError"}}`},
		{sc.toolOnly, "tool_call", toolErr},
		{sc.mcpOnly, "mcp_tool_call", `{"server_name":"github","error":{"error_type":"other","error_class":"PluginToolError"}}`},
	} {
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO events (session_id, flavor, event_type, tool_name, payload, occurred_at)
			VALUES ($1, $2, $3, 'Bash', $4, $5)`,
			e.sid, sc.flavor, e.eventType, e.payload, now.Add(-30*time.Minute)); err != nil {
			t.Fatalf("seed %s: %v", e.eventType, err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM events WHERE `+s.d.InUUIDArray("session_id", "$1"),
			s.d.ArrayArg([]string{sc.mixed, sc.toolOnly, sc.mcpOnly}))
	})
	return sc
}

func TestGetSessions_ErrorTypesCountFailedToolCalls(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		sc := seedErrorEventsScenario(t, s)

		resp, err := s.GetSessions(ctx, SessionsParams{
			From: sc.from, To: sc.to, AgentID: sc.agentID, Limit: 100,
		})
		if err != nil {
			t.Fatalf("GetSessions: %v", err)
		}
		byID := map[string]SessionListItem{}
		for _, row := range resp.Sessions {
			byID[row.SessionID] = row
		}
		for _, tc := range []struct {
			name, sid      string
			wantErrorTypes []string
			wantMCPTypes   []string
		}{
			{"mixed", sc.mixed, sc.wantMixedTypes, []string{"invalid_params"}},
			{"failed tool_call only", sc.toolOnly, sc.wantTools, []string{}},
			{"failed mcp_tool_call only", sc.mcpOnly, []string{}, []string{"other"}},
		} {
			row, ok := byID[tc.sid]
			if !ok {
				t.Fatalf("%s: session missing from the listing", tc.name)
			}
			got := slices.Clone(row.ErrorTypes)
			slices.Sort(got)
			if !slices.Equal(got, tc.wantErrorTypes) {
				t.Errorf("%s: error_types = %q, want %q", tc.name, got, tc.wantErrorTypes)
			}
			if !slices.Equal(row.MCPErrorTypes, tc.wantMCPTypes) {
				t.Errorf("%s: mcp_error_types = %q, want %q", tc.name, row.MCPErrorTypes, tc.wantMCPTypes)
			}
		}

		// The error_type filter matches what the aggregate shows: "other"
		// selects the two sessions with a failed tool_call and not the one
		// whose only failure is an MCP call.
		filtered, err := s.GetSessions(ctx, SessionsParams{
			From: sc.from, To: sc.to, AgentID: sc.agentID, Limit: 100,
			ErrorTypes: []string{"other"},
		})
		if err != nil {
			t.Fatalf("GetSessions(error_type=other): %v", err)
		}
		var got []string
		for _, row := range filtered.Sessions {
			got = append(got, row.SessionID)
		}
		want := []string{sc.mixed, sc.toolOnly}
		slices.Sort(got)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Errorf("error_type=other matched %q, want %q", got, want)
		}
	})
}

func TestAgentSummary_ErrorsCountFailedToolCalls(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		sc := seedErrorEventsScenario(t, s)

		resp, err := s.AgentSummary(ctx, AgentSummaryParams{
			AgentID: sc.agentID, Period: "24h", Bucket: "hour",
		})
		if err != nil {
			t.Fatalf("AgentSummary: %v", err)
		}
		if resp.Totals.Errors != sc.wantErrors {
			t.Errorf("totals.errors = %d, want %d (the llm_error and the two failed tool_calls)",
				resp.Totals.Errors, sc.wantErrors)
		}
		var seriesErrors int64
		for _, p := range resp.Series {
			seriesErrors += p.Errors
		}
		if seriesErrors != sc.wantErrors {
			t.Errorf("series errors sum = %d, want %d", seriesErrors, sc.wantErrors)
		}
	})
}

// TestGetEventFacets_MCPServerPluginKeyNormalised seeds one plugin-
// bundled server under both spellings the plugin has stored (the
// flattened key of older releases and the colon key) plus a plain
// server, and checks the facet reads them as one value and a filter on
// the colon key returns both rows.
func TestGetEventFacets_MCPServerPluginKeyNormalised(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now().UTC().Truncate(time.Millisecond)
		agentID, sessionID := randomUUID(t), randomUUID(t)
		flavor := "test-mcp-plugin-key-" + randomUUID(t)[:8]
		seedAgent(t, s, agentID, now.Add(-time.Hour), now, 1, 0)
		seedSession(t, s, agentID, sessionID, now.Add(-time.Hour), now.Add(-time.Minute), 0)
		for _, server := range []string{
			"plugin_claude-mem_mcp-search",
			"plugin:claude-mem:mcp-search",
			"plugin:claude-mem:mcp-search",
			"github",
		} {
			if _, err := s.db.ExecContext(ctx, `
				INSERT INTO events (session_id, flavor, event_type, payload, occurred_at)
				VALUES ($1, $2, 'mcp_tool_call', $3, $4)`,
				sessionID, flavor, jsonObject(t, map[string]any{"server_name": server}), now.Add(-30*time.Minute)); err != nil {
				t.Fatalf("seed %s: %v", server, err)
			}
		}
		t.Cleanup(func() {
			_, _ = s.db.ExecContext(ctx, `DELETE FROM events WHERE session_id = $1`, sessionID)
		})
		from, to := now.Add(-time.Hour), now

		facets, err := s.GetEventFacets(ctx, EventsParams{From: from, To: to, SessionID: sessionID})
		if err != nil {
			t.Fatalf("GetEventFacets: %v", err)
		}
		want := []EventFacetValue{
			{Value: "plugin:claude-mem:mcp-search", Count: 3},
			{Value: "github", Count: 1},
		}
		if !slices.Equal(facets.MCPServer, want) {
			t.Errorf("mcp_server facet = %+v, want %+v", facets.MCPServer, want)
		}

		for _, tc := range []struct {
			filter string
			want   int
		}{
			{"plugin:claude-mem:mcp-search", 3},
			{"plugin_claude-mem_mcp-search", 1},
			{"github", 1},
		} {
			resp, err := s.GetEvents(ctx, EventsParams{
				From: from, To: to, SessionID: sessionID, Limit: 100,
				MCPServers: []string{tc.filter},
			})
			if err != nil {
				t.Fatalf("GetEvents(mcp_server=%s): %v", tc.filter, err)
			}
			if resp.Total != tc.want {
				t.Errorf("mcp_server=%s: total = %d, want %d", tc.filter, resp.Total, tc.want)
			}
		}
	})
}
