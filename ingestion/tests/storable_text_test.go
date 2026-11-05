package handlers_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
)

// esc is the JSON escape of a UTF-16 code unit, built at run time so
// the escape stays text in this file.
func esc(hex string) string { return "\\" + "u" + hex }

// A U+0000 or an unpaired surrogate in an event is valid JSON that
// Postgres cannot store, so the worker would fail the event on every
// redelivery: ingestion publishes it with each replaced by U+FFFD
// rather than refusing it, keeping the event's tokens.
func TestEventsHandler_ReplacesTextPostgresCannotStore(t *testing.T) {
	pub := &mockPublisher{}
	handler := handlers.EventsHandler(&mockValidator{valid: true}, pub, &mockDirStore{}, nil, nil)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","flavor":"test",` +
		`"agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code",` +
		`"tokens_input":10,"tokens_output":2,"tokens_total":12,"has_content":true,` +
		`"content":{"provider":"anthropic","model":"m","system":"sys` + esc("0000") + `",` +
		`"messages":[{"role":"user","content":"a` + esc("0000") + `b ` + esc("d800") + `"}],"response":{}}}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusOK || len(pub.published) != 1 {
		t.Fatalf("status %d, %d published: %s", w.Code, len(pub.published), w.Body.String())
	}
	got := string(pub.published[0])
	if strings.Contains(got, esc("0000")) || strings.Contains(got, esc("d800")) {
		t.Errorf("published text Postgres cannot store: %s", got)
	}
	if strings.Count(got, esc("fffd")) != 3 || !strings.Contains(got, `"tokens_total":12`) {
		t.Errorf("published %s", got)
	}
}
