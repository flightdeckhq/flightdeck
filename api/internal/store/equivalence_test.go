package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The cross-backend equivalence test: one deterministic fixture is
// seeded on every covered backend and every analytics metric x
// dimension combination (CLAUDE.md rules 25 and 26, single axis and
// every ordered pair of axes), a set of sessions-list shapes, the
// events list and facets, the agent list, search and the per-session
// reads are run against it. Each backend's results are canonicalised
// (floating-point values rounded to nine significant digits, since
// Postgres computes cost in decimal and SQLite in binary) and compared
// to testdata/equivalence_golden.json, so the two engines are proved
// equal through the golden. The analytics grid is some two thousand
// responses, so the golden keeps those as the SHA-256 of their
// canonical JSON (a mismatch prints the response) and every other
// result in full. Regenerate the golden with
//
//	go test ./internal/store -run TestCrossBackendEquivalence -update
//
// on either backend after an intended change to a query's result.
var updateGolden = flag.Bool("update", false, "rewrite testdata/equivalence_golden.json from this run")

const equivalenceGoldenPath = "testdata/equivalence_golden.json"

// eqvFixture holds the ids of the seeded rows.
type eqvFixture struct {
	flavorA, flavorB  string
	agentA, agentB    string
	agentC            string
	parent, childR    string
	childW, grand     string
	lone, bare        string
	noFrameworks, otl string
	sessionIDs        []string
	eventIDs          []string
	contentEventID    string
	from, to          time.Time
}

// eqvBase is the fixture's anchor: a fixed instant so the golden never
// moves with the clock.
var eqvBase = time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

// eqvUUID returns a deterministic canonical UUID for a fixture label.
func eqvUUID(n int) string {
	return fmt.Sprintf("e0e0e0e0-0000-4000-8000-%012x", n)
}

func seedEquivalenceFixture(t *testing.T, s *Store) eqvFixture {
	t.Helper()
	ctx := context.Background()
	f := eqvFixture{
		flavorA: "eqv-alpha", flavorB: "eqv-beta",
		agentA: eqvUUID(1), agentB: eqvUUID(2), agentC: eqvUUID(3),
		parent: eqvUUID(11), childR: eqvUUID(12), childW: eqvUUID(13), grand: eqvUUID(14),
		lone: eqvUUID(15), bare: eqvUUID(16), noFrameworks: eqvUUID(17), otl: eqvUUID(18),
		from: eqvBase.Add(-time.Hour), to: eqvBase.Add(4 * 24 * time.Hour),
	}
	f.sessionIDs = []string{f.parent, f.childR, f.childW, f.grand, f.lone, f.bare, f.noFrameworks, f.otl}
	cleanup := func() {
		for _, q := range []string{
			`DELETE FROM event_content WHERE session_id IN (SELECT session_id FROM sessions WHERE flavor IN ($1, $2))`,
			`DELETE FROM events WHERE flavor IN ($1, $2)`,
			`DELETE FROM session_attachments WHERE session_id IN (SELECT session_id FROM sessions WHERE flavor IN ($1, $2))`,
			`DELETE FROM directives WHERE flavor IN ($1, $2) OR session_id IN (SELECT session_id FROM sessions WHERE flavor IN ($1, $2))`,
			`DELETE FROM token_policies WHERE scope = 'flavor' AND scope_value IN ($1, $2)`,
			`DELETE FROM mcp_policies WHERE scope = 'flavor' AND scope_value IN ($1, $2)`,
			`DELETE FROM custom_directives WHERE flavor IN ($1, $2)`,
		} {
			if _, err := s.db.ExecContext(ctx, q, f.flavorA, f.flavorB); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
		// Children before parents (the self-referencing FK).
		for _, id := range []string{f.grand, f.childR, f.childW, f.parent, f.lone, f.bare, f.noFrameworks, f.otl} {
			if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE session_id = $1`, id); err != nil {
				t.Errorf("cleanup session %s: %v", id, err)
			}
		}
		for _, id := range []string{f.agentA, f.agentB, f.agentC} {
			if _, err := s.db.ExecContext(ctx, `DELETE FROM agents WHERE agent_id = $1`, id); err != nil {
				t.Errorf("cleanup agent %s: %v", id, err)
			}
		}
		if _, err := s.db.ExecContext(ctx, `DELETE FROM model_pricing WHERE model_id LIKE 'eqv-%'`); err != nil {
			t.Errorf("cleanup prices: %v", err)
		}
	}
	// A previous run that died mid-way may have left its rows.
	cleanup()
	t.Cleanup(cleanup)
	// The price table is the fixture's alone: a shared Postgres test
	// database may hold the catalogue a pricing-loader test wrote, which
	// would price the fixture's real model names on one backend and not
	// the other. The API rebuilds the table at its next start.
	for _, q := range []string{`DELETE FROM model_pricing`, `DELETE FROM model_pricing_meta`} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			t.Fatalf("clear prices: %v", err)
		}
	}

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := s.db.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, query)
		}
	}

	// Agents: three identities with distinct hosts and client types.
	for _, a := range []struct {
		id, name, user, host, agentType, clientType string
		sessions                                    int
		tokens                                      int64
	}{
		{f.agentA, "eqv-orchestrator", "alice", "eqv-host-a", "production", "flightdeck_sensor", 4, 2400},
		{f.agentB, "eqv-coder", "bob", "eqv-host-b", "coding", "claude_code", 3, 900},
		{f.agentC, "eqv-otel", "carol", "eqv-host-c", "production", "otlp", 1, 100},
	} {
		exec(`INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname,
			first_seen_at, last_seen_at, total_sessions, total_tokens)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			a.id, a.agentType, a.clientType, a.name, a.user, a.host,
			eqvBase, eqvBase.Add(2*24*time.Hour), a.sessions, a.tokens)
	}

	// Sessions: a parent with two children and a grandchild, a lone
	// run, a bare-framework run, a run without frameworks and an OTLP
	// run.
	type sess struct {
		id, agent, flavor, agentType, clientType string
		host, framework, model                   *string
		state                                    string
		started, lastSeen                        time.Time
		ended                                    *time.Time
		tokens                                   int
		tokenLimit                               *int64
		context                                  string
		parent, role                             *string
		capture                                  *bool
	}
	str := func(v string) *string { return &v }
	i64 := func(v int64) *int64 { return &v }
	tru, fals := true, false
	day := 24 * time.Hour
	end := func(t time.Time) *time.Time { return &t }
	sessions := []sess{
		{f.parent, f.agentA, f.flavorA, "production", "flightdeck_sensor", str("eqv-host-a"), str("langchain"), str("claude-sonnet-4-5"),
			"closed", eqvBase.Add(1 * time.Hour), eqvBase.Add(3 * time.Hour), end(eqvBase.Add(3 * time.Hour)), 1200, i64(100000),
			`{"frameworks": ["langchain/0.3.1", "crewai/0.5"], "os": "Linux", "arch": "x86_64", "hostname": "eqv-host-a", "user": "alice", "git_branch": "main", "git_repo": "eqv/repo", "orchestration": "kubernetes", "python_version": "3.12.1", "process_name": "orchestrator", "mcp_servers": [{"name": "fs", "url": "stdio://fs"}, {"name": "git", "url": "stdio://git"}], "supports_directives": true}`,
			nil, nil, &tru},
		{f.childR, f.agentA, f.flavorA, "production", "flightdeck_sensor", str("eqv-host-a"), str("crewai"), str("gpt-4o"),
			"closed", eqvBase.Add(1*time.Hour + 5*time.Minute), eqvBase.Add(2 * time.Hour), end(eqvBase.Add(2 * time.Hour)), 400, nil,
			`{"frameworks": ["crewai/0.5"], "os": "Linux", "hostname": "eqv-host-a", "user": "alice", "mcp_servers": [{"name": "fs"}]}`,
			str(f.parent), str("Researcher"), &tru},
		{f.childW, f.agentA, f.flavorA, "production", "flightdeck_sensor", str("eqv-host-a"), str("crewai"), str("gpt-4o"),
			"closed", eqvBase.Add(1*time.Hour + 20*time.Minute), eqvBase.Add(2*time.Hour + 30*time.Minute), end(eqvBase.Add(2*time.Hour + 30*time.Minute)), 300, nil,
			`{"frameworks": ["crewai/0.5", "crewai/0.6"], "os": "Linux", "hostname": "eqv-host-a"}`,
			str(f.parent), str("Writer"), &fals},
		{f.grand, f.agentA, f.flavorA, "production", "flightdeck_sensor", str("eqv-host-a"), nil, str("gemini-2.5-pro"),
			"closed", eqvBase.Add(1*time.Hour + 10*time.Minute), eqvBase.Add(1*time.Hour + 40*time.Minute), end(eqvBase.Add(1*time.Hour + 40*time.Minute)), 100, nil,
			`{}`, str(f.childR), str("Fact checker"), nil},
		{f.lone, f.agentB, f.flavorB, "coding", "claude_code", str("eqv-host-b"), nil, str("claude-opus-4-1"),
			"closed", eqvBase.Add(1*day + 2*time.Hour), eqvBase.Add(1*day + 5*time.Hour), end(eqvBase.Add(1*day + 5*time.Hour)), 500, nil,
			`{"frameworks": ["claude-code/2.0.1"], "os": "Darwin", "arch": "arm64", "hostname": "eqv-host-b", "user": "bob", "git_branch": "feat/x", "python_version": "3.11.4"}`,
			nil, nil, &fals},
		{f.bare, f.agentB, f.flavorB, "coding", "claude_code", str("eqv-host-b"), str("langchain"), str("ft:gpt-4o:eqv::abc"),
			"closed", eqvBase.Add(2*day + 1*time.Hour), eqvBase.Add(2*day + 2*time.Hour), end(eqvBase.Add(2*day + 2*time.Hour)), 250, nil,
			`{"frameworks": ["langchain"], "os": "Darwin", "hostname": "eqv-host-b", "supports_directives": "true"}`,
			nil, nil, nil},
		{f.noFrameworks, f.agentB, f.flavorB, "coding", "claude_code", nil, nil, nil,
			"lost", eqvBase.Add(2*day + 3*time.Hour), eqvBase.Add(2*day + 4*time.Hour), end(eqvBase.Add(2*day + 4*time.Hour)), 150, nil,
			`{"frameworks": "not-an-array", "os": "Windows"}`, nil, nil, nil},
		{f.otl, f.agentC, f.flavorA, "production", "otlp", str("eqv-host-c"), str("openai-agents"), str("o3-mini"),
			"closed", eqvBase.Add(3*day + 1*time.Hour), eqvBase.Add(3*day + 1*time.Hour + 30*time.Minute), end(eqvBase.Add(3*day + 1*time.Hour + 30*time.Minute)), 100, nil,
			`{"telemetry": "otlp", "os": "Linux", "hostname": "eqv-host-c", "frameworks": []}`, nil, nil, &tru},
	}
	for _, x := range sessions {
		exec(`INSERT INTO sessions (session_id, agent_id, flavor, agent_type, client_type, host, framework, model,
			state, started_at, last_seen_at, ended_at, tokens_used, token_limit, context,
			parent_session_id, agent_role, capture_prompts, agent_name, token_name)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
			x.id, x.agent, x.flavor, x.agentType, x.clientType, x.host, x.framework, x.model,
			x.state, x.started, x.lastSeen, x.ended, x.tokens, x.tokenLimit, x.context,
			x.parent, x.role, x.capture, "agent-"+x.id[len(x.id)-4:], "Development Token")
	}
	exec(`INSERT INTO session_attachments (id, session_id, attached_at) VALUES ($1, $2, $3)`, eqvUUID(201), f.parent, eqvBase.Add(2*time.Hour))
	exec(`INSERT INTO session_attachments (id, session_id, attached_at) VALUES ($1, $2, $3)`, eqvUUID(202), f.parent, eqvBase.Add(2*time.Hour+30*time.Minute))

	// Prices: a direct and a bedrock row for model a, a tiered model b
	// with per-model multipliers, and a deprecated model.
	exec(`INSERT INTO model_pricing (model_id, platform, provider, input, output, cache_read, cache_write_5m, cache_write_1h, source)
		VALUES ('eqv-model-a', 'direct', 'other', 3, 15, 0.3, 3.75, 6, 'override')`)
	exec(`INSERT INTO model_pricing (model_id, platform, provider, input, output, cache_read, cache_write_5m, cache_write_1h, source)
		VALUES ('eqv-model-a', 'bedrock', 'other', 3.3, 16.5, 0.33, 4.125, 6.6, 'override')`)
	exec(`INSERT INTO model_pricing (model_id, platform, provider, input, output, cache_read, cache_write_5m, cache_write_1h,
		reasoning, tier_threshold_tokens, tier_input, tier_output, priority_multiplier, fast_multiplier, source)
		VALUES ('eqv-model-b', 'direct', 'other', 2, 8, 0.2, 2.5, 4, 10, 1000, 4, 16, 2, 1.5, 'override')`)
	exec(`INSERT INTO model_pricing (model_id, platform, provider, input, output, cache_read, cache_write_5m, cache_write_1h, source, deprecated_on)
		VALUES ('eqv-model-old', 'direct', 'other', 1, 2, 0.1, 1, 2, 'override', $1)`, "2025-01-01")

	// Events across the sessions: post_calls with tokens, latency,
	// providers, billing modes, platforms and payload multipliers;
	// errors (terminal and not), a failed tool_call, policy events,
	// MCP events with server names and a matched entry, pre_calls with
	// estimated_via, session_ends with close reasons, an embeddings
	// call and a failed stream.
	type ev struct {
		id, session, flavor, eventType string
		model                          *string
		in, out, total                 *int
		cacheRead, cacheCreation       int
		reasoning                      *int
		latency                        *int
		tool                           *string
		hasContent                     bool
		payload                        string
		at                             time.Time
		provider, billing, platform    *string
		costReported                   *float64
		costSource                     *string
	}
	ints := func(v int) *int { return &v }
	flt := func(v float64) *float64 { return &v }
	var events []ev
	n := 1000
	add := func(e ev) {
		n++
		e.id = eqvUUID(n)
		events = append(events, e)
	}
	// Parent: five post_calls on day 0 with varied latency, one with a
	// NULL latency, one priority-tier call on the tiered model, one
	// bedrock call, one with a reported cost.
	p := eqvBase.Add(1*time.Hour + 1*time.Minute)
	for i, lat := range []*int{ints(120), ints(340), ints(90), nil, ints(2200)} {
		add(ev{session: f.parent, flavor: f.flavorA, eventType: "post_call", model: str("eqv-model-a"),
			in: ints(1000 + 100*i), out: ints(200 + 10*i), total: ints(1200 + 110*i), cacheRead: 100 * i, cacheCreation: 50,
			latency: lat, payload: `{"estimated_via": "tiktoken", "service_tier": "batch"}`, at: p.Add(time.Duration(i) * time.Minute),
			provider: str("anthropic"), billing: str("metered"), platform: nil})
	}
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "post_call", model: str("eqv-model-b"),
		in: ints(1500), out: ints(300), total: ints(1800), reasoning: ints(100), latency: ints(800),
		payload: `{"service_tier": "priority", "speed": "fast", "tokens_cache_creation_1h": 20, "server_tool_use": {"web_search_requests": 2}, "inference_geo": "us"}`,
		at:      p.Add(10 * time.Minute), provider: str("openai"), billing: str("metered"), platform: str("direct")})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "post_call", model: str("eqv-model-a-20260101"),
		in: ints(500), out: ints(50), total: ints(550), latency: ints(400), payload: `{}`,
		at: p.Add(11 * time.Minute), provider: nil, billing: str("metered"), platform: str("bedrock-mantle")})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "post_call", model: str("eqv-unpriced"),
		in: ints(700), out: ints(70), total: ints(770), latency: ints(150), payload: `{}`,
		at: p.Add(12 * time.Minute), provider: str("other"), billing: str("metered"), platform: nil,
		costReported: flt(0.0123), costSource: str("agent")})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "post_call", model: str("eqv-unpriced-2"),
		in: ints(70), out: ints(7), total: ints(77), latency: ints(50), payload: `{}`,
		at: p.Add(13 * time.Minute), provider: str("other"), billing: str("metered"), platform: nil})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "pre_call", model: str("eqv-model-a"),
		payload: `{"estimated_via": "heuristic"}`, at: p.Add(14 * time.Minute)})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "llm_error", model: str("eqv-model-a"),
		in: ints(300), out: ints(30), total: ints(330), latency: ints(900),
		payload: `{"error": {"error_type": "rate_limit", "message": "slow down"}, "terminal": false}`,
		at:      p.Add(15 * time.Minute), provider: str("anthropic"), billing: str("metered")})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "tool_call", tool: str("web_search"),
		payload: `{"error": {"error_type": "timeout"}, "duration_ms": 5000}`, at: p.Add(16 * time.Minute)})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "tool_call", tool: str("read_file"),
		payload: `{"duration_ms": 12}`, at: p.Add(17 * time.Minute)})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "policy_warn", payload: `{"pct": 80}`, at: p.Add(18 * time.Minute)})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "policy_mcp_block",
		payload: `{"server_name": "evil", "fingerprint": "fp-evil", "policy_id": "` + eqvUUID(900) + `", "policy_decision": {"matched_entry_id": "` + eqvUUID(901) + `"}, "originating_call_context": "call_tool"}`,
		at:      p.Add(19 * time.Minute)})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "mcp_tool_call", tool: str("fs.read"),
		payload: `{"server_name": "plugin_acme_fs", "originating_call_context": "call_tool"}`, at: p.Add(20 * time.Minute)})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "mcp_tool_call", tool: str("fs.write"),
		payload: `{"server_name": "plugin:acme:fs", "error": {"error_type": "permission_denied"}}`, at: p.Add(21 * time.Minute)})
	add(ev{session: f.parent, flavor: f.flavorA, eventType: "session_end",
		payload: `{"close_reason": "normal_exit"}`, at: p.Add(119 * time.Minute)})
	// Children: tokens and latencies on day 0, a terminal error.
	for i := 0; i < 3; i++ {
		add(ev{session: f.childR, flavor: f.flavorA, eventType: "post_call", model: str("gpt-4o"),
			in: ints(100 + i), out: ints(20), total: ints(120 + i), latency: ints(300 + 100*i), payload: `{"estimated_via": "none"}`,
			at: eqvBase.Add(1*time.Hour + time.Duration(6+i)*time.Minute), provider: nil, billing: str("metered")})
	}
	add(ev{session: f.childR, flavor: f.flavorA, eventType: "llm_error", model: str("gpt-4o"),
		payload: `{"error": {"error_type": "auth"}, "terminal": true}`, at: eqvBase.Add(1*time.Hour + 30*time.Minute), provider: str("openai")})
	add(ev{session: f.childR, flavor: f.flavorA, eventType: "session_end",
		payload: `{"close_reason": "directive_shutdown"}`, at: eqvBase.Add(2 * time.Hour)})
	add(ev{session: f.childW, flavor: f.flavorA, eventType: "post_call", model: str("gpt-4o"),
		in: ints(250), out: ints(50), total: ints(300), latency: ints(640), payload: `{}`,
		at: eqvBase.Add(1*time.Hour + 25*time.Minute), billing: str("metered")})
	add(ev{session: f.childW, flavor: f.flavorA, eventType: "embeddings", model: str("text-embedding-3-small"),
		in: ints(800), total: ints(800), latency: ints(70), payload: `{"estimated_via": "tiktoken"}`,
		at: eqvBase.Add(1*time.Hour + 26*time.Minute), billing: str("metered")})
	add(ev{session: f.grand, flavor: f.flavorA, eventType: "post_call", model: str("gemini-2.5-pro"),
		in: ints(90), out: ints(10), total: ints(100), latency: ints(510), payload: `{}`,
		at: eqvBase.Add(1*time.Hour + 12*time.Minute), billing: str("metered")})
	// Lone (day 1): a subscription-billed Claude Code run, a failed
	// stream with billed tokens, a block.
	for i := 0; i < 4; i++ {
		add(ev{session: f.lone, flavor: f.flavorB, eventType: "post_call", model: str("claude-opus-4-1"),
			in: ints(1000), out: ints(100 + i), total: ints(1100 + i), latency: ints(1000 + 250*i), payload: `{}`,
			at: eqvBase.Add(1*day + 2*time.Hour + time.Duration(i)*time.Minute), provider: str("anthropic"), billing: nil})
	}
	add(ev{session: f.lone, flavor: f.flavorB, eventType: "llm_error", model: str("claude-opus-4-1"),
		in: ints(400), out: ints(40), total: ints(440), latency: ints(3000),
		payload: `{"error": {"error_type": "stream_failed"}, "terminal": "true"}`,
		at:      eqvBase.Add(1*day + 2*time.Hour + 10*time.Minute), provider: str("anthropic")})
	add(ev{session: f.lone, flavor: f.flavorB, eventType: "policy_block", payload: `{"pct": 100}`, at: eqvBase.Add(1*day + 3*time.Hour)})
	add(ev{session: f.lone, flavor: f.flavorB, eventType: "session_end", payload: `{"close_reason": "policy_block"}`, at: eqvBase.Add(1*day + 5*time.Hour)})
	// Bare (day 2): a fine-tuned OpenAI model, metered on the direct
	// platform, priced by nothing.
	add(ev{session: f.bare, flavor: f.flavorB, eventType: "post_call", model: str("ft:gpt-4o:eqv::abc"),
		in: ints(10), out: ints(5), total: ints(15), latency: ints(260), payload: `{}`,
		at: eqvBase.Add(2*day + 1*time.Hour + 5*time.Minute), billing: str("metered")})
	add(ev{session: f.bare, flavor: f.flavorB, eventType: "policy_degrade", payload: `{"degrade_to": "gpt-4o-mini"}`, at: eqvBase.Add(2*day + 1*time.Hour + 6*time.Minute)})
	add(ev{session: f.bare, flavor: f.flavorB, eventType: "session_end", payload: `{"close_reason": "orphan_timeout"}`, at: eqvBase.Add(2*day + 2*time.Hour)})
	// noFrameworks (day 2): nothing but a lost run's last event.
	add(ev{session: f.noFrameworks, flavor: f.flavorB, eventType: "post_call", model: str("deepseek-chat"),
		in: ints(150), out: ints(0), total: ints(150), latency: ints(4000), payload: `{}`,
		at: eqvBase.Add(2*day + 3*time.Hour + 5*time.Minute), billing: str("metered")})
	// OTLP (day 3): a local model with content captured.
	add(ev{session: f.otl, flavor: f.flavorA, eventType: "post_call", model: str("o3-mini"),
		in: ints(60), out: ints(40), total: ints(100), latency: ints(730), hasContent: true, payload: `{}`,
		at: eqvBase.Add(3*day + 1*time.Hour + 2*time.Minute), provider: str("openai"), billing: str("local")})

	for _, e := range events {
		exec(`INSERT INTO events (id, session_id, flavor, event_type, model, tokens_input, tokens_output, tokens_total,
			tokens_cache_read, tokens_cache_creation, tokens_reasoning, latency_ms, tool_name, has_content, payload,
			occurred_at, provider, billing_mode, platform, cost_reported, cost_source)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
			e.id, e.session, e.flavor, e.eventType, e.model, e.in, e.out, e.total,
			e.cacheRead, e.cacheCreation, e.reasoning, e.latency, e.tool, e.hasContent, e.payload,
			e.at, e.provider, e.billing, e.platform, e.costReported, e.costSource)
		f.eventIDs = append(f.eventIDs, e.id)
		if e.hasContent {
			f.contentEventID = e.id
			exec(`INSERT INTO event_content (event_id, session_id, provider, model, system_prompt, messages, tools, response, captured_at)
				VALUES ($1, $2, 'openai', 'o3-mini', 'be brief', '[{"role":"user","content":"hi"}]', NULL, '{"content":"hello"}', $3)`,
				e.id, e.session, e.at)
		}
	}

	// A flavor token policy, a flavor MCP policy with two entries, a
	// pending directive and a registered custom directive.
	exec(`INSERT INTO token_policies (id, scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct, created_at, updated_at)
		VALUES ($1, 'flavor', $2, 50000, 70, 85, 'claude-haiku-4-5', 95, $3, $3)`, eqvUUID(301), f.flavorA, eqvBase)
	exec(`INSERT INTO mcp_policies (id, scope, scope_value, mode, block_on_uncertainty, created_at, updated_at)
		VALUES ($1, 'flavor', $2, NULL, TRUE, $3, $3)`, eqvUUID(900), f.flavorA, eqvBase)
	exec(`INSERT INTO mcp_policy_entries (id, policy_id, server_url_canonical, server_name, fingerprint, entry_kind, enforcement, created_at)
		VALUES ($1, $2, 'https://mcp.example.com/evil', 'evil', 'fp-evil', 'deny', 'block', $3)`, eqvUUID(901), eqvUUID(900), eqvBase)
	exec(`INSERT INTO mcp_policy_entries (id, policy_id, server_url_canonical, server_name, fingerprint, entry_kind, enforcement, created_at)
		VALUES ($1, $2, 'https://mcp.example.com/fs', 'fs', 'fp-fs', 'allow', NULL, $3)`, eqvUUID(902), eqvUUID(900), eqvBase.Add(time.Minute))
	exec(`INSERT INTO directives (id, session_id, flavor, action, reason, grace_period_ms, issued_by, issued_at)
		VALUES ($1, $2, NULL, 'shutdown', 'eqv', 5000, 'dashboard', $3)`, eqvUUID(401), f.parent, eqvBase.Add(2*time.Hour))
	exec(`INSERT INTO custom_directives (id, fingerprint, name, description, flavor, parameters, registered_at, last_seen_at)
		VALUES ($1, 'fp-eqv-1', 'eqv_pause', 'pause the run', $2, '{"seconds": {"type": "integer"}}', $3, $3)`, eqvUUID(501), f.flavorA, eqvBase)
	return f
}

// equivalenceResults runs every query of the grid and returns the
// results keyed by a description of the query.
func equivalenceResults(t *testing.T, s *Store, f eqvFixture) map[string]any {
	t.Helper()
	ctx := context.Background()
	out := map[string]any{}
	record := func(key string, v any, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		out[key] = v
	}

	// Analytics: every metric x dimension, single and two-axis, per
	// fixture flavor (the filter keeps other tests' rows on a shared
	// Postgres database out of the result), plus the sub-agent and
	// provider filters.
	for _, flavor := range []string{f.flavorA, f.flavorB} {
		for _, metric := range AnalyticsMetrics {
			for _, dim := range AnalyticsDimensions {
				base := AnalyticsParams{Metric: metric, GroupBy: dim, Range: "custom", From: f.from, To: f.to,
					Granularity: "day", FilterFlavor: flavor}
				resp, err := s.QueryAnalytics(ctx, base)
				record(fmt.Sprintf("analytics/%s/%s/%s", flavor, metric, dim), resp, err)
				for _, sec := range AnalyticsDimensions {
					if sec == dim {
						continue
					}
					two := base
					two.GroupBySecondary = sec
					resp, err := s.QueryAnalytics(ctx, two)
					record(fmt.Sprintf("analytics/%s/%s/%s,%s", flavor, metric, dim, sec), resp, err)
				}
			}
		}
	}
	for _, metric := range []string{"tokens", "sessions", "latency_p95", "estimated_cost", "child_count", "parent_to_first_child_latency_ms"} {
		for name, params := range map[string]AnalyticsParams{
			"week":          {Metric: metric, GroupBy: "model", Granularity: "week", FilterFlavor: f.flavorA},
			"hour":          {Metric: metric, GroupBy: "framework", Granularity: "hour", FilterFlavor: f.flavorA},
			"agent":         {Metric: metric, GroupBy: "agent_role", Granularity: "day", FilterAgentID: f.agentA},
			"provider":      {Metric: metric, GroupBy: "model", Granularity: "day", FilterFlavor: f.flavorA, FilterProvider: "openai"},
			"model":         {Metric: metric, GroupBy: "flavor", Granularity: "day", FilterFlavor: f.flavorA, FilterModel: "gpt-4o"},
			"agent_type":    {Metric: metric, GroupBy: "host", Granularity: "day", FilterFlavor: f.flavorA, FilterAgentType: "production"},
			"is_sub_agent":  {Metric: metric, GroupBy: "parent_session_id", Granularity: "day", FilterFlavor: f.flavorA, FilterIsSubAgent: true},
			"has_sub":       {Metric: metric, GroupBy: "agent_role", Granularity: "day", FilterFlavor: f.flavorA, FilterHasSubAgents: true},
			"both_topology": {Metric: metric, GroupBy: "model", Granularity: "day", FilterFlavor: f.flavorA, FilterIsSubAgent: true, FilterHasSubAgents: true},
			"parent":        {Metric: metric, GroupBy: "agent_role", Granularity: "day", FilterParentSessionID: f.parent},
		} {
			params.Range, params.From, params.To = "custom", f.from, f.to
			resp, err := s.QueryAnalytics(ctx, params)
			record(fmt.Sprintf("analytics-filter/%s/%s", metric, name), resp, err)
		}
	}

	// Sessions list shapes.
	flavors := []string{f.flavorA, f.flavorB}
	fals := false
	for name, params := range map[string]SessionsParams{
		"default":          {Flavors: flavors},
		"asc":              {Flavors: flavors, Order: "asc"},
		"sort_duration":    {Flavors: flavors, Sort: "duration"},
		"sort_tokens":      {Flavors: flavors, Sort: "tokens_used", Order: "asc"},
		"sort_state":       {Flavors: flavors, Sort: "state"},
		"sort_hostname":    {Flavors: flavors, Sort: "hostname", Order: "asc"},
		"sort_model":       {Flavors: flavors, Sort: "model"},
		"sort_last_seen":   {Flavors: flavors, Sort: "last_seen_at"},
		"page2":            {Flavors: flavors, Limit: 3, Offset: 3},
		"states":           {Flavors: flavors, States: []string{"lost", "closed"}},
		"agent":            {Flavors: flavors, AgentID: f.agentB},
		"agent_types":      {Flavors: flavors, AgentTypes: []string{"coding"}},
		"client_types":     {Flavors: flavors, ClientTypes: []string{"flightdeck_sensor", "otlp"}},
		"error_types":      {Flavors: flavors, ErrorTypes: []string{"rate_limit", "auth"}},
		"policy_events":    {Flavors: flavors, PolicyEventTypes: []string{"policy_block", "policy_mcp_block"}},
		"frameworks_bare":  {Flavors: flavors, Frameworks: []string{"langchain"}},
		"frameworks_ver":   {Flavors: flavors, Frameworks: []string{"crewai/0.6", "claude-code/2.0.1"}},
		"mcp_servers":      {Flavors: flavors, MCPServers: []string{"git"}},
		"parent":           {Flavors: flavors, ParentSessionID: f.parent},
		"roles":            {Flavors: flavors, AgentRoles: []string{"Researcher", "Fact checker"}},
		"has_sub":          {Flavors: flavors, HasSubAgents: true},
		"is_sub":           {Flavors: flavors, IsSubAgent: true},
		"both_topology":    {Flavors: flavors, HasSubAgents: true, IsSubAgent: true},
		"no_pure_children": {Flavors: flavors, IncludePureChildren: &fals},
		"include_parents":  {Flavors: flavors, IsSubAgent: true, Limit: 2, IncludeParents: true},
		"close_reasons":    {Flavors: flavors, CloseReasons: []string{"orphan_timeout", "policy_block"}},
		"estimated_via":    {Flavors: flavors, EstimatedVias: []string{"heuristic"}},
		"terminal":         {Flavors: flavors, TerminalOnly: true},
		"matched_entry":    {Flavors: flavors, MatchedEntryIDs: []string{eqvUUID(901)}},
		"call_context":     {Flavors: flavors, OriginatingCallContexts: []string{"call_tool"}},
		"context_os":       {Flavors: flavors, ContextFilters: map[string][]string{"os": {"Darwin", "Windows"}}},
		"context_two":      {Flavors: flavors, ContextFilters: map[string][]string{"hostname": {"eqv-host-a"}, "user": {"alice"}}},
		"model":            {Flavors: flavors, Model: "gpt-4o"},
		"query_host":       {Flavors: flavors, Query: "HOST-B"},
		"query_framework":  {Flavors: flavors, Query: "crewai/0.6"},
		"query_uuid":       {Flavors: flavors, Query: f.grand[:13]},
		"query_escape":     {Flavors: flavors, Query: "50%_off"},
	} {
		params.From, params.To = f.from, f.to
		if params.Limit == 0 {
			params.Limit = 100
		}
		resp, err := s.GetSessions(ctx, params)
		record("sessions/"+name, resp, err)
	}

	// Events list and facets.
	tru := true
	for name, params := range map[string]EventsParams{
		"default":      {Flavor: f.flavorA},
		"desc":         {Flavor: f.flavorA, Order: "desc", Limit: 5},
		"page2":        {Flavor: f.flavorA, Limit: 5, Offset: 5},
		"before":       {Flavor: f.flavorA, Before: eqvBase.Add(1*time.Hour + 10*time.Minute), BeforeID: f.eventIDs[6]},
		"session":      {Flavor: f.flavorA, SessionID: f.childR},
		"agent":        {AgentID: f.agentB},
		"types":        {Flavor: f.flavorA, EventTypes: []string{"post_call", "llm_error"}},
		"models":       {Flavor: f.flavorA, Models: []string{"gpt-4o", "eqv-model-b"}},
		"error_types":  {Flavor: f.flavorA, ErrorTypes: []string{"timeout", "rate_limit"}},
		"close":        {Flavor: f.flavorA, CloseReasons: []string{"normal_exit"}},
		"estimated":    {Flavor: f.flavorA, EstimatedVia: []string{"tiktoken"}},
		"matched":      {Flavor: f.flavorA, MatchedEntryIDs: []string{eqvUUID(901)}},
		"call_context": {Flavor: f.flavorA, OriginatingCallContexts: []string{"call_tool"}},
		"mcp_plugin":   {Flavor: f.flavorA, MCPServers: []string{"plugin:acme:fs"}},
		"terminal":     {Flavor: f.flavorB, Terminal: &tru},
		"frameworks":   {Flavor: f.flavorA, Frameworks: []string{"crewai"}},
		"context":      {Flavor: f.flavorB, OSValues: []string{"Darwin"}, Users: []string{"bob"}},
		"query":        {Flavor: f.flavorA, Query: "POST_"},
		"query_agent":  {Flavor: f.flavorA, Query: "agent-"},
	} {
		params.From, params.To = f.from, f.to
		if params.Limit == 0 {
			params.Limit = 100
		}
		resp, err := s.GetEvents(ctx, params)
		record("events/"+name, resp, err)
		facets, err := s.GetEventFacets(ctx, params)
		record("event-facets/"+name, facets, err)
	}

	// Agents, search and the per-session reads.
	for name, params := range map[string]AgentListParams{
		"default":   {Hostname: []string{"eqv-host-a", "eqv-host-b", "eqv-host-c"}},
		"state":     {Hostname: []string{"eqv-host-a", "eqv-host-b", "eqv-host-c"}, Sort: "state", Order: "desc"},
		"lost":      {Hostname: []string{"eqv-host-a", "eqv-host-b", "eqv-host-c"}, State: []string{"lost"}},
		"os":        {Hostname: []string{"eqv-host-a", "eqv-host-b", "eqv-host-c"}, OS: []string{"Darwin"}},
		"search":    {Hostname: []string{"eqv-host-a", "eqv-host-b", "eqv-host-c"}, Search: "HOST-C"},
		"coding":    {Hostname: []string{"eqv-host-a", "eqv-host-b", "eqv-host-c"}, AgentType: []string{"coding"}},
		"by_tokens": {Hostname: []string{"eqv-host-a", "eqv-host-b", "eqv-host-c"}, Sort: "total_tokens", Order: "asc", Limit: 2},
	} {
		resp, err := s.ListAgents(ctx, params)
		record("agents/"+name, resp, err)
	}
	for _, id := range []string{f.agentA, f.agentB, f.agentC} {
		a, err := s.GetAgentByID(ctx, id)
		record("agent/"+id, a, err)
		state, err := s.GetAgentState(ctx, id)
		record("agent-state/"+id, state, err)
	}
	recent, err := s.GetRecentSessionsByAgentIDs(ctx, []string{f.agentA, f.agentB, f.agentC}, 3)
	record("recent-sessions", recent, err)
	for _, q := range []string{"eqv-host", "eqv-orchestrator", "LLM", "policy", "fs.", "eqv-alpha", "gemini"} {
		res, err := s.Search(ctx, q)
		record("search/"+q, res, err)
	}
	for _, id := range f.sessionIDs {
		sess, err := s.GetSession(ctx, id)
		record("session/"+id, sess, err)
		evs, err := s.GetSessionEvents(ctx, id, 0)
		record("session-events/"+id, evs, err)
		evs, err = s.GetSessionEvents(ctx, id, 3)
		record("session-events-3/"+id, evs, err)
		att, err := s.GetSessionAttachments(ctx, id)
		record("attachments/"+id, att, err)
	}
	content, err := s.GetEventContent(ctx, f.contentEventID)
	record("event-content", content, err)
	ev, err := s.GetEvent(ctx, f.eventIDs[0])
	record("event", ev, err)
	policy, err := s.GetEffectivePolicy(ctx, f.flavorA, f.parent)
	record("effective-policy", policy, err)
	targets, err := s.GetDirectiveTargetsForAgent(ctx, AgentDirectiveTargetQuery{AgentID: f.agentA})
	record("directive-targets", targets, err)
	targets, err = s.GetDirectiveTargetsForAgent(ctx, AgentDirectiveTargetQuery{AgentID: f.agentA, Custom: true, Fingerprint: "fp-eqv-1"})
	record("directive-targets-custom", targets, err)
	ids, err := s.GetActiveSessionIDsByFlavor(ctx, f.flavorA)
	record("active-sessions", ids, err)
	for _, url := range []string{"https://mcp.example.com/evil", "https://mcp.example.com/fs", "https://mcp.example.com/other"} {
		res, err := s.ResolveMCPPolicy(ctx, f.flavorA, url, "fp")
		if err == nil && res.DecisionPath == "mode_default" {
			// The global policy row's id is generated per database.
			res.PolicyID = "<global>"
		}
		record("mcp-resolve/"+url, res, err)
	}
	mcp, err := s.GetMCPPolicy(ctx, f.flavorA)
	record("mcp-policy", mcp, err)
	custom, err := s.GetCustomDirectives(ctx, f.flavorA)
	record("custom-directives", custom, err)
	exists, err := s.CustomDirectiveExists(ctx, "fp-eqv-1", f.flavorA)
	record("custom-directive-exists", exists, err)
	unknown, err := s.SyncDirectives(ctx, f.flavorA, []string{"fp-eqv-1", "fp-eqv-none"})
	record("sync-directives", unknown, err)
	return out
}

// canonical decodes v through JSON and rounds every number to nine
// significant digits, so a decimal / binary difference in the last
// bits of a cost does not count as a difference between the engines.
func canonical(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return roundNumbers(decoded)
}

func roundNumbers(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			x[k] = roundNumbers(val)
		}
		return x
	case []any:
		for i, val := range x {
			x[i] = roundNumbers(val)
		}
		return x
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return x.String()
		}
		if f == math.Trunc(f) && math.Abs(f) < 1e15 {
			return json.Number(strconv.FormatInt(int64(f), 10))
		}
		return json.Number(strconv.FormatFloat(f, 'g', 9, 64))
	case string:
		// A timestamp renders in the driver's zone (Postgres: the
		// session's, SQLite: UTC); the instant is what must agree.
		if ts, err := time.Parse(time.RFC3339Nano, x); err == nil {
			return ts.UTC().Format(time.RFC3339Nano)
		}
		return x
	}
	return v
}

// goldenValue is what the golden stores for a result: the canonical
// value itself, or for an analytics response the SHA-256 of its
// compact JSON.
func goldenValue(t *testing.T, key string, v any) any {
	t.Helper()
	c := canonical(t, v)
	if !strings.HasPrefix(key, "analytics") {
		return c
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("sha256:%x", sha256.Sum256(raw))
}

// TestCrossBackendEquivalence seeds the fixture on every covered
// backend, runs the grid and compares each result to the golden.
func TestCrossBackendEquivalence(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		f := seedEquivalenceFixture(t, s)
		results := equivalenceResults(t, s, f)
		got := map[string]any{}
		for k, v := range results {
			got[k] = goldenValue(t, k, v)
		}
		if *updateGolden {
			// One compact result per line, keys sorted, so a diff of
			// the golden reads per query.
			keys := make([]string, 0, len(got))
			for k := range got {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			var b strings.Builder
			b.WriteString("{\n")
			for i, k := range keys {
				kj, _ := json.Marshal(k)
				vj, err := json.Marshal(got[k])
				if err != nil {
					t.Fatal(err)
				}
				b.Write(kj)
				b.WriteString(": ")
				b.Write(vj)
				if i < len(keys)-1 {
					b.WriteString(",")
				}
				b.WriteString("\n")
			}
			b.WriteString("}\n")
			if err := os.MkdirAll(filepath.Dir(equivalenceGoldenPath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(equivalenceGoldenPath, []byte(b.String()), 0o644); err != nil {
				t.Fatal(err)
			}
			t.Logf("wrote %s with %d results from %s", equivalenceGoldenPath, len(got), s.db.Backend)
			return
		}
		raw, err := os.ReadFile(equivalenceGoldenPath)
		if err != nil {
			t.Fatalf("read golden (run with -update to create it): %v", err)
		}
		var want map[string]any
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.UseNumber()
		if err := dec.Decode(&want); err != nil {
			t.Fatalf("decode golden: %v", err)
		}
		if len(want) != len(got) {
			t.Errorf("golden has %d results, this run %d; regenerate with -update", len(want), len(got))
		}
		keys := make([]string, 0, len(got))
		for k := range got {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		failures := 0
		for _, k := range keys {
			w, ok := want[k]
			if !ok {
				t.Errorf("%s: not in the golden", k)
				continue
			}
			if !reflect.DeepEqual(roundNumbers(w), got[k]) {
				failures++
				if failures <= 10 {
					gj, _ := json.Marshal(canonical(t, results[k]))
					wj, _ := json.Marshal(w)
					t.Errorf("%s differs from the golden\n got: %s\nwant: %s", k, gj, wj)
				}
			}
		}
		if failures > 10 {
			t.Errorf("%d results differ in all (first 10 shown)", failures)
		}
		t.Logf("%d results compared on %s", len(keys), s.db.Backend)
	})
}
