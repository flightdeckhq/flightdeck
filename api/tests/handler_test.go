package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/handlers"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
)

// --- Mock Store ---

type mockStore struct {
	policies         []store.Policy
	lastSearchQuery  string
	directives       []store.Directive
	customDirectives []store.CustomDirective
	contextFacets    map[string][]store.ContextFacetValue
	contextFacetsErr error
	tokens           []store.AccessTokenRow

	// Last EventsParams / session-events-limit observed by the mock.
	// Used by drawer-pagination tests to assert that handler-layer
	// parsing threads ``before``/``order`` into the store call and
	// ``events_limit`` into GetSessionEvents without relying on the
	// mock to simulate time-window filtering.
	lastEventsParams       *store.EventsParams
	lastSessionEventsLimit int

	// Admin-reconcile handler-test plumbing. The handler calls
	// ReconcileAgents unconditionally; tests inject the desired
	// result (or an error) via these fields.
	reconcileResult *store.ReconcileResult
	reconcileErr    error
	// lastReconcileOrphanThreshold records the threshold the
	// handler forwarded so tests can assert query-param parsing
	// (orphan_threshold_secs default + override + skip).
	lastReconcileOrphanThreshold time.Duration

	// Agents endpoint handler-test plumbing. ListAgents returns
	// ``agentListResult`` (or ``agentListErr``) and records the
	// params it was called with via ``lastAgentListParams`` so the
	// handler's parse → store-params mapping can be asserted
	// directly.
	agentListResult     *store.AgentListResponse
	agentListErr        error
	lastAgentListParams *store.AgentListParams

	// GetAgentByID plumbing — by-id lookup map + optional error.
	agentsByID        map[string]*store.AgentSummary
	agentByIDErr      error
	lastAgentByIDArg  string

	// Records the last GetSessions params so handler tests can
	// assert the parse → store-params mapping. Nil unless set by a
	// call.
	lastSessionsParams *store.SessionsParams
}

func (m *mockStore) GetContextFacets(_ context.Context) (map[string][]store.ContextFacetValue, error) {
	if m.contextFacetsErr != nil {
		return nil, m.contextFacetsErr
	}
	if m.contextFacets == nil {
		return map[string][]store.ContextFacetValue{}, nil
	}
	return m.contextFacets, nil
}

func (m *mockStore) GetAgentFleet(_ context.Context, limit, offset int, agentType string) ([]store.AgentSummary, int, error) {
	all := []store.AgentSummary{
		{
			AgentID:       "11111111-1111-4111-8111-111111111111",
			AgentName:     "research-agent",
			AgentType:     "production",
			ClientType:    "flightdeck_sensor",
			UserName:      "svc-research",
			Hostname:      "worker-1",
			FirstSeenAt:   time.Now().Add(-time.Hour),
			LastSeenAt:    time.Now(),
			TotalSessions: 2,
			TotalTokens:   5000,
			State:         "active",
		},
		{
			AgentID:       "22222222-2222-4222-8222-222222222222",
			AgentName:     "dev-helper",
			AgentType:     "coding",
			ClientType:    "claude_code",
			UserName:      "omria",
			Hostname:      "laptop-1",
			FirstSeenAt:   time.Now().Add(-time.Hour),
			LastSeenAt:    time.Now(),
			TotalSessions: 1,
			TotalTokens:   1000,
			State:         "active",
		},
	}

	switch agentType {
	case "":
		return all, len(all), nil
	default:
		var filtered []store.AgentSummary
		for _, a := range all {
			if a.AgentType == agentType {
				filtered = append(filtered, a)
			}
		}
		return filtered, len(filtered), nil
	}
}

func (m *mockStore) GetSession(_ context.Context, id string) (*store.Session, error) {
	if id == "unknown" {
		return nil, nil
	}
	if id == "sess-with-policy" {
		limit := int64(100000)
		warn := 80
		block := 100
		return &store.Session{
			SessionID: id, Flavor: "test-flavor", State: "active",
			StartedAt: time.Now(), LastSeenAt: time.Now(),
			PolicyTokenLimit: &limit, WarnAtPct: &warn, BlockAtPct: &block,
		}, nil
	}
	sess := &store.Session{SessionID: id, Flavor: "test", State: "active", StartedAt: time.Now(), LastSeenAt: time.Now()}
	// Check for pending directives in mock
	for _, d := range m.directives {
		if d.DeliveredAt == nil && (d.SessionID != nil && *d.SessionID == id) {
			sess.HasPendingDirective = true
			break
		}
	}
	return sess, nil
}

func (m *mockStore) GetSessionEvents(_ context.Context, _ string, limit int) ([]store.Event, error) {
	m.lastSessionEventsLimit = limit
	events := []store.Event{
		{ID: "e1", EventType: "session_start", OccurredAt: time.Now().Add(-time.Minute)},
		{ID: "e2", EventType: "post_call", OccurredAt: time.Now()},
	}
	// Mirror production semantics: limit <= 0 returns everything;
	// limit > 0 returns the N newest (here the tail) still in ASC
	// order so assertions on ordering match the real store.
	if limit > 0 && limit < len(events) {
		events = events[len(events)-limit:]
	}
	return events, nil
}

func (m *mockStore) GetEvent(_ context.Context, eventID string) (*store.Event, error) {
	// Synthesize a minimal event keyed on the requested id so hub
	// tests can assert that GetEvent-by-PK is actually called. Mirror
	// the shape returned by the real Store.GetEvent: (nil, nil) means
	// "not found" (caller skips broadcast per D-hub-race defensive
	// path), otherwise a populated Event.
	if eventID == "" || eventID == "missing" {
		return nil, nil
	}
	return &store.Event{
		ID:         eventID,
		SessionID:  "sess-001",
		EventType:  "post_call",
		OccurredAt: time.Now(),
	}, nil
}

func (m *mockStore) GetSessionAttachments(_ context.Context, _ string) ([]time.Time, error) {
	return nil, nil
}

func (m *mockStore) GetEventContent(_ context.Context, eventID string) (*store.EventContent, error) {
	if eventID == "evt-with-content" {
		sys := "You are a helpful assistant."
		return &store.EventContent{
			EventID:      eventID,
			SessionID:    "sess-001",
			Provider:     "openai",
			Model:        "gpt-4",
			SystemPrompt: &sys,
			Messages:     []any{map[string]any{"role": "user", "content": "hello"}},
			Tools:        nil,
			Response:     map[string]any{"role": "assistant", "content": "hi"},
			CapturedAt:   time.Now(),
		}, nil
	}
	return nil, nil
}

func (m *mockStore) GetEffectivePolicy(_ context.Context, flavor, _ string) (*store.Policy, error) {
	if flavor == "test-flavor" {
		limit := int64(10000)
		warn := 80
		return &store.Policy{
			ID: "pol-1", Scope: "flavor", ScopeValue: "test-flavor",
			TokenLimit: &limit, WarnAtPct: &warn,
		}, nil
	}
	if flavor == "org-fallback-flavor" {
		// No flavor policy exists, but an org-scoped policy does
		limit := int64(50000)
		return &store.Policy{
			ID: "pol-org", Scope: "org", ScopeValue: "",
			TokenLimit: &limit,
		}, nil
	}
	return nil, nil
}

func (m *mockStore) GetPolicies(_ context.Context) ([]store.Policy, error) {
	if m.policies == nil {
		return []store.Policy{}, nil
	}
	return m.policies, nil
}

func (m *mockStore) GetPolicyByID(_ context.Context, id string) (*store.Policy, error) {
	for i := range m.policies {
		if m.policies[i].ID == id {
			return &m.policies[i], nil
		}
	}
	return nil, nil
}

func (m *mockStore) UpsertPolicy(_ context.Context, p store.Policy) (*store.Policy, error) {
	p.ID = "new-pol-id"
	p.CreatedAt = time.Now()
	p.UpdatedAt = time.Now()
	m.policies = append(m.policies, p)
	return &p, nil
}

func (m *mockStore) UpdatePolicy(_ context.Context, id string, p store.Policy) (*store.Policy, error) {
	for i := range m.policies {
		if m.policies[i].ID == id {
			p.ID = id
			p.CreatedAt = m.policies[i].CreatedAt
			p.UpdatedAt = time.Now()
			m.policies[i] = p
			return &p, nil
		}
	}
	return nil, pgx.ErrNoRows
}

func (m *mockStore) DeletePolicy(_ context.Context, id string) error {
	for i, p := range m.policies {
		if p.ID == id {
			m.policies = append(m.policies[:i], m.policies[i+1:]...)
			return nil
		}
	}
	return pgx.ErrNoRows
}

// --- Token CRUD (D095) ---

func (m *mockStore) ListAccessTokens(_ context.Context) ([]store.AccessTokenRow, error) {
	return append([]store.AccessTokenRow(nil), m.tokens...), nil
}

func (m *mockStore) CreateAccessToken(_ context.Context, name string) (*store.CreatedAccessTokenResponse, error) {
	if name == "" {
		return nil, store.ErrAccessTokenNameRequired
	}
	created := &store.CreatedAccessTokenResponse{
		ID:        fmt.Sprintf("tok-%d", len(m.tokens)+1),
		Name:      name,
		Prefix:    "ftd_mock",
		RawToken:  "ftd_mock" + name,
		CreatedAt: time.Now(),
	}
	m.tokens = append(m.tokens, store.AccessTokenRow{
		ID: created.ID, Name: name, Prefix: created.Prefix, CreatedAt: created.CreatedAt,
	})
	return created, nil
}

func (m *mockStore) DeleteAccessToken(_ context.Context, id string) error {
	for i, t := range m.tokens {
		if t.ID == id {
			if t.Name == "Development Token" {
				return store.ErrDevAccessTokenProtected
			}
			m.tokens = append(m.tokens[:i], m.tokens[i+1:]...)
			return nil
		}
	}
	return store.ErrAccessTokenNotFound
}

func (m *mockStore) RenameAccessToken(_ context.Context, id, newName string) (*store.AccessTokenRow, error) {
	if newName == "" {
		return nil, store.ErrAccessTokenNameRequired
	}
	for i := range m.tokens {
		if m.tokens[i].ID == id {
			if m.tokens[i].Name == "Development Token" {
				return nil, store.ErrDevAccessTokenProtected
			}
			m.tokens[i].Name = newName
			out := m.tokens[i]
			return &out, nil
		}
	}
	return nil, store.ErrAccessTokenNotFound
}

func (m *mockStore) CreateDirective(_ context.Context, d store.Directive) (*store.Directive, error) {
	d.ID = "dir-new-id"
	d.IssuedBy = "dashboard"
	d.IssuedAt = time.Now()
	m.directives = append(m.directives, d)
	return &d, nil
}

func (m *mockStore) GetActiveSessionIDsByFlavor(_ context.Context, flavor string) ([]string, error) {
	fixture := map[string][]store.Session{
		"research-agent": {
			{SessionID: "s1", State: "active"},
			{SessionID: "s2", State: "closed"},
		},
	}
	var ids []string
	for _, s := range fixture[flavor] {
		if s.State == "active" || s.State == "idle" {
			ids = append(ids, s.SessionID)
		}
	}
	return ids, nil
}

func (m *mockStore) Search(_ context.Context, query string) (*store.SearchResults, error) {
	m.lastSearchQuery = query
	if query == "no-match" {
		return &store.SearchResults{
			Agents: []store.SearchResultAgent{}, Sessions: []store.SearchResultSession{}, Events: []store.SearchResultEvent{},
		}, nil
	}
	return &store.SearchResults{
		Agents: []store.SearchResultAgent{{AgentName: "test-agent", AgentType: "production", LastSeen: "2026-04-08"}},
		Sessions: []store.SearchResultSession{{
			SessionID: "s1", Flavor: "test-agent", Host: "host-1", State: "active", StartedAt: "2026-04-08",
			Model: "claude-sonnet-4-6", TokensUsed: 3000, Context: map[string]interface{}{"os": "Linux", "hostname": "host-1"},
		}},
		Events: []store.SearchResultEvent{{EventID: "e1", SessionID: "s1", EventType: "post_call", ToolName: "search", Model: "claude", OccurredAt: "2026-04-08"}},
	}, nil
}

func (m *mockStore) GetSessions(_ context.Context, params store.SessionsParams) (*store.SessionsResponse, error) {
	paramsCopy := params
	m.lastSessionsParams = &paramsCopy
	sessions := []store.SessionListItem{
		{SessionID: "s1", Flavor: "research-agent", State: "active", StartedAt: time.Now(), TokensUsed: 3000, Context: map[string]interface{}{"os": "Linux"}},
		{SessionID: "s2", Flavor: "research-agent", State: "closed", StartedAt: time.Now().Add(-time.Hour), TokensUsed: 2000, Context: map[string]interface{}{"os": "Darwin"}},
		{SessionID: "s3", Flavor: "dev-helper", State: "active", StartedAt: time.Now(), TokensUsed: 1000, Context: map[string]interface{}{}},
	}
	// Apply query filter (simple substring match for mock)
	if params.Query != "" {
		var filtered []store.SessionListItem
		for _, s := range sessions {
			if strings.Contains(strings.ToLower(s.Flavor), strings.ToLower(params.Query)) ||
				strings.Contains(strings.ToLower(s.State), strings.ToLower(params.Query)) {
				filtered = append(filtered, s)
			}
		}
		sessions = filtered
	}
	// Apply state filter
	if len(params.States) > 0 {
		stateSet := make(map[string]bool)
		for _, st := range params.States {
			stateSet[st] = true
		}
		var filtered []store.SessionListItem
		for _, s := range sessions {
			if stateSet[s.State] {
				filtered = append(filtered, s)
			}
		}
		sessions = filtered
	}
	if sessions == nil {
		sessions = []store.SessionListItem{}
	}
	total := len(sessions)
	end := params.Offset + params.Limit
	if end > total {
		end = total
	}
	start := params.Offset
	if start > total {
		start = total
	}
	page := sessions[start:end]
	return &store.SessionsResponse{
		Sessions: page,
		Total:    total,
		Limit:    params.Limit,
		Offset:   params.Offset,
		HasMore:  params.Offset+params.Limit <= total,
	}, nil
}

func (m *mockStore) GetEvents(_ context.Context, params store.EventsParams) (*store.EventsResponse, error) {
	paramsCopy := params
	m.lastEventsParams = &paramsCopy
	events := []store.Event{
		{ID: "e1", SessionID: "s1", Flavor: "test-agent", EventType: "post_call", HasContent: false, OccurredAt: time.Now()},
		{ID: "e2", SessionID: "s1", Flavor: "test-agent", EventType: "tool_call", HasContent: false, OccurredAt: time.Now()},
	}
	// Apply filters
	var filtered []store.Event
	for _, e := range events {
		if params.Flavor != "" && e.Flavor != params.Flavor {
			continue
		}
		if params.EventType != "" && e.EventType != params.EventType {
			continue
		}
		filtered = append(filtered, e)
	}
	if filtered == nil {
		filtered = []store.Event{}
	}
	end := params.Offset + params.Limit
	if end > len(filtered) {
		end = len(filtered)
	}
	start := params.Offset
	if start > len(filtered) {
		start = len(filtered)
	}
	page := filtered[start:end]
	return &store.EventsResponse{
		Events:  page,
		Total:   len(filtered),
		Limit:   params.Limit,
		Offset:  params.Offset,
		// Mirror the production formula in store/events.go so the
		// mock cannot drift from real semantics under future test
		// changes. See the GetEvents godoc for the rationale.
		HasMore: params.Offset+params.Limit <= len(filtered),
	}, nil
}

func (m *mockStore) SyncDirectives(_ context.Context, flavor string, fingerprints []string) ([]string, error) {
	found := make(map[string]bool)
	for _, cd := range m.customDirectives {
		if cd.Flavor != flavor {
			continue
		}
		found[cd.Fingerprint] = true
	}
	var unknown []string
	for _, fp := range fingerprints {
		if !found[fp] {
			unknown = append(unknown, fp)
		}
	}
	if unknown == nil {
		unknown = []string{}
	}
	return unknown, nil
}

func (m *mockStore) RegisterDirectives(_ context.Context, directives []store.CustomDirective) error {
	for _, d := range directives {
		d.ID = "cd-new-id"
		d.RegisteredAt = time.Now()
		d.LastSeenAt = time.Now()
		m.customDirectives = append(m.customDirectives, d)
	}
	return nil
}

func (m *mockStore) GetCustomDirectives(_ context.Context, flavor string) ([]store.CustomDirective, error) {
	if flavor == "" {
		if m.customDirectives == nil {
			return []store.CustomDirective{}, nil
		}
		return m.customDirectives, nil
	}
	var result []store.CustomDirective
	for _, cd := range m.customDirectives {
		if cd.Flavor == flavor {
			result = append(result, cd)
		}
	}
	if result == nil {
		result = []store.CustomDirective{}
	}
	return result, nil
}

func (m *mockStore) DeleteCustomDirectivesByNamePrefix(_ context.Context, namePrefix string) (int64, error) {
	if namePrefix == "" {
		return 0, nil
	}
	kept := make([]store.CustomDirective, 0, len(m.customDirectives))
	var deleted int64
	for _, cd := range m.customDirectives {
		if len(cd.Name) >= len(namePrefix) && cd.Name[:len(namePrefix)] == namePrefix {
			deleted++
			continue
		}
		kept = append(kept, cd)
	}
	m.customDirectives = kept
	return deleted, nil
}

func (m *mockStore) CustomDirectiveExists(_ context.Context, fingerprint, flavor string) (bool, error) {
	for _, cd := range m.customDirectives {
		if cd.Fingerprint != fingerprint {
			continue
		}
		if flavor != "" && cd.Flavor != flavor {
			continue
		}
		return true, nil
	}
	return false, nil
}

func (m *mockStore) QueryAnalytics(_ context.Context, params store.AnalyticsParams) (*store.AnalyticsResponse, error) {
	return &store.AnalyticsResponse{
		Metric:      params.Metric,
		GroupBy:     params.GroupBy,
		Range:       params.Range,
		Granularity: params.Granularity,
		Series: []store.AnalyticsSeries{
			{Dimension: "research-agent", Total: 5000, Data: []store.DataPoint{{Date: "2026-04-01", Value: 5000}}},
		},
		Totals: store.AnalyticsTotals{GrandTotal: 5000, PeriodChangePct: 10.0},
	}, nil
}

// ListAgents records the params it was called with and returns the
// preconfigured result. Tests that don't set ``agentListResult``
// get an empty response shape.
func (m *mockStore) ListAgents(_ context.Context, params store.AgentListParams) (*store.AgentListResponse, error) {
	m.lastAgentListParams = &params
	if m.agentListErr != nil {
		return nil, m.agentListErr
	}
	if m.agentListResult != nil {
		return m.agentListResult, nil
	}
	return &store.AgentListResponse{
		Agents: []store.AgentSummary{},
		Total:  0,
		Limit:  params.Limit,
		Offset: params.Offset,
	}, nil
}

// GetAgentByID consults ``agentsByID`` and returns the match or
// nil when the id is absent. Tests set ``agentByIDErr`` to simulate
// a DB failure.
func (m *mockStore) GetAgentByID(_ context.Context, agentID string) (*store.AgentSummary, error) {
	m.lastAgentByIDArg = agentID
	if m.agentByIDErr != nil {
		return nil, m.agentByIDErr
	}
	if m.agentsByID == nil {
		return nil, nil
	}
	return m.agentsByID[agentID], nil
}

// ReconcileAgents is a no-op mock: the admin-reconcile handler tests
// set ``m.reconcileResult`` / ``m.reconcileErr`` per-test (see the
// reconcile handler tests below) and ignore the context. Tests that
// don't exercise the reconcile path get a zero-agents response.
func (m *mockStore) ReconcileAgents(
	_ context.Context,
	orphanThreshold time.Duration,
) (*store.ReconcileResult, error) {
	m.lastReconcileOrphanThreshold = orphanThreshold
	if m.reconcileErr != nil {
		return nil, m.reconcileErr
	}
	if m.reconcileResult != nil {
		return m.reconcileResult, nil
	}
	return &store.ReconcileResult{
		AgentsScanned:   0,
		AgentsUpdated:   0,
		CountersUpdated: map[string]int{},
		AgentsDeleted:   0,
		DeleteThreshold: "",
		DurationMs:      0,
		Errors:          []string{},
	}, nil
}

// --- Tests ---

func TestHealthHandler_Returns200(t *testing.T) {
	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	handlers.HealthHandler()(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["service"] != "api" {
		t.Errorf("expected service=api, got %s", body["service"])
	}
}

func TestFleetHandler_ReturnsAgents(t *testing.T) {
	s := &mockStore{}
	handler := handlers.FleetHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/fleet", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	agents, ok := resp["agents"].([]any)
	if !ok || len(agents) != 2 {
		t.Errorf("expected 2 agents, got %v", resp["agents"])
	}
}

func TestFleetHandler_FilterByAgentType_Coding(t *testing.T) {
	s := &mockStore{}
	handler := handlers.FleetHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/fleet?agent_type=coding", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	agents, ok := resp["agents"].([]any)
	if !ok || len(agents) != 1 {
		t.Errorf("expected 1 coding agent, got %d", len(agents))
	}
	if len(agents) > 0 {
		fm := agents[0].(map[string]any)
		if fm["agent_type"] != "coding" {
			t.Errorf("expected agent_type=coding, got %v", fm["agent_type"])
		}
	}
}

func TestFleetHandler_FilterByAgentType_Production(t *testing.T) {
	s := &mockStore{}
	handler := handlers.FleetHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/fleet?agent_type=production", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	agents, ok := resp["agents"].([]any)
	if !ok || len(agents) != 1 {
		t.Errorf("expected 1 production agent, got %d", len(agents))
	}
	if len(agents) > 0 {
		fm := agents[0].(map[string]any)
		if fm["agent_type"] != "production" {
			t.Errorf("expected agent_type=production, got %v", fm["agent_type"])
		}
	}
}

func TestGetFleetIncludesContextFacets(t *testing.T) {
	// The fleet handler must surface the runtime context facets that
	// the API store aggregates from sessions.context (JSONB). The
	// dashboard's CONTEXT sidebar reads this map -- a missing or
	// silently-empty `context_facets` field would break filtering.
	s := &mockStore{
		contextFacets: map[string][]store.ContextFacetValue{
			"orchestration": {
				{Value: "kubernetes", Count: 3},
				{Value: "docker", Count: 1},
			},
			"hostname": {
				{Value: "host-1", Count: 2},
			},
		},
	}
	handler := handlers.FleetHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/fleet", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	facets, ok := resp["context_facets"].(map[string]any)
	if !ok {
		t.Fatalf("expected context_facets object, got %T", resp["context_facets"])
	}
	if _, ok := facets["orchestration"]; !ok {
		t.Errorf("expected orchestration facet in response, got keys: %v", facets)
	}
	orch, _ := facets["orchestration"].([]any)
	if len(orch) != 2 {
		t.Errorf("expected 2 orchestration values, got %d", len(orch))
	}
}

func TestGetFleetFacetsErrorDoesNotFail(t *testing.T) {
	// A failure inside GetContextFacets must NOT fail the entire fleet
	// request -- facets are best-effort. The handler logs the error
	// and returns an empty facet map, the rest of the response is
	// unaffected.
	s := &mockStore{
		contextFacetsErr: pgx.ErrNoRows,
	}
	handler := handlers.FleetHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/fleet", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 even with facets error, got %d", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := resp["agents"].([]any); !ok {
		t.Errorf("expected agents array, got %T", resp["agents"])
	}
	facets, ok := resp["context_facets"].(map[string]any)
	if !ok {
		t.Fatalf("expected context_facets object even on error, got %T", resp["context_facets"])
	}
	if len(facets) != 0 {
		t.Errorf("expected empty context_facets on error, got %v", facets)
	}
}

func TestSessionsHandler_ReturnsEventsInOrder(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	events, ok := resp["events"].([]any)
	if !ok || len(events) != 2 {
		t.Errorf("expected 2 events, got %v", resp["events"])
	}
}

// D094: the session detail response must always include the
// "attachments" key -- empty array for sessions that have only ever
// run once, chronological list of ISO-8601 timestamps otherwise.
// Missing key is a contract break; the dashboard drawer relies on it
// to decide whether to draw run separators.
func TestSessionsHandler_IncludesAttachmentsArray(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v body=%s", err, w.Body.String())
	}
	att, ok := resp["attachments"]
	if !ok {
		t.Fatalf("response missing attachments key: %s", w.Body.String())
	}
	// Must be an array, not null. encoding/json emits null for a nil
	// Go slice, which breaks the frontend. SessionsHandler normalises
	// to []time.Time{} before encoding to guarantee "[]" on the wire.
	arr, ok := att.([]any)
	if !ok {
		t.Fatalf("attachments is not a JSON array: %T %v", att, att)
	}
	if len(arr) != 0 {
		t.Errorf("expected empty attachments for mock store, got %v", arr)
	}
}

func TestSessionsHandler_UnknownID_Returns404(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/unknown", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

// D113 drawer pagination: without events_limit the handler must pass
// limit=0 to the store so the full session history is returned.
// Guards against a regression where a future default silently caps
// the payload and breaks non-drawer callers.
func TestSessionsHandler_NoEventsLimit_PassesZeroToStore(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if s.lastSessionEventsLimit != 0 {
		t.Errorf("expected store to receive limit=0 when events_limit is absent, got %d", s.lastSessionEventsLimit)
	}
}

// events_limit is threaded through to the store and produces a
// payload still sorted ASC so the drawer's "reverse for newest-first
// display" pattern stays correct.
func TestSessionsHandler_EventsLimit_PassesThroughAndSortsAsc(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001?events_limit=1", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if s.lastSessionEventsLimit != 1 {
		t.Errorf("expected store to receive limit=1, got %d", s.lastSessionEventsLimit)
	}

	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	events, ok := resp["events"].([]any)
	if !ok {
		t.Fatalf("expected events array, got %T", resp["events"])
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	// Mock keeps the tail (newest) when limit=1 and emits it in ASC
	// order. Verify the handler didn't reverse or otherwise reshape.
	first := events[0].(map[string]any)
	if first["event_type"] != "post_call" {
		t.Errorf("expected newest event (post_call), got %v", first["event_type"])
	}
}

func TestSessionsHandler_EventsLimit_Zero_Returns400(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001?events_limit=0", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for events_limit=0, got %d", w.Code)
	}
}

func TestSessionsHandler_EventsLimit_Negative_Returns400(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001?events_limit=-5", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for negative events_limit, got %d", w.Code)
	}
}

func TestSessionsHandler_EventsLimit_ExceedsMax_Returns400(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001?events_limit=99999", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for events_limit>1000, got %d", w.Code)
	}
}

func TestSessionsHandler_EventsLimit_NonNumeric_Returns400(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-001?events_limit=abc", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for non-numeric events_limit, got %d", w.Code)
	}
}

func TestStreamHandler_ReceivesBroadcast(t *testing.T) {
	hub := ws.NewHub(&mockStore{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/stream", handlers.StreamHandler(hub, nil))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + srv.URL[4:] + "/v1/stream"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	// Wait for client to register in the hub
	registered := false
	for i := 0; i < 20; i++ {
		if hub.ClientCount() > 0 {
			registered = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !registered {
		t.Fatal("WebSocket client did not register within 100ms")
	}

	hub.Broadcast([]byte(`{"type":"session_update"}`))

	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(msg) != `{"type":"session_update"}` {
		t.Errorf("expected broadcast message, got %s", msg)
	}
}

func TestEffectivePolicyHandler_ReturnsFlavored(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EffectivePolicyHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/policy?flavor=test-flavor", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestEffectivePolicyHandler_Returns404WhenNone(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EffectivePolicyHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/policy?flavor=unknown", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestEffectivePolicyHandler_FallsBackToOrg(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EffectivePolicyHandler(store.WrapStore(s))
	// "org-fallback-flavor" has no flavor policy but mock returns org-scoped policy
	req := httptest.NewRequest("GET", "/v1/policy?flavor=org-fallback-flavor", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (org fallback), got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["scope"] != "org" {
		t.Errorf("expected org scope in fallback, got %v", resp["scope"])
	}
}

func TestEffectivePolicyHandler_Returns404NoPolicy(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EffectivePolicyHandler(store.WrapStore(s))
	// "nonexistent" has no policy at any scope
	req := httptest.NewRequest("GET", "/v1/policy?flavor=nonexistent", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestPoliciesListHandler_Empty(t *testing.T) {
	s := &mockStore{}
	handler := handlers.PoliciesListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/policies", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if w.Body.String() != "[]\n" {
		t.Errorf("expected empty array, got %s", w.Body.String())
	}
}

func TestPolicyCreateHandler_Succeeds(t *testing.T) {
	s := &mockStore{}
	handler := handlers.PolicyCreateHandler(store.WrapStore(s))
	body := `{"scope":"flavor","scope_value":"test-agent","token_limit":100000,"warn_at_pct":80,"degrade_at_pct":90,"block_at_pct":100}`
	req := httptest.NewRequest("POST", "/v1/policies", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] == nil {
		t.Error("expected id in response")
	}
	if resp["scope"] != "flavor" {
		t.Errorf("expected scope=flavor, got %v", resp["scope"])
	}
}

func TestPolicyCreateHandler_InvalidThresholds(t *testing.T) {
	s := &mockStore{}
	handler := handlers.PolicyCreateHandler(store.WrapStore(s))
	body := `{"scope":"flavor","scope_value":"test","warn_at_pct":90,"degrade_at_pct":80,"block_at_pct":100}`
	req := httptest.NewRequest("POST", "/v1/policies", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestPolicyUpdateHandler_Succeeds(t *testing.T) {
	limit := int64(100000)
	s := &mockStore{
		policies: []store.Policy{{ID: "pol-1", Scope: "flavor", ScopeValue: "test", TokenLimit: &limit}},
	}
	handler := handlers.PolicyUpdateHandler(store.WrapStore(s))
	body := `{"scope":"flavor","scope_value":"test","token_limit":200000,"warn_at_pct":80,"degrade_at_pct":90,"block_at_pct":100}`
	req := httptest.NewRequest("PUT", "/v1/policies/pol-1", bytes.NewBufferString(body))
	req.SetPathValue("id", "pol-1")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestPolicyDeleteHandler_Succeeds(t *testing.T) {
	s := &mockStore{
		policies: []store.Policy{{ID: "pol-del", Scope: "org", ScopeValue: ""}},
	}
	handler := handlers.PolicyDeleteHandler(store.WrapStore(s))
	req := httptest.NewRequest("DELETE", "/v1/policies/pol-del", nil)
	req.SetPathValue("id", "pol-del")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}
}

func TestGetSession_IncludesPolicyWhenExists(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-with-policy", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	session := resp["session"].(map[string]any)

	if session["policy_token_limit"] != float64(100000) {
		t.Errorf("expected policy_token_limit=100000, got %v", session["policy_token_limit"])
	}
	if session["warn_at_pct"] != float64(80) {
		t.Errorf("expected warn_at_pct=80, got %v", session["warn_at_pct"])
	}
	if session["block_at_pct"] != float64(100) {
		t.Errorf("expected block_at_pct=100, got %v", session["block_at_pct"])
	}
}

func TestGetSession_PolicyFieldsNullWhenNoPolicy(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-no-policy", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	session := resp["session"].(map[string]any)

	if session["policy_token_limit"] != nil {
		t.Errorf("expected policy_token_limit=nil, got %v", session["policy_token_limit"])
	}
	if session["warn_at_pct"] != nil {
		t.Errorf("expected warn_at_pct=nil, got %v", session["warn_at_pct"])
	}
	if session["degrade_at_pct"] != nil {
		t.Errorf("expected degrade_at_pct=nil, got %v", session["degrade_at_pct"])
	}
	if session["degrade_to"] != nil {
		t.Errorf("expected degrade_to=nil, got %v", session["degrade_to"])
	}
	if session["block_at_pct"] != nil {
		t.Errorf("expected block_at_pct=nil, got %v", session["block_at_pct"])
	}
}

func TestUpdatePolicyByID_NotScope(t *testing.T) {
	limit := int64(100000)
	warn := 80
	s := &mockStore{
		policies: []store.Policy{{
			ID: "pol-update", Scope: "flavor", ScopeValue: "old-agent",
			TokenLimit: &limit, WarnAtPct: &warn,
			CreatedAt: time.Now(), UpdatedAt: time.Now(),
		}},
	}

	// Update with a different scope_value -- should update the existing row by ID
	handler := handlers.PolicyUpdateHandler(store.WrapStore(s))
	body := `{"scope":"flavor","scope_value":"new-agent","token_limit":200000,"warn_at_pct":90}`
	req := httptest.NewRequest("PUT", "/v1/policies/pol-update", bytes.NewBufferString(body))
	req.SetPathValue("id", "pol-update")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify the response has the original ID, not a new one
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] != "pol-update" {
		t.Errorf("expected id=pol-update, got %v", resp["id"])
	}
	if resp["scope_value"] != "new-agent" {
		t.Errorf("expected scope_value=new-agent, got %v", resp["scope_value"])
	}

	// Verify only one policy exists (no duplicate created)
	listHandler := handlers.PoliciesListHandler(store.WrapStore(s))
	listReq := httptest.NewRequest("GET", "/v1/policies", nil)
	listW := httptest.NewRecorder()
	listHandler(listW, listReq)

	var policies []any
	_ = json.Unmarshal(listW.Body.Bytes(), &policies)
	if len(policies) != 1 {
		t.Errorf("expected 1 policy, got %d", len(policies))
	}
}

func TestCreatePolicyInvalidScope(t *testing.T) {
	s := &mockStore{}
	handler := handlers.PolicyCreateHandler(store.WrapStore(s))
	body := `{"scope":"invalid","scope_value":"x","token_limit":100}`
	req := httptest.NewRequest("POST", "/v1/policies", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	errMsg, _ := resp["error"].(string)
	if errMsg == "" || !contains(errMsg, "scope must be one of") {
		t.Errorf("expected error containing 'scope must be one of', got %q", errMsg)
	}
}

func TestCreatePolicyEmptyScopeValue(t *testing.T) {
	s := &mockStore{}
	handler := handlers.PolicyCreateHandler(store.WrapStore(s))
	body := `{"scope":"flavor","scope_value":"","token_limit":100}`
	req := httptest.NewRequest("POST", "/v1/policies", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	errMsg, _ := resp["error"].(string)
	if errMsg == "" || !contains(errMsg, "scope_value is required") {
		t.Errorf("expected error containing 'scope_value is required', got %q", errMsg)
	}
}

func TestDeletePolicyNotFound(t *testing.T) {
	s := &mockStore{} // empty -- DeletePolicy will return pgx.ErrNoRows
	handler := handlers.PolicyDeleteHandler(store.WrapStore(s))
	req := httptest.NewRequest("DELETE", "/v1/policies/00000000-0000-0000-0000-000000000000", nil)
	req.SetPathValue("id", "00000000-0000-0000-0000-000000000000")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestListPoliciesWithData(t *testing.T) {
	limit1 := int64(10000)
	limit2 := int64(50000)
	warn := 80
	s := &mockStore{
		policies: []store.Policy{
			{ID: "pol-1", Scope: "flavor", ScopeValue: "agent-a", TokenLimit: &limit1, WarnAtPct: &warn, CreatedAt: time.Now(), UpdatedAt: time.Now()},
			{ID: "pol-2", Scope: "org", ScopeValue: "", TokenLimit: &limit2, CreatedAt: time.Now(), UpdatedAt: time.Now()},
		},
	}
	handler := handlers.PoliciesListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/policies", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var policies []any
	_ = json.Unmarshal(w.Body.Bytes(), &policies)
	if len(policies) != 2 {
		t.Errorf("expected 2 policies, got %d", len(policies))
	}
	// Verify first policy has expected fields
	p1 := policies[0].(map[string]any)
	if p1["id"] != "pol-1" {
		t.Errorf("expected first policy id=pol-1, got %v", p1["id"])
	}
	if p1["scope"] != "flavor" {
		t.Errorf("expected scope=flavor, got %v", p1["scope"])
	}
}

// contains checks if s contains substr (helper to avoid importing strings).
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// --- Directive Tests ---

func TestCreateDirectiveShutdown(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"shutdown","session_id":"00000000-0000-0000-0000-000000000001","reason":"manual_kill_switch"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] == nil || resp["id"] == "" {
		t.Error("expected id in response")
	}
	if resp["action"] != "shutdown" {
		t.Errorf("expected action=shutdown, got %v", resp["action"])
	}
}

func TestCreateDirectiveShutdownFlavor(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"shutdown_flavor","flavor":"research-agent","reason":"manual_fleet_kill"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateDirectiveMissingSessionID(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"shutdown"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !contains(resp["error"].(string), "session_id is required") {
		t.Errorf("expected error about session_id, got %v", resp["error"])
	}
}

func TestCreateDirectiveMissingFlavor(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"shutdown_flavor"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !contains(resp["error"].(string), "flavor is required") {
		t.Errorf("expected error about flavor, got %v", resp["error"])
	}
}

func TestCreateDirectiveInvalidAction(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"reboot","session_id":"abc"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestGetSessionIncludesPendingDirective(t *testing.T) {
	sessID := "sess-with-directive"
	s := &mockStore{
		directives: []store.Directive{
			{ID: "dir-1", SessionID: &sessID, Action: "shutdown"},
		},
	}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/"+sessID, nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	session := resp["session"].(map[string]any)
	if session["has_pending_directive"] != true {
		t.Errorf("expected has_pending_directive=true, got %v", session["has_pending_directive"])
	}
}

func TestGetSessionNoPendingDirective(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions/sess-no-directive", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	session := resp["session"].(map[string]any)
	if session["has_pending_directive"] != false {
		t.Errorf("expected has_pending_directive=false, got %v", session["has_pending_directive"])
	}
}

func TestCreateDirectiveShutdownFlavorNoSessions(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"shutdown_flavor","flavor":"nonexistent-flavor","reason":"test"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	errMsg, _ := resp["error"].(string)
	if !contains(errMsg, "no active sessions") {
		t.Errorf("expected error about no active sessions, got %q", errMsg)
	}
}

// --- Analytics Tests ---

func TestGetAnalyticsTokensByFlavor(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AnalyticsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/analytics?metric=tokens&group_by=flavor", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["metric"] != "tokens" {
		t.Errorf("expected metric=tokens, got %v", resp["metric"])
	}
	if resp["group_by"] != "flavor" {
		t.Errorf("expected group_by=flavor, got %v", resp["group_by"])
	}
	if resp["series"] == nil {
		t.Error("expected series in response")
	}
	if resp["totals"] == nil {
		t.Error("expected totals in response")
	}
}

func TestGetAnalyticsInvalidMetric(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AnalyticsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/analytics?metric=invalid", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestGetAnalyticsInvalidGroupBy(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AnalyticsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/analytics?group_by=invalid", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestGetAnalyticsCustomRangeNoFrom(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AnalyticsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/analytics?range=custom", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestGetAnalyticsCustomRangeValid(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AnalyticsHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/analytics?range=custom&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// --- D126 sub-agent analytics tests ---

func TestGetAnalyticsAcceptsAgentRoleDimension(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AnalyticsHandler(store.WrapStore(s))
	req := httptest.NewRequest(
		"GET",
		"/v1/analytics?metric=tokens&group_by=agent_role",
		nil,
	)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["group_by"] != "agent_role" {
		t.Errorf("expected group_by=agent_role, got %v", resp["group_by"])
	}
}

func TestGetAnalyticsAcceptsSubagentMetrics(t *testing.T) {
	cases := []string{
		"parent_token_sum",
		"child_token_sum",
		"child_count",
		"parent_to_first_child_latency_ms",
	}
	for _, metric := range cases {
		t.Run(metric, func(t *testing.T) {
			s := &mockStore{}
			handler := handlers.AnalyticsHandler(store.WrapStore(s))
			req := httptest.NewRequest(
				"GET",
				"/v1/analytics?metric="+metric+"&group_by=agent_role",
				nil,
			)
			w := httptest.NewRecorder()
			handler(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
			}
			var resp map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &resp)
			if resp["metric"] != metric {
				t.Errorf("expected metric=%s, got %v", metric, resp["metric"])
			}
		})
	}
}

func TestGetAnalyticsAcceptsSubagentFilters(t *testing.T) {
	// Each filter should land cleanly without 400 — the mock store's
	// QueryAnalytics doesn't inspect them, so this test pins the
	// handler-side parsing for parent_session_id /
	// has_sub_agents / is_sub_agent.
	cases := []string{
		"/v1/analytics?metric=tokens&filter_parent_session_id=" +
			"11111111-1111-4111-8111-111111111111",
		"/v1/analytics?metric=parent_token_sum&filter_has_sub_agents=true",
		"/v1/analytics?metric=child_count&filter_is_sub_agent=1",
	}
	for _, url := range cases {
		t.Run(url, func(t *testing.T) {
			s := &mockStore{}
			handler := handlers.AnalyticsHandler(store.WrapStore(s))
			req := httptest.NewRequest("GET", url, nil)
			w := httptest.NewRecorder()
			handler(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestGetAnalyticsRejectsUnknownSubagentMetric(t *testing.T) {
	// Sanity: a metric name in the right "family" but not on the
	// approved list still 400s. Catches typos in the validMetrics
	// map.
	s := &mockStore{}
	handler := handlers.AnalyticsHandler(store.WrapStore(s))
	req := httptest.NewRequest(
		"GET",
		"/v1/analytics?metric=parent_tokens",
		nil,
	)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for typo metric, got %d", w.Code)
	}
}

// --- Event Content Tests ---

func TestContentHandler_ReturnsContent(t *testing.T) {
	s := &mockStore{}
	handler := handlers.ContentHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events/evt-with-content/content", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["event_id"] != "evt-with-content" {
		t.Errorf("expected event_id=evt-with-content, got %v", resp["event_id"])
	}
	if resp["provider"] != "openai" {
		t.Errorf("expected provider=openai, got %v", resp["provider"])
	}
	if resp["system_prompt"] != "You are a helpful assistant." {
		t.Errorf("expected system_prompt, got %v", resp["system_prompt"])
	}
}

func TestContentHandler_Returns404WhenNoContent(t *testing.T) {
	s := &mockStore{}
	handler := handlers.ContentHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events/evt-no-content/content", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestContentHandler_Returns400WhenNoID(t *testing.T) {
	s := &mockStore{}
	handler := handlers.ContentHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events//content", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// --- Search Tests ---

func TestSearchReturnsResults(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SearchHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/search?q=test", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["agents"] == nil {
		t.Error("expected agents in response")
	}
	if resp["sessions"] == nil {
		t.Error("expected sessions in response")
	}
	if resp["events"] == nil {
		t.Error("expected events in response")
	}
}

func TestSearchMissingQuery(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SearchHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/search", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestSearchEmptyQuery(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SearchHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/search?q=", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestSearchQueryTooLong(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SearchHandler(store.WrapStore(s))
	longQ := strings.Repeat("a", 201)
	req := httptest.NewRequest("GET", "/v1/search?q="+longQ, nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestSearchNoResults(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SearchHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/search?q=no-match", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 even with no results, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	agents := resp["agents"].([]any)
	if len(agents) != 0 {
		t.Errorf("expected empty agents, got %d", len(agents))
	}
}

// --- Custom Directive Tests ---

func TestSyncDirectivesReturnsUnknown(t *testing.T) {
	s := &mockStore{
		customDirectives: []store.CustomDirective{
			{ID: "cd-1", Fingerprint: "fp-known", Name: "known-dir", Flavor: "test-agent"},
		},
	}
	handler := handlers.SyncDirectivesHandler(store.WrapStore(s))
	body := `{"flavor":"test-agent","directives":[{"name":"known","fingerprint":"fp-known"},{"name":"unknown","fingerprint":"fp-unknown"}]}`
	req := httptest.NewRequest("POST", "/v1/directives/sync", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	unknown, ok := resp["unknown_fingerprints"].([]any)
	if !ok {
		t.Fatalf("expected unknown_fingerprints array, got %v", resp["unknown_fingerprints"])
	}
	if len(unknown) != 1 {
		t.Errorf("expected 1 unknown fingerprint, got %d", len(unknown))
	}
	if len(unknown) > 0 && unknown[0] != "fp-unknown" {
		t.Errorf("expected fp-unknown, got %v", unknown[0])
	}
}

func TestRegisterDirectivesSuccess(t *testing.T) {
	s := &mockStore{}
	handler := handlers.RegisterDirectivesHandler(store.WrapStore(s))
	body := `{"flavor":"test-agent","directives":[{"fingerprint":"fp-1","name":"custom-dir","description":"a custom directive","parameters":{"key":"value"}}]}`
	req := httptest.NewRequest("POST", "/v1/directives/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["registered"] != float64(1) {
		t.Errorf("expected registered=1, got %v", resp["registered"])
	}
	if len(s.customDirectives) != 1 {
		t.Errorf("expected 1 custom directive in store, got %d", len(s.customDirectives))
	}
}

func TestGetCustomDirectives(t *testing.T) {
	s := &mockStore{
		customDirectives: []store.CustomDirective{
			{ID: "cd-1", Fingerprint: "fp-1", Name: "dir-1", Flavor: "agent-a", RegisteredAt: time.Now(), LastSeenAt: time.Now()},
			{ID: "cd-2", Fingerprint: "fp-2", Name: "dir-2", Flavor: "agent-b", RegisteredAt: time.Now(), LastSeenAt: time.Now()},
		},
	}

	// Test without flavor filter
	handler := handlers.GetCustomDirectivesHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/directives/custom", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	dirs, ok := resp["directives"].([]any)
	if !ok || len(dirs) != 2 {
		t.Errorf("expected 2 directives, got %v", resp["directives"])
	}

	// Test with flavor filter
	req2 := httptest.NewRequest("GET", "/v1/directives/custom?flavor=agent-a", nil)
	w2 := httptest.NewRecorder()
	handler(w2, req2)
	if w2.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w2.Code)
	}
	var resp2 map[string]any
	_ = json.Unmarshal(w2.Body.Bytes(), &resp2)
	dirs2, ok := resp2["directives"].([]any)
	if !ok || len(dirs2) != 1 {
		t.Errorf("expected 1 directive for agent-a, got %v", resp2["directives"])
	}
}

func TestCreateCustomDirectiveAction(t *testing.T) {
	s := &mockStore{
		customDirectives: []store.CustomDirective{
			{ID: "cd-reset", Fingerprint: "fp-reset", Name: "reset_cache", Flavor: "test"},
		},
	}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"custom","session_id":"00000000-0000-0000-0000-000000000001","directive_name":"reset_cache","fingerprint":"fp-reset","parameters":{"force":true}}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] == nil || resp["id"] == "" {
		t.Error("expected id in response")
	}
	if resp["action"] != "custom" {
		t.Errorf("expected action=custom, got %v", resp["action"])
	}
	// Verify payload is stored
	if resp["payload"] == nil {
		t.Error("expected payload in response")
	}
	payload, ok := resp["payload"].(map[string]any)
	if !ok {
		t.Fatalf("expected payload to be an object, got %T", resp["payload"])
	}
	if payload["directive_name"] != "reset_cache" {
		t.Errorf("expected directive_name=reset_cache, got %v", payload["directive_name"])
	}
	if payload["fingerprint"] != "fp-reset" {
		t.Errorf("expected fingerprint=fp-reset, got %v", payload["fingerprint"])
	}
}

func TestCreateCustomDirectiveMissingName(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"custom","session_id":"abc","fingerprint":"fp-1"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !contains(resp["error"].(string), "directive_name is required") {
		t.Errorf("expected error about directive_name, got %v", resp["error"])
	}
}

func TestSyncDirectivesInvalidJSON(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SyncDirectivesHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/directives/sync", bytes.NewBufferString(`{bad`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestSyncDirectivesEmptyArray(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SyncDirectivesHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/directives/sync", bytes.NewBufferString(`{"directives":[]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestSyncDirectivesMissingFingerprint(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SyncDirectivesHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/directives/sync", bytes.NewBufferString(`{"flavor":"test-agent","directives":[{"name":"x","fingerprint":""}]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRegisterDirectivesInvalidJSON(t *testing.T) {
	s := &mockStore{}
	handler := handlers.RegisterDirectivesHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/directives/register", bytes.NewBufferString(`{bad`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRegisterDirectivesEmptyArray(t *testing.T) {
	s := &mockStore{}
	handler := handlers.RegisterDirectivesHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/directives/register", bytes.NewBufferString(`{"directives":[]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRegisterDirectivesMissingName(t *testing.T) {
	s := &mockStore{}
	handler := handlers.RegisterDirectivesHandler(store.WrapStore(s))
	body := `{"flavor":"test","directives":[{"fingerprint":"fp-1","name":"","flavor":"test"}]}`
	req := httptest.NewRequest("POST", "/v1/directives/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRegisterDirectivesMissingFlavor(t *testing.T) {
	s := &mockStore{}
	handler := handlers.RegisterDirectivesHandler(store.WrapStore(s))
	body := `{"directives":[{"fingerprint":"fp-1","name":"test","flavor":""}]}`
	req := httptest.NewRequest("POST", "/v1/directives/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRegisterDirectivesMissingFingerprint(t *testing.T) {
	s := &mockStore{}
	handler := handlers.RegisterDirectivesHandler(store.WrapStore(s))
	body := `{"flavor":"test","directives":[{"fingerprint":"","name":"test"}]}`
	req := httptest.NewRequest("POST", "/v1/directives/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestCreateCustomDirectiveMissingTarget(t *testing.T) {
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"custom","directive_name":"test","fingerprint":"fp-1"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !contains(resp["error"].(string), "session_id or flavor is required") {
		t.Errorf("expected error about session_id or flavor, got %v", resp["error"])
	}
}

func TestCreateCustomDirectiveUnknownFingerprint(t *testing.T) {
	// Empty store -- the supplied fingerprint does not exist.
	s := &mockStore{}
	handler := handlers.CreateDirectiveHandler(store.WrapStore(s))
	body := `{"action":"custom","session_id":"00000000-0000-0000-0000-000000000001","directive_name":"reset","fingerprint":"fp-unknown"}`
	req := httptest.NewRequest("POST", "/v1/directives", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusUnprocessableEntity {
		t.Errorf("expected 422, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !contains(resp["error"].(string), "unknown directive fingerprint") {
		t.Errorf("expected error about unknown fingerprint, got %v", resp["error"])
	}
	// No directive row should have been created.
	if len(s.directives) != 0 {
		t.Errorf("expected 0 directives created on unknown fingerprint, got %d", len(s.directives))
	}
}

func TestGetEventsBasic(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	events, ok := resp["events"].([]any)
	if !ok {
		t.Fatalf("expected events array, got %v", resp["events"])
	}
	if len(events) == 0 {
		t.Error("expected non-empty events array")
	}
}

func TestGetEventsMissingFrom(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestGetEventsLimitTooLarge(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z&limit=9999", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestGetEventsFlavorFilter(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z&flavor=test-agent", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestGetEventsPagination(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z&limit=1&offset=0", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["limit"] != float64(1) {
		t.Errorf("expected limit=1, got %v", resp["limit"])
	}
	if resp["offset"] != float64(0) {
		t.Errorf("expected offset=0, got %v", resp["offset"])
	}
	// has_more must be present and reflect the new
	// (Offset + Limit <= total) formula. The mock store returns 2
	// events; with limit=1, offset=0 the page is the first event and
	// 0 + 1 = 1 <= 2, so has_more must be true.
	hasMore, ok := resp["has_more"].(bool)
	if !ok {
		t.Fatalf("expected has_more bool, got %T", resp["has_more"])
	}
	if !hasMore {
		t.Error("expected has_more=true for limit=1 offset=0 with 2 events")
	}
}

// TestGetEventsHasMoreFormula exercises the new HasMore formula
// (Offset + Limit <= total) at three boundary positions: a strict
// has-more case, the exact boundary, and an over-the-edge offset.
func TestGetEventsHasMoreFormula(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))

	cases := []struct {
		name    string
		limit   int
		offset  int
		hasMore bool
	}{
		// Mock returns 2 events. Offset+Limit <= total branches:
		{name: "offset 0 limit 1 -> 0+1<=2 true", limit: 1, offset: 0, hasMore: true},
		{name: "offset 1 limit 1 -> 1+1<=2 true (boundary)", limit: 1, offset: 1, hasMore: true},
		{name: "offset 2 limit 1 -> 2+1<=2 false", limit: 1, offset: 2, hasMore: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			url := fmt.Sprintf(
				"/v1/events?from=2026-01-01T00:00:00Z&limit=%d&offset=%d",
				tc.limit, tc.offset,
			)
			req := httptest.NewRequest("GET", url, nil)
			w := httptest.NewRecorder()
			handler(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
			}
			var resp map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &resp)
			got, ok := resp["has_more"].(bool)
			if !ok {
				t.Fatalf("expected has_more bool, got %T", resp["has_more"])
			}
			if got != tc.hasMore {
				t.Errorf("has_more: expected %v, got %v", tc.hasMore, got)
			}
		})
	}
}

// D113 drawer pagination: ``before`` keyset cursor threads from the
// query string into EventsParams.Before as an RFC3339-parsed time.
func TestGetEvents_Before_ThreadsToStore(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z&before=2026-02-01T00:00:00Z", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if s.lastEventsParams == nil {
		t.Fatal("mock did not receive params")
	}
	if s.lastEventsParams.Before.IsZero() {
		t.Fatal("expected Before to be parsed, got zero value")
	}
	if s.lastEventsParams.Before.Format(time.RFC3339) != "2026-02-01T00:00:00Z" {
		t.Errorf("expected Before=2026-02-01T00:00:00Z, got %v", s.lastEventsParams.Before)
	}
}

func TestGetEvents_InvalidBefore_Returns400(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z&before=not-a-date", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid before, got %d", w.Code)
	}
}

func TestGetEvents_OrderDesc_ThreadsToStore(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z&order=desc", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if s.lastEventsParams == nil {
		t.Fatal("mock did not receive params")
	}
	if s.lastEventsParams.Order != "desc" {
		t.Errorf("expected Order=desc, got %q", s.lastEventsParams.Order)
	}
}

func TestGetEvents_OrderDefault_IsEmptyString(t *testing.T) {
	// Default order is expressed as the empty string in EventsParams;
	// the store falls back to ASC when Order is not exactly "desc"
	// (case-insensitive). Guards against a handler regression that
	// would pre-populate Order with "asc" and inadvertently close the
	// door on case-insensitive fallbacks in the store.
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if s.lastEventsParams == nil {
		t.Fatal("mock did not receive params")
	}
	if s.lastEventsParams.Order != "" {
		t.Errorf("expected empty Order when unset, got %q", s.lastEventsParams.Order)
	}
}

func TestGetEvents_InvalidOrder_Returns400(t *testing.T) {
	s := &mockStore{}
	handler := handlers.EventsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/events?from=2026-01-01T00:00:00Z&order=sideways", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid order, got %d", w.Code)
	}
}

// --- Sessions List Tests ---

func TestSessionsListHandler_DefaultParams(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp store.SessionsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Total != 3 {
		t.Errorf("expected total=3, got %d", resp.Total)
	}
	if resp.Limit != 25 {
		t.Errorf("expected default limit=25, got %d", resp.Limit)
	}
	if resp.Offset != 0 {
		t.Errorf("expected default offset=0, got %d", resp.Offset)
	}
}

func TestSessionsListHandler_StateFilter(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions?state=active", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp store.SessionsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	for _, sess := range resp.Sessions {
		if sess.State != "active" {
			t.Errorf("expected all sessions to be active, got %s", sess.State)
		}
	}
}

func TestSessionsListHandler_InvalidState(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions?state=bogus", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid state, got %d", w.Code)
	}
}

func TestSessionsListHandler_InvalidSort(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions?sort=hacker", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid sort, got %d", w.Code)
	}
}

func TestSessionsListHandler_LimitExceedsMax(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions?limit=200", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for limit>100, got %d", w.Code)
	}
}

func TestSessionsListHandler_ErrorTypeFilter_MultiValue(t *testing.T) {
	// Phase 4: the error_type filter accepts multi-value (comma or
	// repeated) and forwards it to the store. The store's EXISTS
	// subquery is covered by integration tests; here we just prove
	// the handler parses and threads the list through.
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest(
		"GET",
		"/v1/sessions?error_type=rate_limit,context_overflow&error_type=timeout",
		nil,
	)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	p := s.lastSessionsParams
	if p == nil {
		t.Fatal("GetSessions not called")
	}
	assertStringSliceEqual(
		t, "error_type", p.ErrorTypes,
		[]string{"rate_limit", "context_overflow", "timeout"},
	)
}

func TestSessionsListHandler_MCPServerFilter_MultiValue(t *testing.T) {
	// Phase 5: ?mcp_server= forwards a comma-or-repeated list of names
	// to params.MCPServers. The store EXISTS subquery against
	// jsonb_array_elements(sessions.context->'mcp_servers') is covered
	// by integration tests; this case proves the handler parses and
	// threads the list through.
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest(
		"GET",
		"/v1/sessions?mcp_server=demo,filesystem&mcp_server=github",
		nil,
	)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	p := s.lastSessionsParams
	if p == nil {
		t.Fatal("GetSessions not called")
	}
	assertStringSliceEqual(
		t, "mcp_server", p.MCPServers,
		[]string{"demo", "filesystem", "github"},
	)
}

func TestSessionsListHandler_ClientTypeFilter_MultiValue(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest(
		"GET",
		"/v1/sessions?client_type=claude_code,flightdeck_sensor",
		nil,
	)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	p := s.lastSessionsParams
	if p == nil {
		t.Fatal("GetSessions not called")
	}
	assertStringSliceEqual(t, "client_type", p.ClientTypes, []string{"claude_code", "flightdeck_sensor"})
}

func TestSessionsListHandler_InvalidClientType(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions?client_type=cursor", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid client_type, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "claude_code") {
		t.Errorf("error should list allowed values; got %s", w.Body.String())
	}
}

func TestSessionsListHandler_AcceptsNewSortColumns(t *testing.T) {
	// last_seen_at, model, hostname join the original {started_at,
	// duration, tokens_used, flavor} allow-list. Any of them must
	// 200 through the handler.
	for _, sort := range []string{"last_seen_at", "model", "hostname"} {
		s := &mockStore{}
		handler := handlers.SessionsListHandler(store.WrapStore(s))
		req := httptest.NewRequest(
			"GET", "/v1/sessions?sort="+sort, nil,
		)
		w := httptest.NewRecorder()
		handler(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("sort=%s: expected 200, got %d body=%s",
				sort, w.Code, w.Body.String())
		}
		if s.lastSessionsParams == nil || s.lastSessionsParams.Sort != sort {
			t.Errorf("sort=%s: param not forwarded (%+v)",
				sort, s.lastSessionsParams)
		}
	}
}

func TestSessionsListHandler_QueryFilter(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions?q=research", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp store.SessionsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	for _, sess := range resp.Sessions {
		if !strings.Contains(strings.ToLower(sess.Flavor), "research") {
			t.Errorf("expected filtered flavor to contain 'research', got %s", sess.Flavor)
		}
	}
}

func TestSessionsListHandler_IncludesContext(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SessionsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/sessions", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp store.SessionsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Sessions) == 0 {
		t.Fatal("expected at least one session")
	}
	ctx := resp.Sessions[0].Context
	if ctx == nil {
		t.Fatal("expected non-nil context on first session")
	}
	if ctx["os"] != "Linux" {
		t.Errorf("expected context.os=Linux, got %v", ctx["os"])
	}
}

func TestSearchReturnsExtendedSessionFields(t *testing.T) {
	s := &mockStore{}
	handler := handlers.SearchHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/search?q=test", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp store.SearchResults
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Sessions) == 0 {
		t.Fatal("expected at least one session result")
	}
	sess := resp.Sessions[0]
	if sess.Model != "claude-sonnet-4-6" {
		t.Errorf("expected model=claude-sonnet-4-6, got %s", sess.Model)
	}
	if sess.TokensUsed != 3000 {
		t.Errorf("expected tokens_used=3000, got %d", sess.TokensUsed)
	}
	if sess.Context == nil {
		t.Fatal("expected non-nil context")
	}
	if sess.Context["os"] != "Linux" {
		t.Errorf("expected context.os=Linux, got %v", sess.Context["os"])
	}
}

// --- Token CRUD (D095) ---

func TestTokensListHandler_ReturnsRows(t *testing.T) {
	s := &mockStore{tokens: []store.AccessTokenRow{{ID: "a", Name: "Dev", Prefix: "ftd_aaaa"}}}
	handler := handlers.AccessTokensListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/tokens", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var out []store.AccessTokenRow
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].ID != "a" {
		t.Errorf("expected 1 row with id=a, got %+v", out)
	}
}

func TestTokenCreateHandler_ReturnsPlaintextOnce(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AccessTokenCreateHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/tokens",
		bytes.NewBufferString(`{"name":"Production K8s"}`))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}
	var out store.CreatedAccessTokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.RawToken == "" {
		t.Error("expected raw token in create response")
	}
	if out.Name != "Production K8s" {
		t.Errorf("expected name passthrough, got %q", out.Name)
	}
	// Subsequent list must NOT include the raw token field -- only
	// the projection. Json-decoding into AccessTokenRow (which has no
	// RawToken field) proves we get the safe shape back.
	listHandler := handlers.AccessTokensListHandler(store.WrapStore(s))
	listReq := httptest.NewRequest("GET", "/v1/tokens", nil)
	listW := httptest.NewRecorder()
	listHandler(listW, listReq)
	if !strings.Contains(listW.Body.String(), out.ID) {
		t.Error("expected new token id in subsequent list response")
	}
	if strings.Contains(listW.Body.String(), out.RawToken) {
		t.Errorf("list response must not leak raw token, body=%s", listW.Body.String())
	}
}

func TestTokenCreateHandler_EmptyName400(t *testing.T) {
	s := &mockStore{}
	handler := handlers.AccessTokenCreateHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/tokens", bytes.NewBufferString(`{"name":""}`))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestTokenDeleteHandler_DevTokenReturns403(t *testing.T) {
	s := &mockStore{tokens: []store.AccessTokenRow{{ID: "dev", Name: "Development Token"}}}
	mux := http.NewServeMux()
	mux.Handle("DELETE /v1/tokens/{id}", handlers.AccessTokenDeleteHandler(store.WrapStore(s)))
	req := httptest.NewRequest("DELETE", "/v1/tokens/dev", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Development Token") {
		t.Errorf("expected mention of Development Token in body, got %s", w.Body.String())
	}
}

func TestTokenDeleteHandler_UnknownIdReturns404(t *testing.T) {
	s := &mockStore{}
	mux := http.NewServeMux()
	mux.Handle("DELETE /v1/tokens/{id}", handlers.AccessTokenDeleteHandler(store.WrapStore(s)))
	req := httptest.NewRequest("DELETE", "/v1/tokens/missing", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestTokenDeleteHandler_DeletesRealToken(t *testing.T) {
	s := &mockStore{tokens: []store.AccessTokenRow{
		{ID: "real", Name: "Production"},
		{ID: "dev", Name: "Development Token"},
	}}
	mux := http.NewServeMux()
	mux.Handle("DELETE /v1/tokens/{id}", handlers.AccessTokenDeleteHandler(store.WrapStore(s)))
	req := httptest.NewRequest("DELETE", "/v1/tokens/real", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}
	if len(s.tokens) != 1 || s.tokens[0].ID != "dev" {
		t.Errorf("expected only dev token to remain, got %+v", s.tokens)
	}
}

func TestTokenRenameHandler_DevToken403(t *testing.T) {
	s := &mockStore{tokens: []store.AccessTokenRow{{ID: "dev", Name: "Development Token"}}}
	mux := http.NewServeMux()
	mux.Handle("PATCH /v1/tokens/{id}", handlers.AccessTokenRenameHandler(store.WrapStore(s)))
	req := httptest.NewRequest("PATCH", "/v1/tokens/dev", bytes.NewBufferString(`{"name":"Renamed"}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestTokenRenameHandler_RenamesRealToken(t *testing.T) {
	s := &mockStore{tokens: []store.AccessTokenRow{{ID: "real", Name: "Old"}}}
	mux := http.NewServeMux()
	mux.Handle("PATCH /v1/tokens/{id}", handlers.AccessTokenRenameHandler(store.WrapStore(s)))
	req := httptest.NewRequest("PATCH", "/v1/tokens/real", bytes.NewBufferString(`{"name":"New"}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var got store.AccessTokenRow
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Name != "New" {
		t.Errorf("expected name=New, got %q", got.Name)
	}
}

// --- DeleteCustomDirectivesHandler ---

func TestDeleteCustomDirectivesHandler_DeletesMatchingPrefix(t *testing.T) {
	s := &mockStore{customDirectives: []store.CustomDirective{
		{ID: "1", Name: "smoke_foo", Flavor: "f"},
		{ID: "2", Name: "smoke_bar", Flavor: "f"},
		{ID: "3", Name: "prod_keep", Flavor: "f"},
	}}
	handler := handlers.DeleteCustomDirectivesHandler(store.WrapStore(s))
	req := httptest.NewRequest("DELETE", "/v1/directives/custom?name_prefix=smoke_", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp handlers.DeleteCustomDirectivesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Deleted != 2 {
		t.Errorf("expected deleted=2, got %d", resp.Deleted)
	}
	if len(s.customDirectives) != 1 {
		t.Errorf("expected 1 remaining directive, got %d", len(s.customDirectives))
	}
}

func TestDeleteCustomDirectivesHandler_RequiresNamePrefix(t *testing.T) {
	handler := handlers.DeleteCustomDirectivesHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("DELETE", "/v1/directives/custom", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

// --- PolicyUpdateHandler branch coverage ---

func TestPolicyUpdateHandler_MissingID(t *testing.T) {
	handler := handlers.PolicyUpdateHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("PUT", "/v1/policies/", bytes.NewBufferString(`{}`))
	// No path value set -- handler reads r.PathValue("id") == "".
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestPolicyUpdateHandler_NotFound(t *testing.T) {
	handler := handlers.PolicyUpdateHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("PUT", "/v1/policies/missing", bytes.NewBufferString(
		`{"scope":"flavor","scope_value":"x","token_limit":100}`,
	))
	req.SetPathValue("id", "missing")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestPolicyUpdateHandler_InvalidJSON(t *testing.T) {
	limit := int64(100)
	s := &mockStore{policies: []store.Policy{{ID: "p", Scope: "flavor", ScopeValue: "x", TokenLimit: &limit}}}
	handler := handlers.PolicyUpdateHandler(store.WrapStore(s))
	req := httptest.NewRequest("PUT", "/v1/policies/p", bytes.NewBufferString(`{not-json`))
	req.SetPathValue("id", "p")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestPolicyUpdateHandler_InvalidRequest(t *testing.T) {
	limit := int64(100)
	s := &mockStore{policies: []store.Policy{{ID: "p", Scope: "flavor", ScopeValue: "x", TokenLimit: &limit}}}
	handler := handlers.PolicyUpdateHandler(store.WrapStore(s))
	body := `{"scope":"flavor","scope_value":"x","token_limit":100,"warn_at_pct":0}`
	req := httptest.NewRequest("PUT", "/v1/policies/p", bytes.NewBufferString(body))
	req.SetPathValue("id", "p")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

// --- PolicyDeleteHandler missing-id branch ---

func TestPolicyDeleteHandler_MissingID(t *testing.T) {
	handler := handlers.PolicyDeleteHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("DELETE", "/v1/policies/", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

// --- AgentsListHandler ---

func TestAgentsListHandler_200_DefaultParams(t *testing.T) {
	s := &mockStore{agentListResult: &store.AgentListResponse{
		Agents: []store.AgentSummary{
			{AgentID: "a1", AgentName: "alice"},
		},
		Total: 1, Limit: 25, Offset: 0, HasMore: false,
	}}
	h := handlers.AgentsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/agents", nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var got store.AgentListResponse
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Total != 1 || len(got.Agents) != 1 {
		t.Errorf("body: %+v", got)
	}
	// Defaults: limit=25, offset=0, sort=last_seen_at, order=desc.
	if s.lastAgentListParams == nil {
		t.Fatal("handler should have called ListAgents")
	}
	p := s.lastAgentListParams
	if p.Limit != 25 || p.Offset != 0 {
		t.Errorf("defaults: limit=%d offset=%d", p.Limit, p.Offset)
	}
	if p.Sort != "last_seen_at" || p.Order != "desc" {
		t.Errorf("defaults: sort=%q order=%q", p.Sort, p.Order)
	}
}

func TestAgentsListHandler_ParsesMultiValueFilters(t *testing.T) {
	s := &mockStore{}
	h := handlers.AgentsListHandler(store.WrapStore(s))
	// Comma-separated AND repeated — handler accepts both.
	req := httptest.NewRequest(
		"GET",
		"/v1/agents?agent_type=coding,production&state=active&state=idle&hostname=h1,h2",
		nil,
	)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	p := s.lastAgentListParams
	if p == nil {
		t.Fatal("ListAgents not called")
	}
	assertStringSliceEqual(t, "agent_type", p.AgentType, []string{"coding", "production"})
	assertStringSliceEqual(t, "state", p.State, []string{"active", "idle"})
	assertStringSliceEqual(t, "hostname", p.Hostname, []string{"h1", "h2"})
}

func TestAgentsListHandler_400_OnInvalidAgentType(t *testing.T) {
	h := handlers.AgentsListHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents?agent_type=autonomous", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "coding, production") {
		t.Errorf("error message should list allowed values; got %s", w.Body.String())
	}
}

func TestAgentsListHandler_400_OnInvalidClientType(t *testing.T) {
	h := handlers.AgentsListHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents?client_type=bogus", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestAgentsListHandler_400_OnInvalidState(t *testing.T) {
	h := handlers.AgentsListHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents?state=sleeping", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestAgentsListHandler_400_OnInvalidSort(t *testing.T) {
	h := handlers.AgentsListHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents?sort=agent_id", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "last_seen_at") {
		t.Errorf("error should list allowed sort columns; got %s", w.Body.String())
	}
}

func TestAgentsListHandler_400_OnLimitOver100(t *testing.T) {
	h := handlers.AgentsListHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents?limit=101", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "maximum of 100") {
		t.Errorf("error body: %s", w.Body.String())
	}
}

func TestAgentsListHandler_400_OnInvalidUpdatedSince(t *testing.T) {
	h := handlers.AgentsListHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents?updated_since=not-a-date", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestAgentsListHandler_IgnoresUnknownParams(t *testing.T) {
	// Future-compatibility: unknown params must not 400. The handler
	// simply never reads them; they pass through as no-ops.
	s := &mockStore{}
	h := handlers.AgentsListHandler(store.WrapStore(s))
	req := httptest.NewRequest(
		"GET",
		"/v1/agents?fleet_version=42&future_flag=true",
		nil,
	)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("unknown params should be silently ignored; got %d body=%s", w.Code, w.Body.String())
	}
}

func TestAgentsListHandler_500_OnStoreError(t *testing.T) {
	s := &mockStore{agentListErr: fmt.Errorf("pool exhausted")}
	h := handlers.AgentsListHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/agents", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "internal server error") {
		t.Errorf("should return generic 500 body; got %s", w.Body.String())
	}
}

func assertStringSliceEqual(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s: len mismatch — got %v want %v", label, got, want)
		return
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s[%d]: got %q want %q", label, i, got[i], want[i])
		}
	}
}

// --- AgentByIDHandler ---

func TestAgentByIDHandler_200_OnHit(t *testing.T) {
	id := "11111111-2222-3333-4444-555555555555"
	s := &mockStore{agentsByID: map[string]*store.AgentSummary{
		id: {
			AgentID:   id,
			AgentName: "alice",
			AgentType: "coding",
			UserName:  "u1",
			Hostname:  "h1",
			State:     "active",
		},
	}}
	h := handlers.AgentByIDHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/agents/"+id, nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var got store.AgentSummary
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.AgentID != id || got.AgentName != "alice" {
		t.Errorf("body: %+v", got)
	}
	if s.lastAgentByIDArg != id {
		t.Errorf("store arg: want %q, got %q", id, s.lastAgentByIDArg)
	}
}

func TestAgentByIDHandler_404_OnMiss(t *testing.T) {
	id := "11111111-2222-3333-4444-555555555555"
	// agentsByID is nil / no match — store returns (nil, nil).
	h := handlers.AgentByIDHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents/"+id, nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "agent not found") {
		t.Errorf("body: %s", w.Body.String())
	}
}

func TestAgentByIDHandler_400_OnInvalidUUID(t *testing.T) {
	h := handlers.AgentByIDHandler(store.WrapStore(&mockStore{}))
	req := httptest.NewRequest("GET", "/v1/agents/not-a-uuid", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestAgentByIDHandler_400_OnEmptyID(t *testing.T) {
	h := handlers.AgentByIDHandler(store.WrapStore(&mockStore{}))
	// Request the collection root via the by-id route; trailing slash
	// with no id should 400 rather than fan out to the list handler
	// (the mux differentiates /v1/agents vs /v1/agents/).
	req := httptest.NewRequest("GET", "/v1/agents/", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestAgentByIDHandler_500_OnStoreError(t *testing.T) {
	id := "11111111-2222-3333-4444-555555555555"
	s := &mockStore{agentByIDErr: fmt.Errorf("pool exhausted")}
	h := handlers.AgentByIDHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/agents/"+id, nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

// --- AdminReconcileAgentsHandler ---

func TestAdminReconcileHandler_200_OnCleanRun(t *testing.T) {
	s := &mockStore{reconcileResult: &store.ReconcileResult{
		AgentsScanned:   5,
		AgentsUpdated:   2,
		CountersUpdated: map[string]int{"total_sessions": 2, "total_tokens": 1},
		DurationMs:      42,
		Errors:          []string{},
	}}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var got store.ReconcileResult
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.AgentsScanned != 5 || got.AgentsUpdated != 2 {
		t.Errorf("body mismatch: %+v", got)
	}
	if got.CountersUpdated["total_sessions"] != 2 {
		t.Errorf("counters: %+v", got.CountersUpdated)
	}
}

func TestAdminReconcileHandler_207_OnPartialErrors(t *testing.T) {
	s := &mockStore{reconcileResult: &store.ReconcileResult{
		AgentsScanned:   5,
		AgentsUpdated:   3,
		CountersUpdated: map[string]int{"total_sessions": 3},
		DurationMs:      99,
		Errors: []string{
			"agent 00000000-0000-0000-0000-000000000001: tx begin: context canceled",
		},
	}}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusMultiStatus {
		t.Fatalf("expected 207, got %d", w.Code)
	}
	var got store.ReconcileResult
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Errors) != 1 {
		t.Errorf("expected 1 error in body, got %d", len(got.Errors))
	}
}

func TestAdminReconcileHandler_500_OnFatalError(t *testing.T) {
	s := &mockStore{reconcileErr: fmt.Errorf("list agents: pool timeout")}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
	// Body must not leak internal error details to the client. The
	// slog.Error line records the full string; the response body is
	// the generic "internal server error" used by every other 500
	// path in this package.
	if !strings.Contains(w.Body.String(), "internal server error") {
		t.Errorf("expected generic 500 body, got %s", w.Body.String())
	}
}

func TestAdminReconcileHandler_409_OnConcurrentInvocation(t *testing.T) {
	// Slow mock simulates a reconcile in progress. First request
	// acquires the handler's process-level mutex; second request
	// arrives while the lock is held and must return 409.
	started := make(chan struct{})
	release := make(chan struct{})
	s := &slowReconcileStore{
		started: started,
		release: release,
		result: &store.ReconcileResult{
			AgentsScanned:   1,
			AgentsUpdated:   0,
			CountersUpdated: map[string]int{},
			Errors:          []string{},
		},
	}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))

	firstDone := make(chan *httptest.ResponseRecorder)
	go func() {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil))
		firstDone <- w
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("first reconcile never started")
	}

	// Second call arrives while the first holds the lock.
	w2 := httptest.NewRecorder()
	h(w2, httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil))
	if w2.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d body=%s", w2.Code, w2.Body.String())
	}

	close(release)
	w1 := <-firstDone
	if w1.Code != http.StatusOK {
		t.Errorf("first call should return 200, got %d", w1.Code)
	}
}

// slowReconcileStore blocks ReconcileAgents until the test releases it
// so the concurrent-409 test can observe the mutex-held state.
type slowReconcileStore struct {
	mockStore
	started chan struct{}
	release chan struct{}
	result  *store.ReconcileResult
}

func (s *slowReconcileStore) ReconcileAgents(
	_ context.Context,
	_ time.Duration,
) (*store.ReconcileResult, error) {
	close(s.started)
	<-s.release
	return s.result, nil
}

// --- AdminReconcileAgentsHandler — orphan-delete threshold parsing ---

func TestAdminReconcileHandler_DefaultsOrphanThresholdTo30Days(t *testing.T) {
	s := &mockStore{}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if s.lastReconcileOrphanThreshold != store.DefaultOrphanDeleteThreshold {
		t.Errorf("default orphan threshold not applied: %v", s.lastReconcileOrphanThreshold)
	}
}

func TestAdminReconcileHandler_HonoursOrphanThresholdSecsOverride(t *testing.T) {
	s := &mockStore{}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents?orphan_threshold_secs=3600", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if s.lastReconcileOrphanThreshold != time.Hour {
		t.Errorf("threshold should be 1h, got %v", s.lastReconcileOrphanThreshold)
	}
}

func TestAdminReconcileHandler_OrphanThresholdZeroSkipsDelete(t *testing.T) {
	s := &mockStore{}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents?orphan_threshold_secs=0", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if s.lastReconcileOrphanThreshold != 0 {
		t.Errorf("0 should pass through verbatim (skip delete), got %v", s.lastReconcileOrphanThreshold)
	}
}

func TestAdminReconcileHandler_400_OnAbsurdlySmallOrphanThreshold(t *testing.T) {
	s := &mockStore{}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents?orphan_threshold_secs=10", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for orphan_threshold_secs<60, got %d", w.Code)
	}
}

func TestAdminReconcileHandler_400_OnMalformedOrphanThreshold(t *testing.T) {
	s := &mockStore{}
	h := handlers.AdminReconcileAgentsHandler(store.WrapStore(s))
	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents?orphan_threshold_secs=oops", nil)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
