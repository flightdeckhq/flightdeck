// Handler-level tests for MCP Protection Policy core CRUD. The
// read-side tests run against a stub Querier (in-memory mock); the
// validation-side tests assert the API-boundary checks per Rule 36
// without requiring a database.

package handlers

import (
	"bytes"
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

// stubQuerier is a Querier that delegates only the methods this test
// file exercises; the rest panic if called. Each test installs the
// behaviour it needs via field-level closures.
type stubQuerier struct {
	store.Querier
	getGlobal      func(context.Context) (*store.MCPPolicy, error)
	getFlavor      func(context.Context, string) (*store.MCPPolicy, error)
	createFlavor   func(context.Context, string, store.MCPPolicyMutation, []store.MCPPolicyEntry, *string) (*store.MCPPolicy, error)
	updateScope    func(context.Context, string, string, store.MCPPolicyMutation, []store.MCPPolicyEntry, *string, map[string]any) (*store.MCPPolicy, error)
	deleteFlavor   func(context.Context, string, *string) error
	resolveFlavor  func(context.Context, string, string) (*store.MCPPolicyResolveResult, error)
}

func (q *stubQuerier) GetGlobalMCPPolicy(ctx context.Context) (*store.MCPPolicy, error) {
	return q.getGlobal(ctx)
}
func (q *stubQuerier) GetMCPPolicy(ctx context.Context, flavor string) (*store.MCPPolicy, error) {
	return q.getFlavor(ctx, flavor)
}
func (q *stubQuerier) CreateMCPPolicy(ctx context.Context, flavor string, mut store.MCPPolicyMutation, resolved []store.MCPPolicyEntry, actor *string) (*store.MCPPolicy, error) {
	return q.createFlavor(ctx, flavor, mut, resolved, actor)
}
func (q *stubQuerier) UpdateMCPPolicy(ctx context.Context, scope, scopeValue string, mut store.MCPPolicyMutation, resolved []store.MCPPolicyEntry, actor *string, extras map[string]any) (*store.MCPPolicy, error) {
	return q.updateScope(ctx, scope, scopeValue, mut, resolved, actor, extras)
}
func (q *stubQuerier) DeleteMCPPolicy(ctx context.Context, flavor string, actor *string) error {
	return q.deleteFlavor(ctx, flavor, actor)
}
func (q *stubQuerier) ResolveMCPPolicy(ctx context.Context, flavor, fingerprint string) (*store.MCPPolicyResolveResult, error) {
	return q.resolveFlavor(ctx, flavor, fingerprint)
}

func TestGetGlobalMCPPolicyHandlerSuccess(t *testing.T) {
	mode := "blocklist"
	q := &stubQuerier{
		getGlobal: func(_ context.Context) (*store.MCPPolicy, error) {
			return &store.MCPPolicy{
				ID:                 "test-id",
				Scope:              "global",
				Mode:               &mode,
				BlockOnUncertainty: false,
				CreatedAt:          time.Now(),
				UpdatedAt:          time.Now(),
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/global", nil)
	rec := httptest.NewRecorder()
	GetGlobalMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body store.MCPPolicy
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Scope != "global" {
		t.Errorf("scope = %q, want global", body.Scope)
	}
}

func TestGetGlobalMCPPolicyHandlerMissing(t *testing.T) {
	q := &stubQuerier{
		getGlobal: func(_ context.Context) (*store.MCPPolicy, error) { return nil, nil },
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/global", nil)
	rec := httptest.NewRecorder()
	GetGlobalMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestGetMCPPolicyHandlerNotFound(t *testing.T) {
	q := &stubQuerier{
		getFlavor: func(_ context.Context, _ string) (*store.MCPPolicy, error) { return nil, nil },
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/missing", nil)
	req.SetPathValue("flavor", "missing")
	rec := httptest.NewRecorder()
	GetMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestGetMCPPolicyHandlerSuccess(t *testing.T) {
	q := &stubQuerier{
		getFlavor: func(_ context.Context, flavor string) (*store.MCPPolicy, error) {
			value := flavor
			return &store.MCPPolicy{
				ID:         "x",
				Scope:      "flavor",
				ScopeValue: &value,
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	GetMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestGetMCPPolicyHandlerRejectsReservedFlavor(t *testing.T) {
	q := &stubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/resolve", nil)
	req.SetPathValue("flavor", "resolve")
	rec := httptest.NewRecorder()
	GetMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestCreateMCPPolicyHandlerHappyPath(t *testing.T) {
	q := &stubQuerier{
		createFlavor: func(_ context.Context, flavor string, mut store.MCPPolicyMutation, resolved []store.MCPPolicyEntry, _ *string) (*store.MCPPolicy, error) {
			if flavor != "production" {
				t.Errorf("flavor = %q, want production", flavor)
			}
			if len(resolved) != 1 {
				t.Errorf("resolved entries len = %d, want 1", len(resolved))
			}
			value := flavor
			return &store.MCPPolicy{
				ID:                 "new-id",
				Scope:              "flavor",
				ScopeValue:         &value,
				BlockOnUncertainty: mut.BlockOnUncertainty,
				Entries:            resolved,
			}, nil
		},
	}
	enforce := "block"
	body := store.MCPPolicyMutation{
		BlockOnUncertainty: true,
		Entries: []store.MCPPolicyEntryMutation{{
			ServerURL:   "https://maps.example.com",
			ServerName:  "maps",
			EntryKind:   "allow",
			Enforcement: &enforce,
		}},
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production", bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	CreateMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateMCPPolicyHandlerRejectsModeOnFlavor(t *testing.T) {
	q := &stubQuerier{}
	mode := "allowlist"
	body := store.MCPPolicyMutation{Mode: &mode, BlockOnUncertainty: false}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production", bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	CreateMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "mode is global-only") {
		t.Errorf("expected D134 message in body, got: %s", rec.Body.String())
	}
}

func TestCreateMCPPolicyHandlerRejectsBadEntryKind(t *testing.T) {
	q := &stubQuerier{}
	body := store.MCPPolicyMutation{
		BlockOnUncertainty: false,
		Entries: []store.MCPPolicyEntryMutation{{
			ServerURL:  "https://example.com",
			ServerName: "x",
			EntryKind:  "wat", // bogus
		}},
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production", bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	CreateMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestCreateMCPPolicyHandlerRejectsEmptyURL(t *testing.T) {
	q := &stubQuerier{}
	body := store.MCPPolicyMutation{
		BlockOnUncertainty: false,
		Entries: []store.MCPPolicyEntryMutation{{
			ServerURL:  "",
			ServerName: "x",
			EntryKind:  "allow",
		}},
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production", bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	CreateMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestCreateMCPPolicyHandlerConflict(t *testing.T) {
	q := &stubQuerier{
		createFlavor: func(_ context.Context, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string) (*store.MCPPolicy, error) {
			return nil, store.ErrMCPPolicyAlreadyExists
		},
	}
	body := store.MCPPolicyMutation{BlockOnUncertainty: false}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production", bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	CreateMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec.Code)
	}
}

func TestUpdateGlobalMCPPolicyHandlerRequiresMode(t *testing.T) {
	q := &stubQuerier{}
	body := store.MCPPolicyMutation{BlockOnUncertainty: false} // no mode
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/v1/mcp-policies/global", bytes.NewReader(buf))
	rec := httptest.NewRecorder()
	UpdateGlobalMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestUpdateMCPPolicyHandlerNotFound(t *testing.T) {
	q := &stubQuerier{
		updateScope: func(_ context.Context, _, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			return nil, store.ErrMCPPolicyNotFound
		},
	}
	body := store.MCPPolicyMutation{BlockOnUncertainty: true}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/v1/mcp-policies/ghost", bytes.NewReader(buf))
	req.SetPathValue("flavor", "ghost")
	rec := httptest.NewRecorder()
	UpdateMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestDeleteMCPPolicyHandlerRefusesGlobal(t *testing.T) {
	q := &stubQuerier{}
	req := httptest.NewRequest(http.MethodDelete, "/v1/mcp-policies/global", nil)
	req.SetPathValue("flavor", "global")
	rec := httptest.NewRecorder()
	DeleteMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteMCPPolicyHandlerSuccess(t *testing.T) {
	q := &stubQuerier{
		deleteFlavor: func(_ context.Context, flavor string, _ *string) error {
			if flavor != "production" {
				t.Errorf("flavor = %q, want production", flavor)
			}
			return nil
		},
	}
	req := httptest.NewRequest(http.MethodDelete, "/v1/mcp-policies/production", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	DeleteMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}

func TestDeleteMCPPolicyHandlerNotFound(t *testing.T) {
	q := &stubQuerier{
		deleteFlavor: func(_ context.Context, _ string, _ *string) error {
			return store.ErrMCPPolicyNotFound
		},
	}
	req := httptest.NewRequest(http.MethodDelete, "/v1/mcp-policies/ghost", nil)
	req.SetPathValue("flavor", "ghost")
	rec := httptest.NewRecorder()
	DeleteMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestResolveMCPPolicyHandlerSuccess(t *testing.T) {
	q := &stubQuerier{
		resolveFlavor: func(_ context.Context, flavor, fp string) (*store.MCPPolicyResolveResult, error) {
			if flavor != "production" {
				t.Errorf("flavor = %q, want production", flavor)
			}
			if fp == "" {
				t.Errorf("fingerprint must be non-empty")
			}
			return &store.MCPPolicyResolveResult{
				Decision:     "allow",
				DecisionPath: "global_entry",
				PolicyID:     "p1",
				Scope:        "global",
				Fingerprint:  fp,
			}, nil
		},
	}
	url := "/v1/mcp-policies/resolve?flavor=production&server_url=https%3A%2F%2Fmaps.example.com&server_name=maps"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	ResolveMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body store.MCPPolicyResolveResult
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Decision != "allow" {
		t.Errorf("decision = %q, want allow", body.Decision)
	}
}

func TestResolveMCPPolicyHandlerRequiresServerURL(t *testing.T) {
	q := &stubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/resolve?server_name=x", nil)
	rec := httptest.NewRecorder()
	ResolveMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestResolveMCPPolicyHandlerRequiresServerName(t *testing.T) {
	q := &stubQuerier{}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/resolve?server_url=https://x", nil)
	rec := httptest.NewRecorder()
	ResolveMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestResolveMCPPolicyHandlerStoreError(t *testing.T) {
	q := &stubQuerier{
		resolveFlavor: func(_ context.Context, _, _ string) (*store.MCPPolicyResolveResult, error) {
			return nil, errors.New("boom")
		},
	}
	url := "/v1/mcp-policies/resolve?server_url=https%3A%2F%2Fx&server_name=x"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	ResolveMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestUpdateGlobalMCPPolicyHandlerSuccess(t *testing.T) {
	mode := "blocklist"
	q := &stubQuerier{
		updateScope: func(_ context.Context, scope, scopeValue string, mut store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			if scope != "global" || scopeValue != "" {
				t.Errorf("scope/value = %q/%q, want global/\"\"", scope, scopeValue)
			}
			if mut.Mode == nil || *mut.Mode != "blocklist" {
				t.Errorf("mode = %v, want blocklist", mut.Mode)
			}
			return &store.MCPPolicy{ID: "g", Scope: "global", Mode: &mode}, nil
		},
	}
	body := store.MCPPolicyMutation{Mode: &mode}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/v1/mcp-policies/global", bytes.NewReader(buf))
	rec := httptest.NewRecorder()
	UpdateGlobalMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp store.MCPPolicy
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Scope != "global" {
		t.Errorf("response scope = %q, want global", resp.Scope)
	}
}

func TestUpdateGlobalMCPPolicyHandlerNotFound(t *testing.T) {
	mode := "allowlist"
	q := &stubQuerier{
		updateScope: func(_ context.Context, _, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			return nil, store.ErrMCPPolicyNotFound
		},
	}
	body := store.MCPPolicyMutation{Mode: &mode}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/v1/mcp-policies/global", bytes.NewReader(buf))
	rec := httptest.NewRecorder()
	UpdateGlobalMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestUpdateGlobalMCPPolicyHandlerStoreError(t *testing.T) {
	mode := "blocklist"
	q := &stubQuerier{
		updateScope: func(_ context.Context, _, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			return nil, errors.New("connection refused")
		},
	}
	body := store.MCPPolicyMutation{Mode: &mode}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/v1/mcp-policies/global", bytes.NewReader(buf))
	rec := httptest.NewRecorder()
	UpdateGlobalMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestUpdateGlobalMCPPolicyHandlerInvalidJSON(t *testing.T) {
	q := &stubQuerier{} // updateScope never reached
	req := httptest.NewRequest(http.MethodPut, "/v1/mcp-policies/global",
		strings.NewReader("not json"))
	rec := httptest.NewRecorder()
	UpdateGlobalMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
