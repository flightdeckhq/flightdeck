// MCP Protection Policy YAML import / export handlers. Schema
// matches the README quickstart byte-for-byte. Import is
// idempotent-by-PUT-replace: the entire policy + entries replace
// atomically with the imported content; bumps version; writes
// audit-log entry with payload.via='import'.

package handlers

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"gopkg.in/yaml.v3"
)

// policyYAML is the import / export wire shape. Mirrors the README
// quickstart YAML byte-for-byte.
type policyYAML struct {
	Scope              string          `yaml:"scope"`
	ScopeValue         string          `yaml:"scope_value,omitempty"`
	Mode               string          `yaml:"mode,omitempty"`
	BlockOnUncertainty bool            `yaml:"block_on_uncertainty"`
	Entries            []entryYAML     `yaml:"entries"`
}

type entryYAML struct {
	ServerURL   string `yaml:"server_url"`
	ServerName  string `yaml:"server_name"`
	EntryKind   string `yaml:"entry_kind"`
	Enforcement string `yaml:"enforcement,omitempty"`
}

// ImportMCPPolicyHandler handles POST /v1/mcp-policies/{flavor}/import.
//
// @Summary      Import flavor MCP policy from YAML
// @Description  Replaces flavor policy state from YAML body. Same atomic version + audit semantics as PUT; audit-log entry carries payload.via='import'. Schema matches the README quickstart YAML byte-for-byte.
// @Tags         mcp-policy
// @Accept       application/yaml
// @Produce      json
// @Param        flavor  path  string  true  "Agent flavor"
// @Param        body    body  string  true  "YAML policy state"
// @Success      200  {object}  store.MCPPolicy
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/import [post]
func ImportMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := flavorFromPath(r)
		if flavor == "" || isReservedFlavorSegment(flavor) || flavor == "global" {
			writeError(w, http.StatusBadRequest, "flavor is required (use PUT /global to update the global policy)")
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "read body: "+err.Error())
			return
		}
		var doc policyYAML
		if err := yaml.Unmarshal(body, &doc); err != nil {
			writeError(w, http.StatusBadRequest, "invalid YAML: "+err.Error())
			return
		}
		mut, msg := yamlToMutation(doc, "flavor")
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		if msg := validateMutation(mut, "flavor"); msg != "" {
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
			map[string]any{"via": "import"})
		if errors.Is(err, store.ErrMCPPolicyNotFound) {
			writeError(w, http.StatusNotFound, "flavor policy not found")
			return
		}
		if err != nil {
			slog.Error("import mcp policy", "err", err, "flavor", flavor)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, updated)
	}
}

// ExportMCPPolicyHandler handles GET /v1/mcp-policies/{flavor}/export.
//
// @Summary      Export flavor MCP policy as YAML
// @Description  Serializes current flavor policy state as YAML. Use the version-fetch endpoint for historical snapshots. Returns 404 when no flavor policy exists.
// @Tags         mcp-policy
// @Produce      application/yaml
// @Param        flavor  path  string  true  "Agent flavor"
// @Success      200  {string}  string
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/export [get]
func ExportMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := flavorFromPath(r)
		if flavor == "" || isReservedFlavorSegment(flavor) {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		var policy *store.MCPPolicy
		var err error
		if flavor == "global" {
			policy, err = s.GetGlobalMCPPolicy(r.Context())
		} else {
			policy, err = s.GetMCPPolicy(r.Context(), flavor)
		}
		if err != nil {
			slog.Error("export mcp policy", "err", err, "flavor", flavor)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if policy == nil {
			writeError(w, http.StatusNotFound, "flavor policy not found")
			return
		}
		doc := policyToYAML(*policy)
		out, err := yaml.Marshal(doc)
		if err != nil {
			slog.Error("marshal yaml", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/yaml")
		_, _ = w.Write(out)
	}
}

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

func policyToYAML(p store.MCPPolicy) policyYAML {
	doc := policyYAML{
		Scope:              p.Scope,
		BlockOnUncertainty: p.BlockOnUncertainty,
	}
	if p.ScopeValue != nil {
		doc.ScopeValue = *p.ScopeValue
	}
	if p.Mode != nil {
		doc.Mode = *p.Mode
	}
	for _, e := range p.Entries {
		ey := entryYAML{
			ServerURL:  e.ServerURLCanonical,
			ServerName: e.ServerName,
			EntryKind:  e.EntryKind,
		}
		if e.Enforcement != nil {
			ey.Enforcement = *e.Enforcement
		}
		doc.Entries = append(doc.Entries, ey)
	}
	return doc
}
