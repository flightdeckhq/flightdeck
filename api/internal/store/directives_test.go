package store

import (
	"context"
	"slices"
	"testing"
	"time"
)

// directives_test.go runs GetDirectiveTargetsForAgent and
// CreateDirectives against the dev Postgres (newTestStore skips without
// one). Each test seeds its own agents, sessions and custom directives
// under random ids and flavors, and removes them, with the directive
// rows written for them, in t.Cleanup.

// seedTargetAgent inserts an agents row and registers the cleanup of
// the agent, its sessions and the directives addressed to them.
func seedTargetAgent(t *testing.T, s *Store, clientType string) string {
	t.Helper()
	ctx := context.Background()
	agentID := randomUUID(t)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname)
		VALUES ($1::uuid, 'production', $2, $3, 'test-directive-targets', 'test-directive-targets-host')
	`, agentID, clientType, "test-directive-targets-"+agentID[:8]); err != nil {
		t.Fatalf("seedTargetAgent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM directives WHERE session_id IN (
			SELECT session_id FROM sessions WHERE agent_id = $1::uuid)`, agentID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM sessions WHERE agent_id = $1::uuid`, agentID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM agents WHERE agent_id = $1::uuid`, agentID)
	})
	return agentID
}

// targetRun is one session a targeting test seeds.
type targetRun struct {
	clientType string // "" stores NULL, as on a row written before its session_start
	state      string
	flavor     string
	context    string // JSON; "" stores SQL NULL, as a lazily created row has
}

// seedTargetRun inserts one session of agentID that started at
// startedAt and returns its id.
func seedTargetRun(t *testing.T, s *Store, agentID string, startedAt time.Time, r targetRun) string {
	t.Helper()
	sid := randomUUID(t)
	var clientType, contextJSON *string
	if r.clientType != "" {
		clientType = &r.clientType
	}
	if r.context != "" {
		contextJSON = &r.context
	}
	if _, err := s.pool.Exec(context.Background(), `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state, started_at, last_seen_at,
			tokens_used, agent_type, client_type, context
		) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $5, 0, 'production', $6, $7::jsonb)
	`, sid, agentID, r.flavor, r.state, startedAt, clientType, contextJSON); err != nil {
		t.Fatalf("seedTargetRun: %v", err)
	}
	return sid
}

// registerTargetDirective registers fingerprint under flavor, as a
// sensor's /v1/directives/register does, and removes it in t.Cleanup.
func registerTargetDirective(t *testing.T, s *Store, fingerprint, flavor string) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO custom_directives (fingerprint, name, description, flavor, parameters)
		VALUES ($1, 'test_target', 'directive targeting store test', $2, '[]'::jsonb)
	`, fingerprint, flavor); err != nil {
		t.Fatalf("registerTargetDirective: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM custom_directives WHERE fingerprint = $1 AND flavor = $2`, fingerprint, flavor)
	})
}

// uniqueTargetFlavor is a flavor no other row uses.
func uniqueTargetFlavor(t *testing.T) string {
	t.Helper()
	return "test-directive-targets-" + randomUUID(t)[:8]
}

// startTimes returns the i-th start time of a test's runs, a minute
// apart, so the targets' expected order is the seeding order.
func startTimes() func(i int) time.Time {
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	return func(i int) time.Time { return base.Add(time.Duration(i) * time.Minute) }
}

func mustTargets(t *testing.T, s *Store, q AgentDirectiveTargetQuery) []string {
	t.Helper()
	ids, err := s.GetDirectiveTargetsForAgent(context.Background(), q)
	if err != nil {
		t.Fatalf("GetDirectiveTargetsForAgent(%+v): %v", q, err)
	}
	return ids
}

func TestGetDirectiveTargetsForAgent_StopReachesTheAgentsLiveRunsThatTakeDirectives(t *testing.T) {
	s, _ := newTestStore(t)
	at := startTimes()
	flavor := uniqueTargetFlavor(t)
	sensor := func(state, ctx string) targetRun {
		return targetRun{clientType: "flightdeck_sensor", state: state, flavor: flavor, context: ctx}
	}

	agent := seedTargetAgent(t, s, "flightdeck_sensor")
	active := seedTargetRun(t, s, agent, at(0), sensor("active", "{}"))
	// A lazily created row has no context: the type's default applies.
	idle := seedTargetRun(t, s, agent, at(1), sensor("idle", ""))
	seedTargetRun(t, s, agent, at(2), sensor("closed", "{}"))
	seedTargetRun(t, s, agent, at(3), sensor("stale", "{}"))
	seedTargetRun(t, s, agent, at(4), sensor("lost", "{}"))
	// The session's own flag wins over the type's default...
	seedTargetRun(t, s, agent, at(5), sensor("active", `{"supports_directives": false}`))
	// ...when it is a JSON boolean; a string is not the flag.
	stringFlag := seedTargetRun(t, s, agent, at(6), sensor("active", `{"supports_directives": "false"}`))

	// Another agent's live run in the same flavor is never a target.
	other := seedTargetAgent(t, s, "flightdeck_sensor")
	otherRun := seedTargetRun(t, s, other, at(0), sensor("active", "{}"))

	got := mustTargets(t, s, AgentDirectiveTargetQuery{AgentID: agent})
	if want := []string{active, idle, stringFlag}; !slices.Equal(got, want) {
		t.Errorf("stop targets = %v, want %v (oldest first)", got, want)
	}
	if got := mustTargets(t, s, AgentDirectiveTargetQuery{AgentID: other}); !slices.Equal(got, []string{otherRun}) {
		t.Errorf("other agent's stop targets = %v, want only its own run %s", got, otherRun)
	}
}

func TestGetDirectiveTargetsForAgent_ClaudeCodeTakesAStopOnlyWithEnforcementAndNeverACustomDirective(t *testing.T) {
	s, _ := newTestStore(t)
	at := startTimes()
	flavor := uniqueTargetFlavor(t)
	fp := "fp-" + randomUUID(t)
	registerTargetDirective(t, s, fp, flavor)

	agent := seedTargetAgent(t, s, "claude_code")
	cc := func(ctx string) targetRun {
		return targetRun{clientType: "claude_code", state: "active", flavor: flavor, context: ctx}
	}
	enforced := seedTargetRun(t, s, agent, at(0), cc(`{"supports_directives": true}`))
	seedTargetRun(t, s, agent, at(1), cc(`{"supports_directives": false}`))
	// An OpenTelemetry session: observe only.
	seedTargetRun(t, s, agent, at(2), cc(`{"supports_directives": false, "telemetry": "otlp"}`))
	// No flag: the registry's claude_code default (false) applies.
	seedTargetRun(t, s, agent, at(3), cc(`{}`))

	if got := mustTargets(t, s, AgentDirectiveTargetQuery{AgentID: agent}); !slices.Equal(got, []string{enforced}) {
		t.Errorf("stop targets = %v, want only the enforcement-on run %s", got, enforced)
	}
	custom := AgentDirectiveTargetQuery{AgentID: agent, Custom: true, Fingerprint: fp}
	if got := mustTargets(t, s, custom); len(got) != 0 {
		t.Errorf("custom targets = %v, want none: the plugin answers a custom directive with an error", got)
	}
}

func TestGetDirectiveTargetsForAgent_AgentSDKAndObserverTypes(t *testing.T) {
	s, _ := newTestStore(t)
	at := startTimes()
	flavor := uniqueTargetFlavor(t)
	fp := "fp-" + randomUUID(t)
	registerTargetDirective(t, s, fp, flavor)

	sdk := seedTargetAgent(t, s, "claude_agent_sdk")
	sdkRun := seedTargetRun(t, s, sdk, at(0),
		targetRun{clientType: "claude_agent_sdk", state: "active", flavor: flavor, context: "{}"})
	if got := mustTargets(t, s, AgentDirectiveTargetQuery{AgentID: sdk}); !slices.Equal(got, []string{sdkRun}) {
		t.Errorf("Agent SDK stop targets = %v, want %s", got, sdkRun)
	}
	if got := mustTargets(t, s, AgentDirectiveTargetQuery{AgentID: sdk, Custom: true, Fingerprint: fp}); len(got) != 0 {
		t.Errorf("Agent SDK custom targets = %v, want none", got)
	}

	// A type whose registry default is observe-only takes nothing
	// unless the session says otherwise.
	otlp := seedTargetAgent(t, s, "otlp")
	seedTargetRun(t, s, otlp, at(0), targetRun{clientType: "otlp", state: "active", flavor: flavor, context: "{}"})
	if got := mustTargets(t, s, AgentDirectiveTargetQuery{AgentID: otlp}); len(got) != 0 {
		t.Errorf("otlp stop targets = %v, want none", got)
	}
}

func TestGetDirectiveTargetsForAgent_RowWithoutClientTypeFollowsTheClaudeCodeMarker(t *testing.T) {
	s, _ := newTestStore(t)
	at := startTimes()
	flavor := uniqueTargetFlavor(t)
	fp := "fp-" + randomUUID(t)
	registerTargetDirective(t, s, fp, flavor)
	registerTargetDirective(t, s, fp, "claude-code")

	agent := seedTargetAgent(t, s, "flightdeck_sensor")
	plain := seedTargetRun(t, s, agent, at(0),
		targetRun{state: "active", flavor: flavor, context: `{"frameworks": ["langchain/0.3.27"]}`})
	// The flavor marks Claude Code.
	seedTargetRun(t, s, agent, at(1), targetRun{state: "active", flavor: "claude-code", context: "{}"})
	// A frameworks entry marks Claude Code.
	seedTargetRun(t, s, agent, at(2),
		targetRun{state: "active", flavor: flavor, context: `{"frameworks": ["claude-code/2.1.316"]}`})
	// The session's flag wins for a stop; the marker still rules out
	// custom handlers.
	flagged := seedTargetRun(t, s, agent, at(3), targetRun{state: "idle", flavor: flavor,
		context: `{"supports_directives": true, "frameworks": ["claude-code/2.1.316"]}`})

	if got, want := mustTargets(t, s, AgentDirectiveTargetQuery{AgentID: agent}), []string{plain, flagged}; !slices.Equal(got, want) {
		t.Errorf("stop targets = %v, want %v", got, want)
	}
	custom := AgentDirectiveTargetQuery{AgentID: agent, Custom: true, Fingerprint: fp}
	if got := mustTargets(t, s, custom); !slices.Equal(got, []string{plain}) {
		t.Errorf("custom targets = %v, want only %s", got, plain)
	}
}

func TestGetDirectiveTargetsForAgent_CustomNeedsAFlavorThatRegisteredTheFingerprint(t *testing.T) {
	s, _ := newTestStore(t)
	at := startTimes()
	f1, f2, f3 := uniqueTargetFlavor(t), uniqueTargetFlavor(t), uniqueTargetFlavor(t)
	fp := "fp-" + randomUUID(t)
	registerTargetDirective(t, s, fp, f1)
	registerTargetDirective(t, s, fp, f2)
	sensor := func(state, flavor string) targetRun {
		return targetRun{clientType: "flightdeck_sensor", state: state, flavor: flavor, context: "{}"}
	}

	agent := seedTargetAgent(t, s, "flightdeck_sensor")
	r1 := seedTargetRun(t, s, agent, at(0), sensor("active", f1))
	r2 := seedTargetRun(t, s, agent, at(1), sensor("idle", f2))
	r3 := seedTargetRun(t, s, agent, at(2), sensor("active", f3)) // f3 registered nothing
	seedTargetRun(t, s, agent, at(3), sensor("closed", f1))
	other := seedTargetAgent(t, s, "flightdeck_sensor")
	seedTargetRun(t, s, other, at(0), sensor("active", f1))

	for _, tc := range []struct {
		name string
		q    AgentDirectiveTargetQuery
		want []string
	}{
		{"every registered flavor", AgentDirectiveTargetQuery{AgentID: agent, Custom: true, Fingerprint: fp}, []string{r1, r2}},
		{"narrowed to f2", AgentDirectiveTargetQuery{AgentID: agent, Custom: true, Fingerprint: fp, Flavor: f2}, []string{r2}},
		{"narrowed to a flavor that registered nothing", AgentDirectiveTargetQuery{AgentID: agent, Custom: true, Fingerprint: fp, Flavor: f3}, nil},
		{"an unknown fingerprint", AgentDirectiveTargetQuery{AgentID: agent, Custom: true, Fingerprint: "fp-" + randomUUID(t)}, nil},
		{"a stop ignores the registry", AgentDirectiveTargetQuery{AgentID: agent}, []string{r1, r2, r3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := mustTargets(t, s, tc.q); !slices.Equal(got, tc.want) {
				t.Errorf("targets = %v, want %v", got, tc.want)
			}
		})
	}

	if _, err := s.GetDirectiveTargetsForAgent(context.Background(),
		AgentDirectiveTargetQuery{AgentID: agent, Custom: true}); err == nil {
		t.Error("a custom query without a fingerprint must fail")
	}
}

func TestCreateDirectives_InsertsOneRowPerSession(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()
	at := startTimes()
	flavor := uniqueTargetFlavor(t)
	agent := seedTargetAgent(t, s, "flightdeck_sensor")
	r1 := seedTargetRun(t, s, agent, at(0), targetRun{clientType: "flightdeck_sensor", state: "active", flavor: flavor, context: "{}"})
	r2 := seedTargetRun(t, s, agent, at(1), targetRun{clientType: "flightdeck_sensor", state: "active", flavor: flavor, context: "{}"})

	reason := "manual_fleet_kill"
	rows, err := s.CreateDirectives(ctx, Directive{Action: "shutdown", Reason: &reason, GracePeriodMs: 5000}, []string{r1, r2})
	if err != nil {
		t.Fatalf("CreateDirectives: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	for i, want := range []string{r1, r2} {
		d := rows[i]
		if d.ID == "" || d.SessionID == nil || *d.SessionID != want || d.Action != "shutdown" ||
			d.Reason == nil || *d.Reason != reason || d.IssuedBy != "dashboard" || d.Flavor != nil {
			t.Errorf("row %d = %+v, want a pending dashboard shutdown for %s", i, d, want)
		}
	}
	var pending int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM directives
		WHERE session_id = ANY($1::uuid[]) AND delivered_at IS NULL`, []string{r1, r2}).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 2 {
		t.Errorf("pending rows stored = %d, want 2", pending)
	}

	if _, err := s.CreateDirectives(ctx, Directive{Action: "shutdown", GracePeriodMs: 5000}, nil); err == nil {
		t.Error("CreateDirectives with no sessions must fail")
	}
}

func TestCreateDirectives_RollsBackEveryRowWhenOneFails(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()
	at := startTimes()
	agent := seedTargetAgent(t, s, "flightdeck_sensor")
	r1 := seedTargetRun(t, s, agent, at(0),
		targetRun{clientType: "flightdeck_sensor", state: "active", flavor: uniqueTargetFlavor(t), context: "{}"})

	// The first row inserts; the second cannot (not a UUID), so the
	// transaction must drop the first.
	if _, err := s.CreateDirectives(ctx, Directive{Action: "shutdown", GracePeriodMs: 5000},
		[]string{r1, "not-a-session-uuid"}); err == nil {
		t.Fatal("CreateDirectives with an invalid session id must fail")
	}
	var stored int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM directives WHERE session_id = $1::uuid`, r1).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 0 {
		t.Errorf("rows kept for %s after the failed set = %d, want 0", r1, stored)
	}
}
