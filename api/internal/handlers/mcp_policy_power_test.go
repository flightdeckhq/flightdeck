// Handler tests for MCP Protection Policy power features:
// metrics, dry-run, import / export, templates / apply-template.

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

type powerStubQuerier struct {
	store.Querier
	getGlobal     func(context.Context) (*store.MCPPolicy, error)
	getFlavor     func(context.Context, string) (*store.MCPPolicy, error)
	updateScope   func(context.Context, string, string, store.MCPPolicyMutation, []store.MCPPolicyEntry, *string, map[string]any) (*store.MCPPolicy, error)
	getMetrics    func(context.Context, string, string, string) (*store.MCPPolicyMetrics, error)
	dryRunEvents  func(context.Context, int) ([]store.DryRunCandidate, error)
}

func (q *powerStubQuerier) GetGlobalMCPPolicy(ctx context.Context) (*store.MCPPolicy, error) {
	return q.getGlobal(ctx)
}
func (q *powerStubQuerier) GetMCPPolicy(ctx context.Context, flavor string) (*store.MCPPolicy, error) {
	return q.getFlavor(ctx, flavor)
}
func (q *powerStubQuerier) UpdateMCPPolicy(ctx context.Context, scope, scopeValue string, mut store.MCPPolicyMutation, resolved []store.MCPPolicyEntry, actor *string, extras map[string]any) (*store.MCPPolicy, error) {
	return q.updateScope(ctx, scope, scopeValue, mut, resolved, actor, extras)
}
func (q *powerStubQuerier) GetMCPPolicyMetrics(ctx context.Context, scope, scopeValue, period string) (*store.MCPPolicyMetrics, error) {
	return q.getMetrics(ctx, scope, scopeValue, period)
}
func (q *powerStubQuerier) DryRunMCPPolicyEvents(ctx context.Context, hours int) ([]store.DryRunCandidate, error) {
	return q.dryRunEvents(ctx, hours)
}

func TestMetricsHandlerSuccess(t *testing.T) {
	q := &powerStubQuerier{
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
	q := &powerStubQuerier{
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

func TestDryRunHandlerHappyPath(t *testing.T) {
	mode := "allowlist"
	q := &powerStubQuerier{
		getGlobal: func(_ context.Context) (*store.MCPPolicy, error) {
			return &store.MCPPolicy{Scope: "global", Mode: &mode}, nil
		},
		dryRunEvents: func(_ context.Context, hours int) ([]store.DryRunCandidate, error) {
			if hours != 24 {
				t.Errorf("default hours = %d, want 24", hours)
			}
			return []store.DryRunCandidate{
				{
					EventID:    "e1",
					ServerName: "maps",
					SessionFingerprints: []byte(`[
						{"name":"maps","fingerprint":"abcdef0123456789"}
					]`),
				},
				{
					EventID:    "e2",
					ServerName: "search",
					SessionFingerprints: []byte(`[
						{"name":"search","fingerprint":"deadbeefcafebabe"}
					]`),
				},
				{
					EventID:    "e3",
					ServerName: "ghost",
					// no fingerprints in session context — should
					// count as unresolvable
					SessionFingerprints: nil,
				},
			}, nil
		},
	}
	body := store.MCPPolicyMutation{
		BlockOnUncertainty: false,
		Entries:            []store.MCPPolicyEntryMutation{},
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production/dry_run", bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	DryRunMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var out store.MCPPolicyDryRunResult
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.EventsReplayed != 3 {
		t.Errorf("EventsReplayed = %d, want 3", out.EventsReplayed)
	}
	if out.UnresolvableCount != 1 {
		t.Errorf("Unresolvable = %d, want 1", out.UnresolvableCount)
	}
	// allowlist mode + no entries → maps + search both bucket
	// would_block (mode default).
	totalBlocks := 0
	for _, b := range out.PerServer {
		totalBlocks += b.WouldBlock
	}
	if totalBlocks != 2 {
		t.Errorf("would_block total = %d, want 2 (allowlist mode default)", totalBlocks)
	}
}

func TestDryRunHandlerRejectsBadHours(t *testing.T) {
	q := &powerStubQuerier{}
	body := store.MCPPolicyMutation{BlockOnUncertainty: false}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production/dry_run?hours=999", bytes.NewReader(buf))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	DryRunMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestImportYAMLHandlerHappyPath(t *testing.T) {
	q := &powerStubQuerier{
		updateScope: func(_ context.Context, scope, value string, _ store.MCPPolicyMutation, resolved []store.MCPPolicyEntry, _ *string, extras map[string]any) (*store.MCPPolicy, error) {
			if scope != "flavor" || value != "production" {
				t.Errorf("scope/value = %q/%q", scope, value)
			}
			if len(resolved) != 1 {
				t.Errorf("resolved entries = %d, want 1", len(resolved))
			}
			via, _ := extras["via"].(string)
			if via != "import" {
				t.Errorf("audit extras.via = %q, want import", via)
			}
			scopeValue := value
			return &store.MCPPolicy{ID: "p1", Scope: scope, ScopeValue: &scopeValue, Version: 2, Entries: resolved}, nil
		},
	}
	yamlBody := `
scope: flavor
scope_value: production
block_on_uncertainty: true
entries:
  - server_url: "https://maps.example.com/sse"
    server_name: maps
    entry_kind: allow
    enforcement: block
`
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production/import",
		strings.NewReader(yamlBody))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ImportMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestImportYAMLHandlerRejectsModeOnFlavor(t *testing.T) {
	q := &powerStubQuerier{}
	yamlBody := `
scope: flavor
scope_value: production
mode: allowlist
block_on_uncertainty: false
entries: []
`
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp-policies/production/import",
		strings.NewReader(yamlBody))
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ImportMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestExportYAMLHandlerSuccess(t *testing.T) {
	q := &powerStubQuerier{
		getFlavor: func(_ context.Context, flavor string) (*store.MCPPolicy, error) {
			value := flavor
			enforce := "block"
			return &store.MCPPolicy{
				ID:                 "p1",
				Scope:              "flavor",
				ScopeValue:         &value,
				BlockOnUncertainty: true,
				Entries: []store.MCPPolicyEntry{{
					ServerURLCanonical: "https://maps.example.com/sse",
					ServerName:         "maps",
					EntryKind:          "allow",
					Enforcement:        &enforce,
				}},
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/mcp-policies/production/export", nil)
	req.SetPathValue("flavor", "production")
	rec := httptest.NewRecorder()
	ExportMCPPolicyHandler(q)(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if rec.Header().Get("Content-Type") != "application/yaml" {
		t.Errorf("Content-Type = %q, want application/yaml", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "server_name: maps") {
		t.Errorf("export missing entry: body=%s", rec.Body.String())
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
	q := &powerStubQuerier{
		updateScope: func(_ context.Context, scope, value string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, extras map[string]any) (*store.MCPPolicy, error) {
			if scope != "flavor" || value != "production" {
				t.Errorf("scope/value = %q/%q", scope, value)
			}
			tmpl, _ := extras["applied_template"].(string)
			if tmpl != "strict-baseline" {
				t.Errorf("audit extras.applied_template = %q, want strict-baseline", tmpl)
			}
			scopeValue := value
			return &store.MCPPolicy{ID: "p", Scope: scope, ScopeValue: &scopeValue, Version: 2}, nil
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
	q := &powerStubQuerier{}
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
