// MCP Protection Policy templates handler. Three locked templates
// (D138) ship embedded via embed.FS:
//   - strict-baseline
//   - permissive-dev
//   - strict-with-common-allows
//
// The third template carries a URL-maintenance warning in its YAML
// header AND in the description field surfaced via
// GET /v1/mcp-policies/templates so operators see the warning
// regardless of which surface they read.

package handlers

import (
	"embed"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"gopkg.in/yaml.v3"
)

//go:embed mcp_policy_templates/*.yaml
var policyTemplatesFS embed.FS

// templateMeta is the response shape for GET /v1/mcp-policies/templates.
type templateMeta struct {
	Name           string `json:"name"`
	Description    string `json:"description"`
	RecommendedFor string `json:"recommended_for"`
	YAMLBody       string `json:"yaml_body"`
}

// templateCatalog hard-codes the three shipped templates' metadata.
// The YAML body is loaded from policyTemplatesFS at request time;
// the metadata stays in code because the YAML header comments aren't
// machine-parsed — the description + recommended_for are what the
// dashboard renders.
var templateCatalog = []templateMetaConfig{
	{
		Name:           "strict-baseline",
		Description:    "Allowlist mode with block_on_uncertainty=true and zero entries. Every server is blocked until the operator adds an explicit allow. Production-grade default.",
		RecommendedFor: "Production flavor where the operator wants the 'everything blocks until I say so' posture.",
		File:           "mcp_policy_templates/strict-baseline.yaml",
	},
	{
		Name:           "permissive-dev",
		Description:    "Permissive flavor matching the global blocklist default, but explicit. Every server is allowed unless explicitly denied.",
		RecommendedFor: "Dev flavor where unknown servers should pass without friction.",
		File:           "mcp_policy_templates/permissive-dev.yaml",
	},
	{
		Name: "strict-with-common-allows",
		Description: "Allowlist mode with block_on_uncertainty=true plus three pre-populated allow entries for well-known MCP servers (filesystem npx package, github HTTPS endpoint, slack HTTPS endpoint). " +
			"WARNING: the pre-populated server URLs reflect well-known MCP server endpoints as of the v0.6 release; verify against your provider's current documentation before relying on them in production.",
		RecommendedFor: "Production flavor with immediate productivity for the most common public MCP servers; expect to maintain the URL list as upstream providers evolve.",
		File:           "mcp_policy_templates/strict-with-common-allows.yaml",
	},
}

type templateMetaConfig struct {
	Name           string
	Description    string
	RecommendedFor string
	File           string
}

// ListMCPPolicyTemplatesHandler handles GET /v1/mcp-policies/templates.
//
// @Summary      List shipped MCP policy templates
// @Description  Returns the three locked templates (D138) with metadata + YAML body. Read-only scope; any valid bearer token. The strict-with-common-allows template carries a maintenance warning in its description.
// @Tags         mcp-policy
// @Produce      json
// @Success      200  {array}  templateMeta
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/templates [get]
func ListMCPPolicyTemplatesHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		out := make([]templateMeta, 0, len(templateCatalog))
		for _, cfg := range templateCatalog {
			body, err := policyTemplatesFS.ReadFile(cfg.File)
			if err != nil {
				slog.Error("read template", "err", err, "file", cfg.File)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			out = append(out, templateMeta{
				Name:           cfg.Name,
				Description:    cfg.Description,
				RecommendedFor: cfg.RecommendedFor,
				YAMLBody:       string(body),
			})
		}
		writeJSON(w, out)
	}
}

// applyTemplateRequest is the body shape for POST /apply_template.
type applyTemplateRequest struct {
	Template string `json:"template"`
}

// ApplyMCPPolicyTemplateHandler handles POST /v1/mcp-policies/{flavor}/apply_template.
//
// @Summary      Apply a named template to a flavor MCP policy
// @Description  Replaces the flavor policy state with the template's content. Same atomic version + audit semantics as PUT; audit-log entry carries payload.applied_template=<name>.
// @Tags         mcp-policy
// @Accept       json
// @Produce      json
// @Param        flavor  path  string                 true  "Agent flavor"
// @Param        body    body  applyTemplateRequest  true  "Template name"
// @Success      200  {object}  store.MCPPolicy
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/apply_template [post]
func ApplyMCPPolicyTemplateHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := flavorFromPath(r)
		if flavor == "" || isReservedFlavorSegment(flavor) || flavor == "global" {
			// D138 + D134: shipped templates carry per-entry
			// enforcement and (permissive-dev) mode; mode is
			// global-only and yamlToMutation rejects it on
			// flavor scope. Templates therefore apply to flavor
			// policies only — the global default is configured
			// directly via PUT /v1/mcp-policies/global. The
			// rejection message is the durable contract surfaced
			// to any caller (dashboard, CLI, future clients).
			writeError(w, http.StatusBadRequest, "templates apply to flavor policies only")
			return
		}
		var body applyTemplateRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		body.Template = strings.TrimSpace(body.Template)
		cfg, ok := lookupTemplateConfig(body.Template)
		if !ok {
			writeError(w, http.StatusBadRequest, "unknown template: "+body.Template)
			return
		}
		yamlBody, err := policyTemplatesFS.ReadFile(cfg.File)
		if err != nil {
			slog.Error("read template", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		var doc policyYAML
		if err := yaml.Unmarshal(yamlBody, &doc); err != nil {
			slog.Error("parse template yaml", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		mut, msg := yamlToMutation(doc, "flavor")
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		resolved, err := resolveMutationEntries(mut)
		if err != nil {
			writeError(w, http.StatusBadRequest, "canonicalize url: "+err.Error())
			return
		}
		actor := actorTokenIDFromContext(r)
		updated, err := s.UpdateMCPPolicy(r.Context(), "flavor", flavor, mut, resolved, actor,
			map[string]any{"applied_template": cfg.Name})
		if errors.Is(err, store.ErrMCPPolicyNotFound) {
			writeError(w, http.StatusNotFound, "flavor policy not found; create it first")
			return
		}
		if err != nil {
			slog.Error("apply template", "err", err, "flavor", flavor, "template", cfg.Name)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, updated)
	}
}

func lookupTemplateConfig(name string) (templateMetaConfig, bool) {
	for _, cfg := range templateCatalog {
		if cfg.Name == name {
			return cfg, true
		}
	}
	return templateMetaConfig{}, false
}

// policyYAML is the wire shape of a shipped template's YAML body.
// Originally also used by the YAML import/export endpoints; D144
// retired those (step 6.8 cleanup) so the type is now templates-
// internal. The shipped templates are the only YAML the API still
// accepts as policy input.
type policyYAML struct {
	Scope              string      `yaml:"scope"`
	ScopeValue         string      `yaml:"scope_value,omitempty"`
	Mode               string      `yaml:"mode,omitempty"`
	BlockOnUncertainty bool        `yaml:"block_on_uncertainty"`
	Entries            []entryYAML `yaml:"entries"`
}

type entryYAML struct {
	ServerURL   string `yaml:"server_url"`
	ServerName  string `yaml:"server_name"`
	EntryKind   string `yaml:"entry_kind"`
	Enforcement string `yaml:"enforcement,omitempty"`
}

// yamlToMutation converts a parsed template YAML into the store's
// MCPPolicyMutation shape. The scope arg is the apply target (always
// "flavor" for the shipped templates) and rejects YAML that carries
// mode on a flavor scope (D134).
func yamlToMutation(doc policyYAML, scope string) (store.MCPPolicyMutation, string) {
	mut := store.MCPPolicyMutation{
		BlockOnUncertainty: doc.BlockOnUncertainty,
	}
	if doc.Mode != "" {
		if scope == "flavor" {
			return mut, "mode is global-only; flavor YAML must omit mode (D134)"
		}
		mode := doc.Mode
		mut.Mode = &mode
	}
	for _, ye := range doc.Entries {
		em := store.MCPPolicyEntryMutation{
			ServerURL:  strings.TrimSpace(ye.ServerURL),
			ServerName: strings.TrimSpace(ye.ServerName),
			EntryKind:  strings.TrimSpace(ye.EntryKind),
		}
		if ye.Enforcement != "" {
			enforcement := ye.Enforcement
			em.Enforcement = &enforcement
		}
		mut.Entries = append(mut.Entries, em)
	}
	return mut, ""
}
