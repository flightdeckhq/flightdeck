// Handler tests for ListMCPPolicyAuditLogHandler. The handler powers
// both /v1/mcp-policies/{flavor}/audit-log and /v1/mcp-policies/global/audit-log;
// scopeAndValueFromPath maps the literal "global" segment to scope="global"
// with empty scope_value, everything else to scope="flavor".
//
// 403 path is structurally absent: the adminGate middleware that
// produces it is wired in server.go and not invoked when handlers
// are exercised directly via httptest. Auth-edge coverage lives in
// auth/token_test.go.

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

type auditLogStubQuerier struct {
	store.Querier
	listLog func(context.Context, string, string, string, *time.Time, *time.Time, int, int) ([]store.MCPPolicyAuditLog, error)
}

func (q *auditLogStubQuerier) ListMCPPolicyAuditLog(ctx context.Context, scope, scopeValue, eventType string, from, to *time.Time, limit, offset int) ([]store.MCPPolicyAuditLog, error) {
	return q.listLog(ctx, scope, scopeValue, eventType, from, to, limit, offset)
}

func TestListAuditLogHandlerFlavorHappyPath(t *testing.T) {
	q := &auditLogStubQuerier{
		listLog: func(_ context.Context, scope, scopeValue, eventType string, from, to *time.Time, limit, offset int) ([]store.MCPPolicyAuditLog, error) {
			if scope != "flavor" || scopeValue != "production" {
				t.Errorf("scope/value = %q/%q, want flavor/production", scope, scopeValue)
			}
			if eventType != "" {
				t.Errorf("event_type = %q, want empty (no filter)", eventType)
			}
			if from != nil || to != nil {
				t.Errorf("from/to = %v/%v, want nil/nil", from, to)
			}
			if limit != 50 || offset != 0 {
				t.Errorf("limit/offset = %d/%d, want 50/0 (defaults)", limit, offset)
			}
			return []store.MCPPolicyAuditLog{
				{ID: "log1", EventType: "policy_create", OccurredAt: time.Now()},
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body []store.MCPPolicyAuditLog
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body) != 1 || body[0].ID != "log1" {
		t.Errorf("body = %+v, want one row with ID=log1", body)
	}
}

func TestListAuditLogHandlerGlobalScopeRouting(t *testing.T) {
	q := &auditLogStubQuerier{
		listLog: func(_ context.Context, scope, scopeValue, _ string, _, _ *time.Time, _, _ int) ([]store.MCPPolicyAuditLog, error) {
			if scope != "global" || scopeValue != "" {
				t.Errorf("scope/value = %q/%q, want global/\"\"", scope, scopeValue)
			}
			return []store.MCPPolicyAuditLog{}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/global/audit-log", nil)
	req.SetPathValue("flavor", "global")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestListAuditLogHandlerEventTypeFilter(t *testing.T) {
	q := &auditLogStubQuerier{
		listLog: func(_ context.Context, _, _, eventType string, _, _ *time.Time, _, _ int) ([]store.MCPPolicyAuditLog, error) {
			if eventType != "policy_update" {
				t.Errorf("event_type = %q, want policy_update", eventType)
			}
			return nil, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log?event_type=policy_update", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestListAuditLogHandlerInvalidFromTime(t *testing.T) {
	q := &auditLogStubQuerier{} // listLog never called
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log?from=not-a-timestamp", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "from must be RFC 3339") {
		t.Errorf("body should explain RFC 3339 requirement; got %s", rec.Body.String())
	}
}

func TestListAuditLogHandlerInvalidToTime(t *testing.T) {
	q := &auditLogStubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log?to=2026-13-99", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "to must be RFC 3339") {
		t.Errorf("body should explain RFC 3339 requirement; got %s", rec.Body.String())
	}
}

func TestListAuditLogHandlerLimitTooHigh(t *testing.T) {
	q := &auditLogStubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log?limit=201", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "limit must be 1..200") {
		t.Errorf("body should explain limit bounds; got %s", rec.Body.String())
	}
}

func TestListAuditLogHandlerNegativeOffset(t *testing.T) {
	q := &auditLogStubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log?offset=-1", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	// JSON encoder HTML-escapes the > sign; assert against the
	// resilient prefix so a future encoder swap doesn't break this.
	if !strings.Contains(rec.Body.String(), "offset must be") {
		t.Errorf("body should explain offset bound; got %s", rec.Body.String())
	}
}

func TestListAuditLogHandlerStoreError(t *testing.T) {
	q := &auditLogStubQuerier{
		listLog: func(_ context.Context, _, _, _ string, _, _ *time.Time, _, _ int) ([]store.MCPPolicyAuditLog, error) {
			return nil, errors.New("database is unavailable")
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}
