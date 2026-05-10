// Handler integration tests for POST /v1/mcp-policies/{flavor}/apply_template
// (D138). Complements the pre-existing happy-path + unknown-template
// cases in mcp_policy_metrics_templates_test.go with the corner
// paths — global rejection (durable contract), missing-template body
// field, flavor-not-found, and malformed JSON.

package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

type applyTemplateStubQuerier struct {
	store.Querier
	updateScope func(context.Context, string, string, store.MCPPolicyMutation, []store.MCPPolicyEntry, *string, map[string]any) (*store.MCPPolicy, error)
}

func (q *applyTemplateStubQuerier) UpdateMCPPolicy(
	ctx context.Context,
	scope, scopeValue string,
	mut store.MCPPolicyMutation,
	resolved []store.MCPPolicyEntry,
	actor *string,
	extras map[string]any,
) (*store.MCPPolicy, error) {
	return q.updateScope(ctx, scope, scopeValue, mut, resolved, actor, extras)
}

func newApplyTemplateRequest(t *testing.T, flavor, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/mcp-policies/"+flavor+"/apply_template",
		bytes.NewBufferString(body),
	)
	req.SetPathValue("flavor", flavor)
	return req
}

func TestApplyTemplate_GlobalScope_RejectedWithDurableContractMessage(t *testing.T) {
	q := &applyTemplateStubQuerier{
		updateScope: func(_ context.Context, _, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			t.Fatal("UpdateMCPPolicy must not be called for global apply_template")
			return nil, nil
		},
	}
	req := newApplyTemplateRequest(t, "global", `{"template":"strict-baseline"}`)
	rec := httptest.NewRecorder()

	ApplyMCPPolicyTemplateHandler(q)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	// The error string is the durable contract surfaced to any
	// caller (dashboard, CLI, future clients). D138 + D134:
	// templates carry mode + per-entry enforcement; mode is
	// global-only and yamlToMutation rejects it on flavor scope,
	// so templates apply to flavor policies only.
	if !strings.Contains(rec.Body.String(), "templates apply to flavor policies only") {
		t.Errorf("error body = %s; want it to contain 'templates apply to flavor policies only'", rec.Body.String())
	}
}

func TestApplyTemplate_MissingTemplateField_400(t *testing.T) {
	q := &applyTemplateStubQuerier{
		updateScope: func(_ context.Context, _, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			t.Fatal("UpdateMCPPolicy must not be called when template field is missing")
			return nil, nil
		},
	}
	// JSON body present but ``template`` absent — handler trims to
	// "" and the empty name fails the lookupTemplateConfig check.
	req := newApplyTemplateRequest(t, "research-agent", `{}`)
	rec := httptest.NewRecorder()

	ApplyMCPPolicyTemplateHandler(q)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unknown template") {
		t.Errorf("error body = %s; want it to contain 'unknown template' for the empty name",
			rec.Body.String())
	}
}

func TestApplyTemplate_FlavorPolicyNotFound_404(t *testing.T) {
	q := &applyTemplateStubQuerier{
		updateScope: func(_ context.Context, _, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			return nil, store.ErrMCPPolicyNotFound
		},
	}
	req := newApplyTemplateRequest(t, "ghost-flavor", `{"template":"strict-baseline"}`)
	rec := httptest.NewRecorder()

	ApplyMCPPolicyTemplateHandler(q)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "flavor policy not found") {
		t.Errorf("error body = %s; want it to contain 'flavor policy not found'", rec.Body.String())
	}
}

func TestApplyTemplate_InvalidJSON_400(t *testing.T) {
	// Defensive case alongside the 5 documented above — malformed
	// JSON bodies should land cleanly on the json.Decode 400 path,
	// not bubble up as a 500.
	q := &applyTemplateStubQuerier{
		updateScope: func(_ context.Context, _, _ string, _ store.MCPPolicyMutation, _ []store.MCPPolicyEntry, _ *string, _ map[string]any) (*store.MCPPolicy, error) {
			t.Fatal("UpdateMCPPolicy must not be called for invalid JSON")
			return nil, nil
		},
	}
	req := newApplyTemplateRequest(t, "research-agent", `not-json`)
	rec := httptest.NewRecorder()

	ApplyMCPPolicyTemplateHandler(q)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid JSON") {
		t.Errorf("error body = %s; want it to contain 'invalid JSON'", rec.Body.String())
	}
}

