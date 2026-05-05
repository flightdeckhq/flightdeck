// Handler-level tests for MCP Protection Policy version-history +
// audit-log endpoints. Each test installs the behaviour it needs on
// versionsStubQuerier; no DB.

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

type versionsStubQuerier struct {
	store.Querier
	listVersions  func(context.Context, string, string, int, int) ([]store.MCPPolicyVersionMeta, error)
	getVersion    func(context.Context, string, string, int) (*store.MCPPolicyVersion, error)
	diffVersions  func(context.Context, string, string, int, int) (*store.MCPPolicyDiff, error)
	listAuditLog  func(context.Context, string, string, string, *time.Time, *time.Time, int, int) ([]store.MCPPolicyAuditLog, error)
}

func (q *versionsStubQuerier) ListMCPPolicyVersions(ctx context.Context, scope, scopeValue string, limit, offset int) ([]store.MCPPolicyVersionMeta, error) {
	return q.listVersions(ctx, scope, scopeValue, limit, offset)
}
func (q *versionsStubQuerier) GetMCPPolicyVersion(ctx context.Context, scope, scopeValue string, version int) (*store.MCPPolicyVersion, error) {
	return q.getVersion(ctx, scope, scopeValue, version)
}
func (q *versionsStubQuerier) DiffMCPPolicyVersions(ctx context.Context, scope, scopeValue string, fromVersion, toVersion int) (*store.MCPPolicyDiff, error) {
	return q.diffVersions(ctx, scope, scopeValue, fromVersion, toVersion)
}
func (q *versionsStubQuerier) ListMCPPolicyAuditLog(ctx context.Context, scope, scopeValue, eventType string, from, to *time.Time, limit, offset int) ([]store.MCPPolicyAuditLog, error) {
	return q.listAuditLog(ctx, scope, scopeValue, eventType, from, to, limit, offset)
}

func TestListVersionsHandlerSuccess(t *testing.T) {
	q := &versionsStubQuerier{
		listVersions: func(_ context.Context, scope, value string, limit, _ int) ([]store.MCPPolicyVersionMeta, error) {
			if scope != "flavor" || value != "production" {
				t.Errorf("scope/value = %q/%q", scope, value)
			}
			if limit != 50 {
				t.Errorf("default limit = %d, want 50", limit)
			}
			return []store.MCPPolicyVersionMeta{
				{ID: "v1", PolicyID: "p", Version: 1, CreatedAt: time.Now()},
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/versions", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyVersionsHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestListVersionsHandlerGlobalRoute(t *testing.T) {
	q := &versionsStubQuerier{
		listVersions: func(_ context.Context, scope, value string, _, _ int) ([]store.MCPPolicyVersionMeta, error) {
			if scope != "global" || value != "" {
				t.Errorf("scope=%q value=%q", scope, value)
			}
			return []store.MCPPolicyVersionMeta{}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/global/versions", nil)
	req.SetPathValue("flavor", "global")
	rec := httptest.NewRecorder()
	ListMCPPolicyVersionsHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestListVersionsHandlerRejectsBadLimit(t *testing.T) {
	q := &versionsStubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/versions?limit=99999", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyVersionsHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestGetVersionHandlerNotFound(t *testing.T) {
	q := &versionsStubQuerier{
		getVersion: func(_ context.Context, _, _ string, _ int) (*store.MCPPolicyVersion, error) {
			return nil, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/versions/9", nil)
	req.SetPathValue("flavor", "production")
	req.SetPathValue("version", "9")
	rec := httptest.NewRecorder()
	GetMCPPolicyVersionHandler(q)(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestGetVersionHandlerBadInteger(t *testing.T) {
	q := &versionsStubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/versions/abc", nil)
	req.SetPathValue("flavor", "production")
	req.SetPathValue("version", "abc")
	rec := httptest.NewRecorder()
	GetMCPPolicyVersionHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestGetVersionHandlerSuccess(t *testing.T) {
	q := &versionsStubQuerier{
		getVersion: func(_ context.Context, _, _ string, version int) (*store.MCPPolicyVersion, error) {
			if version != 3 {
				t.Errorf("version = %d, want 3", version)
			}
			return &store.MCPPolicyVersion{
				ID:       "v3",
				PolicyID: "p",
				Version:  3,
				Snapshot: json.RawMessage(`{"version":3}`),
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/versions/3", nil)
	req.SetPathValue("flavor", "production")
	req.SetPathValue("version", "3")
	rec := httptest.NewRecorder()
	GetMCPPolicyVersionHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestDiffVersionsHandlerRequiresParams(t *testing.T) {
	q := &versionsStubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/diff", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	DiffMCPPolicyVersionsHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestDiffVersionsHandlerNotFound(t *testing.T) {
	q := &versionsStubQuerier{
		diffVersions: func(_ context.Context, _, _ string, _, _ int) (*store.MCPPolicyDiff, error) {
			return nil, store.ErrMCPPolicyNotFound
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/diff?from=1&to=2", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	DiffMCPPolicyVersionsHandler(q)(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestDiffVersionsHandlerSuccess(t *testing.T) {
	q := &versionsStubQuerier{
		diffVersions: func(_ context.Context, _, _ string, from, to int) (*store.MCPPolicyDiff, error) {
			return &store.MCPPolicyDiff{
				FromVersion: from, ToVersion: to,
				FromSnapshot: json.RawMessage(`{}`),
				ToSnapshot:   json.RawMessage(`{}`),
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/diff?from=1&to=2", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	DiffMCPPolicyVersionsHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestListAuditLogHandlerSuccess(t *testing.T) {
	q := &versionsStubQuerier{
		listAuditLog: func(_ context.Context, scope, value, eventType string, from, to *time.Time, limit, offset int) ([]store.MCPPolicyAuditLog, error) {
			if eventType != "policy_updated" {
				t.Errorf("event_type = %q", eventType)
			}
			return []store.MCPPolicyAuditLog{
				{ID: "a", EventType: "policy_updated", OccurredAt: time.Now()},
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log?event_type=policy_updated", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestListAuditLogHandlerRejectsBadFromTime(t *testing.T) {
	q := &versionsStubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/audit-log?from=not-a-time", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestListAuditLogHandlerGlobalRoute(t *testing.T) {
	q := &versionsStubQuerier{
		listAuditLog: func(_ context.Context, scope, value, _ string, _, _ *time.Time, _, _ int) ([]store.MCPPolicyAuditLog, error) {
			if scope != "global" {
				t.Errorf("scope = %q, want global", scope)
			}
			return []store.MCPPolicyAuditLog{}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/global/audit-log", nil)
	req.SetPathValue("flavor", "global")
	rec := httptest.NewRecorder()
	ListMCPPolicyAuditLogHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}
