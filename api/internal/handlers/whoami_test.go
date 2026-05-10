// Whoami handler tests. Uses auth.ContextWithValidationResult to
// inject a synthetic ValidationResult — the full Middleware → 401-on-
// missing-bearer path is covered by auth/token_test.go.

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
)

func TestWhoamiHandlerAdmin(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/whoami", nil)
	req = req.WithContext(auth.ContextWithValidationResult(req.Context(), auth.ValidationResult{
		Valid:   true,
		ID:      "11111111-2222-3333-4444-555555555555",
		Name:    "Admin (env)",
		IsAdmin: true,
	}))
	rec := httptest.NewRecorder()
	WhoamiHandler()(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got WhoamiResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Role != "admin" {
		t.Errorf("role = %q, want admin", got.Role)
	}
	if got.TokenID != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("token_id = %q, want the injected uuid", got.TokenID)
	}
}

func TestWhoamiHandlerViewer(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/whoami", nil)
	req = req.WithContext(auth.ContextWithValidationResult(req.Context(), auth.ValidationResult{
		Valid:   true,
		ID:      "abcdef01-2345-6789-abcd-ef0123456789",
		Name:    "Development Token",
		IsAdmin: false,
	}))
	rec := httptest.NewRecorder()
	WhoamiHandler()(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got WhoamiResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Role != "viewer" {
		t.Errorf("role = %q, want viewer", got.Role)
	}
	if got.TokenID != "abcdef01-2345-6789-abcd-ef0123456789" {
		t.Errorf("token_id = %q, want the injected uuid", got.TokenID)
	}
}

func TestWhoamiHandlerMissingContext(t *testing.T) {
	// Caller bypassed gate() — handler returns 500 with a clear
	// message rather than silently emitting an empty response.
	req := httptest.NewRequest(http.MethodGet, "/v1/whoami", nil)
	rec := httptest.NewRecorder()
	WhoamiHandler()(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 for missing context", rec.Code)
	}
}
