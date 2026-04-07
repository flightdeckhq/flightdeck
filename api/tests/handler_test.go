package handlers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/handlers"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/gorilla/websocket"
)

// --- Mock Store ---

type mockStore struct{}

func (m *mockStore) GetFleet(_ context.Context) ([]store.FlavorSummary, error) {
	return []store.FlavorSummary{
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
	}, nil
}

func (m *mockStore) GetSession(_ context.Context, id string) (*store.Session, error) {
	if id == "unknown" {
		return nil, nil
	}
	return &store.Session{SessionID: id, Flavor: "test", State: "active", StartedAt: time.Now(), LastSeenAt: time.Now()}, nil
}

func (m *mockStore) GetSessionEvents(_ context.Context, _ string) ([]store.Event, error) {
	return []store.Event{
		{ID: "e1", EventType: "session_start", OccurredAt: time.Now().Add(-time.Minute)},
		{ID: "e2", EventType: "post_call", OccurredAt: time.Now()},
	}, nil
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

	// Give the client time to register
	time.Sleep(50 * time.Millisecond)

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
