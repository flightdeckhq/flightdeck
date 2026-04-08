package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
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
	policies   []store.Policy
	directives []store.Directive
}

func (m *mockStore) GetFleet(_ context.Context, limit, offset int) ([]store.FlavorSummary, int, error) {
	flavors := []store.FlavorSummary{
		{
			Flavor:          "research-agent",
			AgentType:       "autonomous",
			SessionCount:    2,
			ActiveCount:     1,
			TokensUsedTotal: 5000,
			Sessions: []store.Session{
				{SessionID: "s1", Flavor: "research-agent", State: "active", StartedAt: time.Now(), LastSeenAt: time.Now(), TokensUsed: 3000},
				{SessionID: "s2", Flavor: "research-agent", State: "closed", StartedAt: time.Now(), LastSeenAt: time.Now(), TokensUsed: 2000},
			},
		},
	}
	return flavors, 2, nil
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

func (m *mockStore) GetSessionEvents(_ context.Context, _ string) ([]store.Event, error) {
	return []store.Event{
		{ID: "e1", EventType: "session_start", OccurredAt: time.Now().Add(-time.Minute)},
		{ID: "e2", EventType: "post_call", OccurredAt: time.Now()},
	}, nil
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

func (m *mockStore) CreateDirective(_ context.Context, d store.Directive) (*store.Directive, error) {
	d.ID = "dir-new-id"
	d.IssuedBy = "dashboard"
	d.IssuedAt = time.Now()
	m.directives = append(m.directives, d)
	return &d, nil
}

func (m *mockStore) GetActiveSessionIDsByFlavor(_ context.Context, flavor string) ([]string, error) {
	var ids []string
	for _, f := range []store.FlavorSummary{
		{Flavor: "research-agent", Sessions: []store.Session{
			{SessionID: "s1", State: "active"},
			{SessionID: "s2", State: "closed"},
		}},
	} {
		if f.Flavor == flavor {
			for _, s := range f.Sessions {
				if s.State == "active" || s.State == "idle" {
					ids = append(ids, s.SessionID)
				}
			}
		}
	}
	return ids, nil
}

func (m *mockStore) Search(_ context.Context, query string) (*store.SearchResults, error) {
	if query == "no-match" {
		return &store.SearchResults{
			Agents: []store.SearchResultAgent{}, Sessions: []store.SearchResultSession{}, Events: []store.SearchResultEvent{},
		}, nil
	}
	return &store.SearchResults{
		Agents:   []store.SearchResultAgent{{Flavor: "test-agent", AgentType: "autonomous", LastSeen: "2026-04-08"}},
		Sessions: []store.SearchResultSession{{SessionID: "s1", Flavor: "test-agent", Host: "host-1", State: "active", StartedAt: "2026-04-08"}},
		Events:   []store.SearchResultEvent{{EventID: "e1", SessionID: "s1", EventType: "post_call", ToolName: "search", Model: "claude", OccurredAt: "2026-04-08"}},
	}, nil
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

func TestFleetHandler_ReturnsSessionsGroupedByFlavor(t *testing.T) {
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
	flavors, ok := resp["flavors"].([]any)
	if !ok || len(flavors) != 1 {
		t.Errorf("expected 1 flavor group, got %v", resp["flavors"])
	}
}

func TestFleetHandler_ExcludesLostSessions(t *testing.T) {
	// The mock store doesn't return lost sessions (by design matching the real store)
	s := &mockStore{}
	handler := handlers.FleetHandler(store.WrapStore(s))
	req := httptest.NewRequest("GET", "/v1/fleet", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	flavors := resp["flavors"].([]any)
	for _, f := range flavors {
		fm := f.(map[string]any)
		sessions := fm["sessions"].([]any)
		for _, s := range sessions {
			sm := s.(map[string]any)
			if sm["state"] == "lost" {
				t.Error("lost session should be excluded from fleet response")
			}
		}
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

func TestStreamHandler_ReceivesBroadcast(t *testing.T) {
	hub := ws.NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/stream", handlers.StreamHandler(hub))
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
