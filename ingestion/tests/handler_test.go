package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
)

// --- Mocks ---

type mockValidator struct {
	valid    bool
	callCount int
}

func (m *mockValidator) Validate(_ context.Context, _ string) (bool, error) {
	m.callCount++
	return m.valid, nil
}

type mockPublisher struct{ published [][]byte }

func (m *mockPublisher) Publish(_ string, data []byte) error {
	m.published = append(m.published, data)
	return nil
}

type mockDirStore struct{ directive *handlers.DirectiveResponse }

func (m *mockDirStore) LookupPending(_ context.Context, _ string) (*handlers.DirectiveResponse, error) {
	return m.directive, nil
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
	if body["service"] != "ingestion" {
		t.Errorf("expected service=ingestion, got %s", body["service"])
	}
}

func TestEventsHandler_MissingAuth_Returns401(t *testing.T) {
	handler := handlers.EventsHandler(
		&mockValidator{valid: false},
		&mockPublisher{},
		&mockDirStore{},
		nil,
	)
	body := `{"session_id":"abc","event_type":"post_call"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestEventsHandler_InvalidToken_Returns401(t *testing.T) {
	handler := handlers.EventsHandler(
		&mockValidator{valid: false},
		&mockPublisher{},
		&mockDirStore{},
		nil,
	)
	body := `{"session_id":"abc","event_type":"post_call"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer bad-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestEventsHandler_MalformedPayload_Returns400(t *testing.T) {
	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{},
		nil,
	)
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString("not json"))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestEventsHandler_ValidToken_Returns200WithNullDirective(t *testing.T) {
	pub := &mockPublisher{}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		pub,
		&mockDirStore{directive: nil},
		nil,
	)
	body := `{"session_id":"abc-123","event_type":"post_call","flavor":"test"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "ok" {
		t.Errorf("expected status=ok, got %v", resp["status"])
	}
	if resp["directive"] != nil {
		t.Errorf("expected nil directive, got %v", resp["directive"])
	}
	if len(pub.published) != 1 {
		t.Errorf("expected 1 NATS publish, got %d", len(pub.published))
	}
}

func TestEventsHandler_PendingDirective_Returns200WithDirective(t *testing.T) {
	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{directive: &handlers.DirectiveResponse{
			Action: "shutdown", Reason: "kill", GracePeriodMs: 5000,
		}},
		nil,
	)
	body := `{"session_id":"abc-123","event_type":"post_call","flavor":"test"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["directive"] == nil {
		t.Error("expected directive in response, got nil")
	}
}

func TestHeartbeatHandler_ValidToken_Returns200(t *testing.T) {
	handler := handlers.HeartbeatHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{directive: nil},
	)
	body := `{"session_id":"abc-123"}`
	req := httptest.NewRequest("POST", "/v1/heartbeat", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "ok" {
		t.Errorf("expected status=ok, got %v", resp["status"])
	}
	if resp["directive"] != nil {
		t.Errorf("expected nil directive, got %v", resp["directive"])
	}
}

func TestHeartbeatHandler_PendingDirective_ReturnsDirective(t *testing.T) {
	handler := handlers.HeartbeatHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{directive: &handlers.DirectiveResponse{
			Action: "shutdown", Reason: "kill", GracePeriodMs: 5000,
		}},
	)
	body := `{"session_id":"abc-123"}`
	req := httptest.NewRequest("POST", "/v1/heartbeat", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["directive"] == nil {
		t.Error("expected directive in response, got nil")
	}
}

// --- Rate Limiter Tests ---

func TestRateLimitAllowsUnderLimit(t *testing.T) {
	limiter := handlers.NewRateLimiter(handlers.DefaultRateLimitPerMinute)
	defer limiter.Close()

	for i := range 999 {
		allowed, _ := limiter.Allow("tok-hash")
		if !allowed {
			t.Fatalf("request %d should be allowed under limit", i+1)
		}
	}
}

func TestRateLimitBlocksOverLimit(t *testing.T) {
	limiter := handlers.NewRateLimiter(handlers.DefaultRateLimitPerMinute)
	defer limiter.Close()

	for range 1000 {
		limiter.Allow("tok-hash")
	}

	allowed, retryAfter := limiter.Allow("tok-hash")
	if allowed {
		t.Error("request 1001 should be blocked")
	}
	if retryAfter < 1 {
		t.Errorf("expected positive Retry-After, got %d", retryAfter)
	}
}

func TestRateLimitReturns429ViaHandler(t *testing.T) {
	limiter := handlers.NewRateLimiter(handlers.DefaultRateLimitPerMinute)
	defer limiter.Close()

	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{directive: nil},
		limiter,
	)

	// Exhaust the rate limit
	for range 1000 {
		body := `{"session_id":"abc","event_type":"post_call","flavor":"test"}`
		req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer tok")
		w := httptest.NewRecorder()
		handler(w, req)
	}

	// The 1001st request should return 429
	body := `{"session_id":"abc","event_type":"post_call","flavor":"test"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("expected Retry-After header")
	}
}

// FIX 1 -- the per-token cap is configurable. The dev compose
// override sets it high so the integration suite never hits 429.
func TestRateLimitConfigurableCapHonored(t *testing.T) {
	limiter := handlers.NewRateLimiter(5)
	defer limiter.Close()

	for range 5 {
		allowed, _ := limiter.Allow("tok-hash")
		if !allowed {
			t.Fatal("requests under custom cap should be allowed")
		}
	}
	allowed, _ := limiter.Allow("tok-hash")
	if allowed {
		t.Error("request over custom cap should be blocked")
	}
}

// FIX 1 -- a misconfigured FLIGHTDECK_RATE_LIMIT_PER_MINUTE (zero or
// negative) must NOT silently disable the limiter. NewRateLimiter
// falls back to DefaultRateLimitPerMinute so production cannot end
// up unlimited by accident.
func TestRateLimitNonPositiveCapFallsBackToDefault(t *testing.T) {
	for _, max := range []int{0, -1, -1000} {
		limiter := handlers.NewRateLimiter(max)
		// Allow exactly DefaultRateLimitPerMinute requests, then
		// expect the next one to fail.
		for range handlers.DefaultRateLimitPerMinute {
			allowed, _ := limiter.Allow("tok-hash")
			if !allowed {
				limiter.Close()
				t.Fatalf("max=%d: request should have been allowed under default cap", max)
			}
		}
		allowed, _ := limiter.Allow("tok-hash")
		if allowed {
			limiter.Close()
			t.Errorf("max=%d: request beyond default cap should have been blocked", max)
		}
		limiter.Close()
	}
}
