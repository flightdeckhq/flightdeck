package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

// agents_test.go leans on newTestStore (postgres_test.go) so every
// test either runs against a live Postgres or skips cleanly. Each
// test seeds an isolated fixture set via ``seedAgent``/``seedSession``
// (agents_reconcile_test.go) and cleans up via t.Cleanup.
//
// The tests focus on filter / sort / search behavior; handler-level
// validation (400s for invalid enum values, limit overflow, etc.)
// lives in api/tests/handler_test.go which exercises the HTTP
// envelope with the mockStore.

// seedAgentForList is a helper that composes seedAgent + any number of
// sessions, returning the agent_id so tests can target specific
// fixtures when asserting filter coverage. Unlike
// “seedAgent“, this helper leaves counter values synced (they are
// not the point of these tests). Uses the “state_override“ arg to
// force a specific rollup state via a session, because
// ReconcileAgents tests prove the rollup is LATERAL-computed from
// session state.
func seedAgentForList(
	t *testing.T, s *Store,
	agentName string,
	opts agentListOpts,
) string {
	t.Helper()
	agentID := randomUUID(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	firstSeen := opts.firstSeen
	if firstSeen.IsZero() {
		firstSeen = now.Add(-2 * time.Hour)
	}
	lastSeen := opts.lastSeen
	if lastSeen.IsZero() {
		lastSeen = now.Add(-10 * time.Minute)
	}

	ctx := context.Background()
	_, err := s.pool.Exec(ctx, `
		INSERT INTO agents (
			agent_id, agent_type, client_type, agent_name,
			user_name, hostname,
			first_seen_at, last_seen_at,
			total_sessions, total_tokens
		) VALUES (
			$1::uuid, $2, $3, $4,
			$5, $6,
			$7, $8,
			$9, $10
		)
	`, agentID, opts.agentType, opts.clientType, agentName,
		opts.userName, opts.hostname,
		firstSeen, lastSeen,
		opts.totalSessions, opts.totalTokens,
	)
	if err != nil {
		t.Fatalf("seedAgentForList %s: %v", agentName, err)
	}

	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM sessions WHERE agent_id = $1::uuid`, agentID)
		_, _ = s.pool.Exec(ctx,
			`DELETE FROM agents WHERE agent_id = $1::uuid`, agentID)
	})

	// Optional session seeding to exercise state rollup +
	// context-filter paths.
	if opts.sessionState != "" {
		_, err := s.pool.Exec(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type, context
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, $3,
				$4, $5, $6,
				$7, $8, $9::jsonb
			)
		`, agentID, "test-list-flavor", opts.sessionState,
			lastSeen, lastSeen, opts.totalTokens,
			opts.agentType, opts.clientType, opts.sessionContextJSON())
		if err != nil {
			t.Fatalf("seed session for %s: %v", agentID, err)
		}
	}

	return agentID
}

type agentListOpts struct {
	agentType     string
	clientType    string
	userName      string
	hostname      string
	firstSeen     time.Time
	lastSeen      time.Time
	totalSessions int
	totalTokens   int64
	sessionState  string // force rollup state via a session row
	os            string // context.os for context-filter tests
	orchestration string // context.orchestration for context-filter tests
}

func (o agentListOpts) sessionContextJSON() string {
	parts := []string{}
	if o.os != "" {
		parts = append(parts, `"os":"`+o.os+`"`)
	}
	if o.orchestration != "" {
		parts = append(parts, `"orchestration":"`+o.orchestration+`"`)
	}
	if len(parts) == 0 {
		return `{}`
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// --- Filter coverage ---

func TestListAgents_FilterByAgentType(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	codingID := seedAgentForList(t, s, "test-list-coding-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		userName: "u1", hostname: "h1",
	})
	prodID := seedAgentForList(t, s, "test-list-prod-"+randomUUID(t)[:8], agentListOpts{
		agentType: "production", clientType: "flightdeck_sensor",
		userName: "u2", hostname: "h2",
	})

	ctx := context.Background()
	resp, err := s.ListAgents(ctx, AgentListParams{
		AgentType: []string{"coding"},
		Limit:     100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp, codingID, true)
	assertContainsAgent(t, resp, prodID, false)
}

func TestListAgents_FilterByClientType(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	ccID := seedAgentForList(t, s, "test-list-cc-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
	})
	sensorID := seedAgentForList(t, s, "test-list-sensor-"+randomUUID(t)[:8], agentListOpts{
		agentType: "production", clientType: "flightdeck_sensor",
	})

	resp, err := s.ListAgents(context.Background(), AgentListParams{
		ClientType: []string{"claude_code"},
		Limit:      100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp, ccID, true)
	assertContainsAgent(t, resp, sensorID, false)
}

func TestListAgents_FilterByState_LateralRollup(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	activeID := seedAgentForList(t, s, "test-list-state-active-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code", sessionState: "active",
	})
	closedID := seedAgentForList(t, s, "test-list-state-closed-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code", sessionState: "closed",
	})

	resp, err := s.ListAgents(context.Background(), AgentListParams{
		State: []string{"active"},
		Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp, activeID, true)
	assertContainsAgent(t, resp, closedID, false)

	// Second read, OR-within-dimension.
	resp2, err := s.ListAgents(context.Background(), AgentListParams{
		State: []string{"active", "closed"},
		Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp2, activeID, true)
	assertContainsAgent(t, resp2, closedID, true)
}

func TestListAgents_FilterByHostnameAndUser(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	matchID := seedAgentForList(t, s, "test-list-hu-match-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		userName: "alice", hostname: "host-alice",
	})
	missID := seedAgentForList(t, s, "test-list-hu-miss-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		userName: "bob", hostname: "host-bob",
	})

	resp, err := s.ListAgents(context.Background(), AgentListParams{
		UserName: []string{"alice"},
		Limit:    100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp, matchID, true)
	assertContainsAgent(t, resp, missID, false)

	// hostname filter independently.
	resp2, err := s.ListAgents(context.Background(), AgentListParams{
		Hostname: []string{"host-alice"},
		Limit:    100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp2, matchID, true)
	assertContainsAgent(t, resp2, missID, false)
}

func TestListAgents_FilterByContextOS_ExistsSubquery(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	linuxID := seedAgentForList(t, s, "test-list-os-linux-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		sessionState: "closed", os: "Linux",
	})
	macID := seedAgentForList(t, s, "test-list-os-mac-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		sessionState: "closed", os: "Darwin",
	})

	resp, err := s.ListAgents(context.Background(), AgentListParams{
		OS:    []string{"Linux"},
		Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp, linuxID, true)
	assertContainsAgent(t, resp, macID, false)
}

func TestListAgents_Search_AgentNameAndHostname(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	byNameID := seedAgentForList(t, s, "test-list-search-UniquelyNamed-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		hostname: "plain-host",
	})
	byHostID := seedAgentForList(t, s, "test-list-search-regular-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		hostname: "distinct-host-marker",
	})
	otherID := seedAgentForList(t, s, "test-list-search-nomatch-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		hostname: "elsewhere",
	})

	// Substring match in agent_name only.
	resp, err := s.ListAgents(context.Background(), AgentListParams{
		Search: "UniquelyNamed",
		Limit:  100,
	})
	if err != nil {
		t.Fatalf("search agent_name: %v", err)
	}
	assertContainsAgent(t, resp, byNameID, true)
	assertContainsAgent(t, resp, byHostID, false)
	assertContainsAgent(t, resp, otherID, false)

	// Substring match in hostname only.
	resp2, err := s.ListAgents(context.Background(), AgentListParams{
		Search: "distinct-host-marker",
		Limit:  100,
	})
	if err != nil {
		t.Fatalf("search hostname: %v", err)
	}
	assertContainsAgent(t, resp2, byHostID, true)
	assertContainsAgent(t, resp2, byNameID, false)
	assertContainsAgent(t, resp2, otherID, false)

	// Case-insensitive (ILIKE).
	resp3, err := s.ListAgents(context.Background(), AgentListParams{
		Search: "uniquelyNAMED", // mixed-case to prove ILIKE
		Limit:  100,
	})
	if err != nil {
		t.Fatalf("search case-insensitive: %v", err)
	}
	assertContainsAgent(t, resp3, byNameID, true)
}

func TestListAgents_FilterByUpdatedSince(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	now := time.Now().UTC().Truncate(time.Microsecond)
	recentID := seedAgentForList(t, s, "test-list-since-recent-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		lastSeen: now.Add(-5 * time.Minute),
	})
	oldID := seedAgentForList(t, s, "test-list-since-old-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		lastSeen: now.Add(-24 * time.Hour),
	})

	cutoff := now.Add(-1 * time.Hour)
	resp, err := s.ListAgents(context.Background(), AgentListParams{
		UpdatedSince: &cutoff,
		Limit:        100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp, recentID, true)
	assertContainsAgent(t, resp, oldID, false)
}

// --- Sort ---

func TestListAgents_SortByAgentName_AscDesc(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	aID := seedAgentForList(t, s, "test-list-sort-aaa-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
	})
	zID := seedAgentForList(t, s, "test-list-sort-zzz-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
	})

	asc, err := s.ListAgents(context.Background(), AgentListParams{
		Search: "test-list-sort-",
		Sort:   "agent_name", Order: "asc",
		Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListAgents asc: %v", err)
	}
	assertOrder(t, asc, []string{aID, zID})

	desc, err := s.ListAgents(context.Background(), AgentListParams{
		Search: "test-list-sort-",
		Sort:   "agent_name", Order: "desc",
		Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListAgents desc: %v", err)
	}
	assertOrder(t, desc, []string{zID, aID})
}

func TestListAgents_SortByTotalSessions(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	lowID := seedAgentForList(t, s, "test-list-ts-low-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		totalSessions: 1, totalTokens: 10,
	})
	highID := seedAgentForList(t, s, "test-list-ts-high-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		totalSessions: 99, totalTokens: 1000,
	})

	desc, err := s.ListAgents(context.Background(), AgentListParams{
		Search: "test-list-ts-",
		Sort:   "total_sessions", Order: "desc",
		Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertOrder(t, desc, []string{highID, lowID})
}

func TestListAgents_SortByStateOrdinal_ActiveFirstOnDesc(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	activeID := seedAgentForList(t, s, "test-list-ss-active-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code", sessionState: "active",
	})
	staleID := seedAgentForList(t, s, "test-list-ss-stale-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code", sessionState: "stale",
	})
	closedID := seedAgentForList(t, s, "test-list-ss-closed-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code", sessionState: "closed",
	})

	resp, err := s.ListAgents(context.Background(), AgentListParams{
		Search: "test-list-ss-",
		Sort:   "state", Order: "desc",
		Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	// DESC means "most-engaged state first" per ordinal CASE in
	// store/agents.go: active (1) < stale (3) < closed (4).
	assertOrder(t, resp, []string{activeID, staleID, closedID})
}

// --- Pagination ---

func TestListAgents_Pagination_LimitOffsetTotal(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	// Seed 5 fixtures with a common search prefix so Total is
	// deterministic regardless of other rows in the shared DB.
	prefix := "test-list-page-" + randomUUID(t)[:8]
	for i := 0; i < 5; i++ {
		_ = seedAgentForList(t, s, prefix+"-"+randomUUID(t)[:6], agentListOpts{
			agentType: "coding", clientType: "claude_code",
		})
	}

	ctx := context.Background()
	resp, err := s.ListAgents(ctx, AgentListParams{
		Search: prefix,
		Limit:  2, Offset: 0,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	if resp.Total != 5 {
		t.Errorf("Total: want 5, got %d", resp.Total)
	}
	if len(resp.Agents) != 2 {
		t.Errorf("Page 1 size: want 2, got %d", len(resp.Agents))
	}
	if !resp.HasMore {
		t.Errorf("HasMore should be true on page 1")
	}

	resp2, err := s.ListAgents(ctx, AgentListParams{
		Search: prefix,
		Limit:  2, Offset: 4,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	if len(resp2.Agents) != 1 {
		t.Errorf("Last page size: want 1, got %d", len(resp2.Agents))
	}
	if resp2.HasMore {
		t.Errorf("HasMore should be false on the last page")
	}
}

// --- Combination (AND across dimensions, OR within) ---

func TestListAgents_FilterCombination_AndAcrossDimensions(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	matchID := seedAgentForList(t, s, "test-list-combo-match-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		userName: "alice",
	})
	halfID := seedAgentForList(t, s, "test-list-combo-half-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		userName: "bob", // matches agent_type but not user
	})
	noneID := seedAgentForList(t, s, "test-list-combo-none-"+randomUUID(t)[:8], agentListOpts{
		agentType: "production", clientType: "flightdeck_sensor",
		userName: "carol",
	})

	resp, err := s.ListAgents(context.Background(), AgentListParams{
		AgentType: []string{"coding"},
		UserName:  []string{"alice"},
		Limit:     100,
	})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	assertContainsAgent(t, resp, matchID, true)
	assertContainsAgent(t, resp, halfID, false)
	assertContainsAgent(t, resp, noneID, false)
}

// --- GetAgentByID ---

func TestGetAgentByID_HitMiss(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	agentID := seedAgentForList(t, s, "test-byid-"+randomUUID(t)[:8], agentListOpts{
		agentType: "coding", clientType: "claude_code",
		userName: "alice", hostname: "host-byid",
		sessionState: "active",
	})

	ctx := context.Background()
	a, err := s.GetAgentByID(ctx, agentID)
	if err != nil {
		t.Fatalf("GetAgentByID: %v", err)
	}
	if a == nil {
		t.Fatal("expected hit, got nil")
	}
	if a.AgentID != agentID {
		t.Errorf("AgentID: want %s, got %s", agentID, a.AgentID)
	}
	if a.State != "active" {
		t.Errorf("State rollup should be 'active', got %q", a.State)
	}

	// Miss — random UUID that matches nothing.
	notExist := randomUUID(t)
	a2, err := s.GetAgentByID(ctx, notExist)
	if err != nil {
		t.Fatalf("GetAgentByID miss: %v", err)
	}
	if a2 != nil {
		t.Errorf("expected nil for missing id, got %+v", a2)
	}
}

// --- D126 sub-agent rollup (agent_role + topology) ---

// seedSubagentLink seeds a parent agent + a child agent with one
// session each, where the child session's parent_session_id points
// at the parent's session. Returns the (parentAgentID, childAgentID,
// childRole) triple. Used by the topology + agent_role rollup tests
// to exercise the parent / child / lone classification on the
// AgentSummary projection.
func seedSubagentLink(
	t *testing.T, s *Store,
	parentName, childName, childRole string,
) (parentAgentID, childAgentID, parentSessionID, childSessionID string) {
	t.Helper()
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Microsecond)

	parentAgentID = seedAgentForList(t, s, parentName, agentListOpts{
		agentType:  "production",
		clientType: "claude_code",
		userName:   "test-d126",
		hostname:   "test-d126-host",
		lastSeen:   now.Add(-2 * time.Minute),
	})
	childAgentID = seedAgentForList(t, s, childName, agentListOpts{
		agentType:  "production",
		clientType: "claude_code",
		userName:   "test-d126",
		hostname:   "test-d126-host",
		lastSeen:   now.Add(-1 * time.Minute),
	})

	parentSessionID = randomUUID(t)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 0,
			'production', 'claude_code'
		)
	`, parentSessionID, parentAgentID, "test-d126-parent",
		now.Add(-3*time.Minute)); err != nil {
		t.Fatalf("seed parent session: %v", err)
	}

	childSessionID = randomUUID(t)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type,
			parent_session_id, agent_role
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 0,
			'production', 'claude_code',
			$5::uuid, $6
		)
	`, childSessionID, childAgentID, "test-d126-child",
		now.Add(-2*time.Minute), parentSessionID, childRole); err != nil {
		t.Fatalf("seed child session: %v", err)
	}
	return
}

// findAgent returns the AgentSummary with the given agent_id from a
// list response, or nil if absent. Tests fail loudly on absence — the
// shared test DB has interleaving fixtures so a concrete id is always
// the right match key, never positional.
func findAgent(resp *AgentListResponse, agentID string) *AgentSummary {
	for i := range resp.Agents {
		if resp.Agents[i].AgentID == agentID {
			return &resp.Agents[i]
		}
	}
	return nil
}

// TestListAgents_D126RollupFields covers the three topology states
// (lone / parent / child) and the agent_role projection in one
// fixture pass. A lone agent (no sessions, or sessions without
// parent_session_id and not referenced as a parent) reports
// topology="lone" and agent_role=nil; the parent reports "parent"
// and nil role; the child reports "child" and the role string.
//
// The "child wins over parent" priority isn't exercised here — we
// only have two-level fixtures — but the SQL CASE order is the
// authority and is read-locked by the seed-paths in this test plus
// the GetAgentFleet equivalent below.
func TestListAgents_D126RollupFields(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	loneID := seedAgentForList(t, s, "test-d126-lone-"+randomUUID(t)[:8], agentListOpts{
		agentType: "production", clientType: "claude_code",
		sessionState: "closed",
	})
	parentID, childID, _, _ := seedSubagentLink(
		t, s,
		"test-d126-parent-"+randomUUID(t)[:8],
		"test-d126-child-"+randomUUID(t)[:8],
		"Researcher",
	)

	resp, err := s.ListAgents(context.Background(), AgentListParams{Limit: 100})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}

	lone := findAgent(resp, loneID)
	if lone == nil {
		t.Fatalf("lone agent missing from response")
	}
	if lone.Topology != "lone" {
		t.Errorf("lone agent topology=%q, want %q", lone.Topology, "lone")
	}
	if lone.AgentRole != nil {
		t.Errorf("lone agent agent_role=%v, want nil", *lone.AgentRole)
	}

	parent := findAgent(resp, parentID)
	if parent == nil {
		t.Fatalf("parent agent missing from response")
	}
	if parent.Topology != "parent" {
		t.Errorf("parent agent topology=%q, want %q", parent.Topology, "parent")
	}
	if parent.AgentRole != nil {
		t.Errorf("parent agent agent_role=%v, want nil", *parent.AgentRole)
	}

	child := findAgent(resp, childID)
	if child == nil {
		t.Fatalf("child agent missing from response")
	}
	if child.Topology != "child" {
		t.Errorf("child agent topology=%q, want %q", child.Topology, "child")
	}
	if child.AgentRole == nil || *child.AgentRole != "Researcher" {
		var got string
		if child.AgentRole != nil {
			got = *child.AgentRole
		}
		t.Errorf("child agent agent_role=%q, want %q", got, "Researcher")
	}
}

// TestGetAgentByID_D126RollupFields verifies the second projection
// site (single-row fetch) returns the same shape as ListAgents. The
// d126AgentRollupSQL constant is shared so a regression in the
// projection would fire here too — this test exists to guard the
// scan-side wiring, which is independent.
func TestGetAgentByID_D126RollupFields(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	parentID, childID, _, _ := seedSubagentLink(
		t, s,
		"test-d126-byid-parent-"+randomUUID(t)[:8],
		"test-d126-byid-child-"+randomUUID(t)[:8],
		"Writer",
	)

	parent, err := s.GetAgentByID(context.Background(), parentID)
	if err != nil {
		t.Fatalf("GetAgentByID parent: %v", err)
	}
	if parent == nil {
		t.Fatalf("parent agent missing")
	}
	if parent.Topology != "parent" {
		t.Errorf("parent topology=%q, want parent", parent.Topology)
	}
	if parent.AgentRole != nil {
		t.Errorf("parent agent_role=%v, want nil", *parent.AgentRole)
	}

	child, err := s.GetAgentByID(context.Background(), childID)
	if err != nil {
		t.Fatalf("GetAgentByID child: %v", err)
	}
	if child == nil {
		t.Fatalf("child agent missing")
	}
	if child.Topology != "child" {
		t.Errorf("child topology=%q, want child", child.Topology)
	}
	if child.AgentRole == nil || *child.AgentRole != "Writer" {
		var got string
		if child.AgentRole != nil {
			got = *child.AgentRole
		}
		t.Errorf("child agent_role=%q, want Writer", got)
	}
}

// TestGetAgentFleet_D126RollupFields covers the fleet endpoint's
// AgentSummary projection. Same shape as ListAgents but goes through
// GetAgentFleet which has its own query string — the constant
// d126AgentRollupSQL is shared but the surrounding scan loop is
// duplicated, so this test guards the second scan.
func TestGetAgentFleet_D126RollupFields(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	parentID, childID, _, _ := seedSubagentLink(
		t, s,
		"test-d126-fleet-parent-"+randomUUID(t)[:8],
		"test-d126-fleet-child-"+randomUUID(t)[:8],
		"Reviewer",
	)

	agents, _, err := s.GetAgentFleet(context.Background(), 200, 0, "")
	if err != nil {
		t.Fatalf("GetAgentFleet: %v", err)
	}

	var seenParent, seenChild bool
	for _, a := range agents {
		if a.AgentID == parentID {
			seenParent = true
			if a.Topology != "parent" {
				t.Errorf("fleet parent topology=%q, want parent", a.Topology)
			}
			if a.AgentRole != nil {
				t.Errorf("fleet parent agent_role=%v, want nil", *a.AgentRole)
			}
		}
		if a.AgentID == childID {
			seenChild = true
			if a.Topology != "child" {
				t.Errorf("fleet child topology=%q, want child", a.Topology)
			}
			if a.AgentRole == nil || *a.AgentRole != "Reviewer" {
				var got string
				if a.AgentRole != nil {
					got = *a.AgentRole
				}
				t.Errorf("fleet child agent_role=%q, want Reviewer", got)
			}
		}
	}
	if !seenParent || !seenChild {
		t.Fatalf("seeded agents missing from fleet response: parent=%v child=%v",
			seenParent, seenChild)
	}
}

// TestGetAgentFleet_RecentSessionsAttached exercises the
// “recent_sessions“ rollup attached to each “AgentSummary“ on
// the /v1/fleet response. Seeds an agent with seven sessions
// spanning two days; asserts the slice carries the most-recent five
// (cap=“RecentSessionsPerAgent“) in descending “started_at“
// order. Regression guard for the empty-swimlane-row class of bug:
// when sub-agent sessions fall outside the paginated /v1/sessions
// window, the swimlane previously rendered no event circles because
// “buildFlavors“ had nothing to populate from. The embedded
// rollup is the contract that makes the row materialise regardless
// of where the session sits in the global page.
func TestGetAgentFleet_RecentSessionsAttached(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Microsecond)
	agentID := seedAgentForList(t, s,
		"test-recent-sessions-"+randomUUID(t)[:8],
		agentListOpts{
			agentType:  "production",
			clientType: "claude_code",
			userName:   "test-recent",
			hostname:   "test-recent-host",
			lastSeen:   now,
		})

	// Seven sessions, spaced one hour apart, oldest first. The
	// rollup must return the latest five in descending order.
	sessionIDs := make([]string, 7)
	for i := 0; i < 7; i++ {
		sessionIDs[i] = randomUUID(t)
		startedAt := now.Add(time.Duration(-i) * time.Hour)
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type
			) VALUES (
				$1::uuid, $2::uuid, $3, 'closed',
				$4, $4, $5,
				'production', 'claude_code'
			)
		`, sessionIDs[i], agentID,
			"test-recent-sessions",
			startedAt, 100+i*10); err != nil {
			t.Fatalf("seed session %d: %v", i, err)
		}
	}

	agents, _, err := s.GetAgentFleet(ctx, 200, 0, "")
	if err != nil {
		t.Fatalf("GetAgentFleet: %v", err)
	}

	var found *AgentSummary
	for i := range agents {
		if agents[i].AgentID == agentID {
			found = &agents[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("seeded agent %s missing from fleet", agentID)
	}
	if len(found.RecentSessions) != RecentSessionsPerAgent {
		t.Fatalf("recent_sessions length=%d, want %d",
			len(found.RecentSessions), RecentSessionsPerAgent)
	}
	// Descending started_at means sessionIDs[0..4] (i=0 is newest).
	for i, rs := range found.RecentSessions {
		if rs.SessionID != sessionIDs[i] {
			t.Errorf("position %d session_id=%s, want %s",
				i, rs.SessionID, sessionIDs[i])
		}
		if i > 0 {
			prev := found.RecentSessions[i-1]
			// This row's started_at must be at-or-before the
			// previous row's (descending sort with equal-time
			// tolerance).
			if rs.StartedAt.After(prev.StartedAt) {
				t.Errorf("recent_sessions not descending at %d: "+
					"prev=%v this=%v", i, prev.StartedAt, rs.StartedAt)
			}
		}
		if rs.AgentID == nil || *rs.AgentID != agentID {
			t.Errorf("recent_sessions[%d] agent_id mismatch: got=%v",
				i, rs.AgentID)
		}
	}
}

// TestGetRecentSessionsByAgentIDs_Empty exercises the empty-input
// short-circuit. Avoids needlessly round-tripping Postgres when the
// caller hasn't filled the slice yet.
func TestGetRecentSessionsByAgentIDs_Empty(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	got, err := s.GetRecentSessionsByAgentIDs(
		context.Background(), nil, RecentSessionsPerAgent,
	)
	if err != nil {
		t.Fatalf("empty input err: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("empty input map len=%d, want 0", len(got))
	}
}

// --- Assertion helpers ---

func assertContainsAgent(t *testing.T, resp *AgentListResponse, agentID string, expected bool) {
	t.Helper()
	for _, a := range resp.Agents {
		if a.AgentID == agentID {
			if !expected {
				t.Errorf("unexpected match for agent_id %s", agentID)
			}
			return
		}
	}
	if expected {
		t.Errorf("expected agent_id %s in response, got %d agents (none matched)", agentID, len(resp.Agents))
	}
}

// assertOrder verifies the agents appear in the expected order (only
// the ids in “want“ are checked; interleaving rows from other
// fixtures in the shared test DB are ignored).
func assertOrder(t *testing.T, resp *AgentListResponse, want []string) {
	t.Helper()
	seen := []string{}
	for _, a := range resp.Agents {
		for _, w := range want {
			if a.AgentID == w {
				seen = append(seen, a.AgentID)
			}
		}
	}
	if len(seen) != len(want) {
		t.Fatalf("expected all %d ids in response, got %d (response size=%d)",
			len(want), len(seen), len(resp.Agents))
	}
	for i, id := range want {
		if seen[i] != id {
			t.Errorf("order mismatch at position %d: want %s, got %s (full: %v)",
				i, id, seen[i], seen)
		}
	}
}
