// Handler tests for MCP Protection Policy metrics + templates.
// Originally these lived in ``mcp_policy_power_test.go`` alongside
// dry-run and YAML import/export tests; step 6.8 cleanup retired
// those features (D142, D143, D144) and the legacy "power" name
// died with them.

package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

type metricsTemplatesStubQuerier struct {
	store.Querier
	updateScope func(context.Context, string, string, store.MCPPolicyMutation, []store.MCPPolicyEntry, *string, map[string]any) (*store.MCPPolicy, error)
	getMetrics  func(context.Context, string, string, string) (*store.MCPPolicyMetrics, error)
}

func (q *metricsTemplatesStubQuerier) UpdateMCPPolicy(ctx context.Context, scope, scopeValue string, mut store.MCPPolicyMutation, resolved []store.MCPPolicyEntry, actor *string, extras map[string]any) (*store.MCPPolicy, error) {
	return q.updateScope(ctx, scope, scopeValue, mut, resolved, actor, extras)
}
func (q *metricsTemplatesStubQuerier) GetMCPPolicyMetrics(ctx context.Context, scope, scopeValue, period string) (*store.MCPPolicyMetrics, error) {
	return q.getMetrics(ctx, scope, scopeValue, period)
}

func TestMetricsHandlerSuccess(t *testing.T) {
	q := &metricsTemplatesStubQuerier{
		getMetrics: func(_ context.Context, _, _, period string) (*store.MCPPolicyMetrics, error) {
			return &store.MCPPolicyMetrics{
				Period:          period,
				BlocksPerServer: []store.ServerCountBucket{},
				WarnsPerServer:  []store.ServerCountBucket{},
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/metrics?period=7d", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	GetMCPPolicyMetricsHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestMetricsHandlerDefaultsPeriod(t *testing.T) {
	q := &metricsTemplatesStubQuerier{
		getMetrics: func(_ context.Context, _, _, period string) (*store.MCPPolicyMetrics, error) {
			if period != "24h" {
				t.Errorf("default period = %q, want 24h", period)
			}
			return &store.MCPPolicyMetrics{Period: period}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/metrics", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	GetMCPPolicyMetricsHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestListTemplatesHandlerReturnsAllThree(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/templates", nil)
	rec := httptest.NewRecorder()
	ListMCPPolicyTemplatesHandler()(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var templates []templateMeta
	if err := json.NewDecoder(rec.Body).Decode(&templates); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(templates) != 3 {
		t.Errorf("template count = %d, want 3", len(templates))
	}
	names := map[string]bool{}
	for _, m := range templates {
		names[m.Name] = true
		if m.YAMLBody == "" {
			t.Errorf("template %q has empty YAML body", m.Name)
		}
	}
	for _, want := range []string{"strict-baseline", "permissive-dev", "strict-with-common-allows"} {
		if !names[want] {
			t.Errorf("missing template %q", want)
		}
	}
}

func TestListTemplatesIncludesURLMaintenanceWarning(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/templates", nil)
	rec := httptest.NewRecorder()
	ListMCPPolicyTemplatesHandler()(rec, req)
	var templates []templateMeta
	_ = json.NewDecoder(rec.Body).Decode(&templates)
	for _, m := range templates {
		if m.Name == "strict-with-common-allows" {
			lower := strings.ToLower(m.Description)
			if !strings.Contains(lower, "verify against your provider") {
				t.Errorf("strict-with-common-allows description missing maintenance warning: %s", m.Description)
			}
			return
		}
	}
	t.Errorf("strict-with-common-allows template not found")
}

func TestApplyTemplateHandlerHappyPath(t *testing.T) {
	q := &metricsTemplatesStubQuerier{
		updateScope: func(_ context.Context, scope, value string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, extras map[string]any) (*store.MCPPolicy, error) {
			if scope != "flavor" || value != "production" {
				t.Errorf("scope/value = %q/%q", scope, value)
			}
			tmpl, _ := extras["applied_template"].(string)
			if tmpl != "strict-baseline" {
				t.Errorf("audit extras.applied_template = %q, want strict-baseline", tmpl)
			}
			scopeValue := value
			return &store.MCPPolicy{ID: "p", Scope: scope, ScopeValue: &scopeValue}, nil
		},
	}
	body := applyTemplateRequest{Template: "strict-baseline"}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production/apply_template",
		bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ApplyMCPPolicyTemplateHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestApplyTemplateHandlerRejectsUnknownTemplate(t *testing.T) {
	q := &metricsTemplatesStubQuerier{}
	body := applyTemplateRequest{Template: "no-such-template"}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production/apply_template",
		bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ApplyMCPPolicyTemplateHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
