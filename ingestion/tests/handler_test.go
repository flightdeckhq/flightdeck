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

type mockValidator struct{ valid bool }

func (m *mockValidator) Validate(_ context.Context, _ string) (bool, error) {
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
	)
	body := `{"session_id":"abc-123"}`
	req := httptest.NewRequest("POST", "/v1/heartbeat", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}
