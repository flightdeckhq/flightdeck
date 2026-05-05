package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
)

// --- Mocks ---

type mockValidator struct {
	valid     bool
	id        string
	name      string
	reason    string
	callCount int
}

func (m *mockValidator) Validate(_ context.Context, _ string) (auth.ValidationResult, error) {
	m.callCount++
	return auth.ValidationResult{
		Valid:  m.valid,
		ID:     m.id,
		Name:   m.name,
		Reason: m.reason,
	}, nil
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

// mockSessAttacher satisfies handlers.SessionAttacher. attached and
// priorState drive the fake response; err simulates DB failure so the
// handler's fallback path (attached=false, no panic) can be asserted.
type mockSessAttacher struct {
	attached   bool
	priorState string
	err        error
	called     []string
}

func (m *mockSessAttacher) Attach(_ context.Context, sessionID string) (bool, string, error) {
	m.called = append(m.called, sessionID)
	return m.attached, m.priorState, m.err
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
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
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
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
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

// D115 / D116: agent identity validation at the wire boundary. Each
// sub-case exercises one invariant. The stack never reaches NATS on
// any of these -- the handler returns 400 before the publish path.
func TestEventsHandler_AgentIdentityValidation(t *testing.T) {
	const validAgentID = "11111111-1111-4111-8111-111111111111"
	cases := []struct {
		name string
		body string
	}{
		{
			name: "missing_agent_id",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_type":"coding","client_type":"claude_code"}`,
		},
		{
			name: "malformed_agent_id",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"not-a-uuid","agent_type":"coding","client_type":"claude_code"}`,
		},
		{
			name: "invalid_agent_type",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"autonomous","client_type":"flightdeck_sensor"}`,
		},
		{
			name: "invalid_client_type",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"rogue"}`,
		},
		// Phase 4 additions (V-pass D7, D8, D10, D15):
		{
			name: "malformed_session_id",
			body: `{"session_id":"not-a-uuid","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code"}`,
		},
		{
			// 2020 timestamp is far older than the 48h maxClockSkewPast
			// bound; ingestion must reject. The E2E ``aged-closed``
			// fixture at 28h old still passes because it's inside the
			// 48h window.
			name: "timestamp_too_far_past",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","timestamp":"2020-01-01T00:00:00Z"}`,
		},
		{
			name: "timestamp_too_far_future",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","timestamp":"2100-01-01T00:00:00Z"}`,
		},
		{
			name: "malformed_timestamp",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","timestamp":"nope"}`,
		},
		{
			name: "negative_tokens_input",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","tokens_input":-5}`,
		},
		{
			name: "negative_tokens_total",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","tokens_total":-1}`,
		},
		// D126 — sub-agent identity validation. parent_session_id
		// (when present) is canonical UUID; agent_role (when present)
		// is a non-empty string ≤ 256 chars. Both are optional, so
		// "absent" is not in this rejection table — only malformed
		// values are.
		{
			name: "malformed_parent_session_id",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"session_start","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","parent_session_id":"not-a-uuid"}`,
		},
		{
			name: "non_string_parent_session_id",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"session_start","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","parent_session_id":42}`,
		},
		{
			name: "non_string_agent_role",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"session_start","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","agent_role":42}`,
		},
		{
			// 257-char string — one over the limit.
			name: "agent_role_too_long",
			body: `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"session_start","agent_id":"` + validAgentID + `","agent_type":"coding","client_type":"claude_code","agent_role":"` + strings.Repeat("x", 257) + `"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := handlers.EventsHandler(
				&mockValidator{valid: true},
				&mockPublisher{},
				&mockDirStore{},
				nil,
				nil,
			)
			req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(tc.body))
			req.Header.Set("Authorization", "Bearer valid-token")
			w := httptest.NewRecorder()
			handler(w, req)
			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d (body=%s)", w.Code, w.Body.String())
			}
		})
	}
}

func TestEventsHandler_ValidToken_Returns200WithNullDirective(t *testing.T) {
	pub := &mockPublisher{}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		pub,
		&mockDirStore{directive: nil},
		nil,
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
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
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
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
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
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
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
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
		nil,
		limiter,
	)

	// Exhaust the rate limit
	for range 1000 {
		body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
		req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer tok")
		w := httptest.NewRecorder()
		handler(w, req)
	}

	// The 1001st request should return 429
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
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

// --- D094: session attachment tests ---

// Brand-new session_id → attacher returns attached=false, handler
// passes that through to the envelope unchanged.
func TestEventsHandler_SessionStart_NewSession_AttachedFalse(t *testing.T) {
	attacher := &mockSessAttacher{attached: false}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{directive: nil},
		attacher,
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"session_start","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if attached, _ := resp["attached"].(bool); attached {
		t.Errorf("expected attached=false for new session, got %v", resp["attached"])
	}
	if len(attacher.called) != 1 || attacher.called[0] != "22222222-2222-4222-8222-222222222222" {
		t.Errorf("expected one Attach call for the canonical UUID, got %v", attacher.called)
	}
}

// Pre-existing session_id in any live/terminal state → attacher
// returns attached=true, handler surfaces it.
func TestEventsHandler_SessionStart_ExistingSession_AttachedTrue(t *testing.T) {
	attacher := &mockSessAttacher{attached: true, priorState: "closed"}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{directive: nil},
		attacher,
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"session_start","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if attached, _ := resp["attached"].(bool); !attached {
		t.Errorf("expected attached=true for existing session, got %v", resp["attached"])
	}
}

// D095: ingestion injects the resolved token id+name into the NATS
// payload for session_start events so workers can persist them onto
// the session row. Other event types are passed through untouched.
func TestEventsHandler_SessionStart_InjectsTokenIDAndName(t *testing.T) {
	pub := &mockPublisher{}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true, id: "tok-uuid-1", name: "Production K8s"},
		pub,
		&mockDirStore{directive: nil},
		&mockSessAttacher{attached: false},
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"session_start","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer ftd_whatever")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 publish, got %d", len(pub.published))
	}
	var published map[string]any
	if err := json.Unmarshal(pub.published[0], &published); err != nil {
		t.Fatalf("decode published payload: %v", err)
	}
	if got, _ := published["token_id"].(string); got != "tok-uuid-1" {
		t.Errorf("expected token_id=tok-uuid-1 in published payload, got %v", published["token_id"])
	}
	if got, _ := published["token_name"].(string); got != "Production K8s" {
		t.Errorf("expected token_name='Production K8s' in published payload, got %v", published["token_name"])
	}
}

// D095: post_call (and any non-session_start event) must NOT carry
// token_id / token_name in the published payload -- the worker
// deliberately ignores those fields outside HandleSessionStart and
// stamping them on every event would waste bandwidth on the hot path.
func TestEventsHandler_NonSessionStart_OmitsTokenFields(t *testing.T) {
	pub := &mockPublisher{}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true, id: "tok-uuid-1", name: "Production K8s"},
		pub,
		&mockDirStore{directive: nil},
		nil,
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer ftd_whatever")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var published map[string]any
	_ = json.Unmarshal(pub.published[0], &published)
	if _, ok := published["token_id"]; ok {
		t.Errorf("post_call must not carry token_id, got %v", published["token_id"])
	}
	if _, ok := published["token_name"]; ok {
		t.Errorf("post_call must not carry token_name, got %v", published["token_name"])
	}
}

// D095: when the validator surfaces a Reason (e.g. tok_dev rejected
// outside dev mode), the handler must put that reason verbatim in
// the 401 body so operators see the actionable message.
func TestEventsHandler_RejectionReasonSurfacedIn401(t *testing.T) {
	const reason = "tok_dev is only valid in development mode. Create a production token in the Settings page."
	handler := handlers.EventsHandler(
		&mockValidator{valid: false, reason: reason},
		&mockPublisher{},
		&mockDirStore{},
		nil,
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer tok_dev")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != reason {
		t.Errorf("expected error=%q, got %q", reason, resp["error"])
	}
}

// Non-session_start events must never consult the attacher and must
// report attached=false (D094: only session_start responses carry
// attached=true).
func TestEventsHandler_NonSessionStart_DoesNotAttach(t *testing.T) {
	attacher := &mockSessAttacher{attached: true}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true},
		&mockPublisher{},
		&mockDirStore{directive: nil},
		attacher,
		nil,
	)
	body := `{"session_id":"22222222-2222-4222-8222-222222222222","event_type":"post_call","flavor":"test","agent_id":"11111111-1111-4111-8111-111111111111","agent_type":"coding","client_type":"claude_code"}`
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer valid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if attached, _ := resp["attached"].(bool); attached {
		t.Errorf("post_call must return attached=false, got %v", resp["attached"])
	}
	if len(attacher.called) != 0 {
		t.Errorf("attacher must not be called for non-session_start events, got %v", attacher.called)
	}
}
