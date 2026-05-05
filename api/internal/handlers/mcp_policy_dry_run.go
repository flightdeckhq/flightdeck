// MCP Protection Policy dry-run engine handler. Replays last N hours
// of mcp_tool_call events against a proposed policy in the request
// body, returns per-server would-allow / would-warn / would-block
// counts plus an unresolvable count for events whose session lacks
// context.mcp_servers (D137).
//
// The store layer pulls the candidate event set as a flat slice; the
// per-event evaluation happens here so the SQL stays in mcp_policy_
// store.go per Rule 35 and the policy-resolution logic can call into
// the same helpers as the live ResolveMCPPolicy.

package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

const (
	dryRunDefaultHours = 24
	dryRunMaxHours     = 24 * 7 // 7 days
)

// DryRunMCPPolicyHandler handles POST /v1/mcp-policies/{flavor}/dry_run.
//
// @Summary      Dry-run a proposed MCP policy against historical traffic
// @Description  Replays the last N hours of mcp_tool_call events against the proposed policy in the request body. Returns per-server would_allow / would_warn / would_block counts plus an unresolvable_count for events whose session lacks context.mcp_servers (D137). Does NOT mutate state. hours param defaults to 24, max 168 (7 days).
// @Tags         mcp-policy
// @Accept       json
// @Produce      json
// @Param        flavor  path   string                       true   "Agent flavor or 'global'"
// @Param        hours   query  int                          false  "Replay window in hours (1..168, default 24)"
// @Param        body    body   store.MCPPolicyMutation      true   "Proposed policy"
// @Success      200  {object}  store.MCPPolicyDryRunResult
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/dry_run [post]
func DryRunMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, scopeValue := scopeAndValueFromPath(r)
		if scope == "flavor" && scopeValue == "" {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		_ = scope // reserved for future per-scope replay scoping

		hours := dryRunDefaultHours
		if raw := r.URL.Query().Get("hours"); raw != "" {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 1 || v > dryRunMaxHours {
				writeError(w, http.StatusBadRequest,
					"hours must be 1.."+strconv.Itoa(dryRunMaxHours))
				return
			}
			hours = v
		}

		var mut store.MCPPolicyMutation
		if err := json.NewDecoder(r.Body).Decode(&mut); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		// validateMutation against scope='flavor' here even when the
		// route is /global because the dry-run body shape matches a
		// flavor mutation (mode is implicit from the existing global
		// policy and not relevant to per-event evaluation). For the
		// global path, mode comes from the existing global policy
		// fetched below.
		if msg := validateDryRunMutation(mut); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}

		// Resolve entries to canonical URL + fingerprint for matching.
		resolvedEntries, err := resolveMutationEntries(mut)
		if err != nil {
			writeError(w, http.StatusBadRequest, "canonicalize url: "+err.Error())
			return
		}

		// Need the global policy's mode for fall-through evaluation.
		// The proposed mutation may override it (on the global path)
		// but not on flavor paths; resolve from existing storage.
		globalPolicy, err := s.GetGlobalMCPPolicy(r.Context())
		if err != nil || globalPolicy == nil || globalPolicy.Mode == nil {
			slog.Error("dry run global mode lookup", "err", err)
			writeError(w, http.StatusInternalServerError, "global policy mode unavailable")
			return
		}
		globalMode := *globalPolicy.Mode

		candidates, err := s.DryRunMCPPolicyEvents(r.Context(), hours)
		if err != nil {
			slog.Error("dry run pull events", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		result := evaluateDryRun(candidates, resolvedEntries, mut.BlockOnUncertainty, globalMode, hours)
		writeJSON(w, result)
	}
}

func validateDryRunMutation(mut store.MCPPolicyMutation) string {
	for i, e := range mut.Entries {
		if !validEntryKind[e.EntryKind] {
			return entryError(i, "entry_kind must be one of: allow, deny")
		}
		if e.Enforcement != nil && !validEnforcement[*e.Enforcement] {
			return entryError(i, "enforcement must be one of: warn, block, interactive")
		}
		if e.ServerURL == "" {
			return entryError(i, "server_url is required")
		}
		if e.ServerName == "" {
			return entryError(i, "server_name is required")
		}
	}
	return ""
}

// evaluateDryRun walks the candidate event set, recovers each event's
// canonical URL via sessions.context.mcp_servers, and evaluates
// against the proposed policy. Per-server counts accumulate; events
// whose session lacks the context bucket count toward
// unresolvable_count.
func evaluateDryRun(
	candidates []store.DryRunCandidate,
	proposedEntries []store.MCPPolicyEntry,
	blockOnUncertainty bool,
	globalMode string,
	hours int,
) store.MCPPolicyDryRunResult {
	result := store.MCPPolicyDryRunResult{
		Hours:          hours,
		EventsReplayed: len(candidates),
		PerServer:      []store.DryRunServerCount{},
	}

	// Build a fingerprint → entry lookup once for O(1) per-event
	// resolution.
	entryByFP := make(map[string]store.MCPPolicyEntry, len(proposedEntries))
	for _, e := range proposedEntries {
		entryByFP[e.Fingerprint] = e
	}

	// Per-server bucket keyed by fingerprint.
	type bucketAcc struct {
		serverName  string
		fingerprint string
		allow       int
		warn        int
		block       int
	}
	buckets := make(map[string]*bucketAcc)

	for _, c := range candidates {
		fp, name, ok := lookupFingerprintBySessionContext(c.SessionFingerprints, c.ServerName)
		if !ok {
			result.UnresolvableCount++
			continue
		}
		decision := evaluateOne(fp, entryByFP, blockOnUncertainty, globalMode)
		acc, exists := buckets[fp]
		if !exists {
			acc = &bucketAcc{serverName: name, fingerprint: fp}
			buckets[fp] = acc
		}
		switch decision {
		case "allow":
			acc.allow++
		case "warn":
			acc.warn++
		case "block":
			acc.block++
		}
	}

	for _, acc := range buckets {
		result.PerServer = append(result.PerServer, store.DryRunServerCount{
			Fingerprint: acc.fingerprint,
			ServerName:  acc.serverName,
			WouldAllow:  acc.allow,
			WouldWarn:   acc.warn,
			WouldBlock:  acc.block,
		})
	}
	return result
}

// evaluateOne mirrors the D135 resolution algorithm for one
// (fingerprint, mode) pair. Step 1 (flavor entry) is folded into
// step 2 (entry lookup) because the dry-run is per-policy — the
// proposed entries ARE the flavor's entries for this evaluation.
func evaluateOne(
	fp string,
	entryByFP map[string]store.MCPPolicyEntry,
	blockOnUncertainty bool,
	globalMode string,
) string {
	if entry, ok := entryByFP[fp]; ok {
		if entry.EntryKind == "allow" {
			return "allow"
		}
		// deny entry — enforcement field upgrades the bare deny to
		// warn / block. interactive isn't a sensible dry-run output.
		if entry.Enforcement != nil && *entry.Enforcement != "" && *entry.Enforcement != "interactive" {
			return *entry.Enforcement
		}
		return "block"
	}
	// Fall through to mode default.
	if globalMode == "allowlist" {
		if blockOnUncertainty {
			return "block"
		}
		return "block" // allowlist mode default already blocks unknown URLs
	}
	return "allow"
}

// lookupFingerprintBySessionContext walks the JSONB-encoded
// sessions.context.mcp_servers array looking for an entry whose name
// matches eventServerName. Returns (fingerprint, name, true) when
// found; (_, _, false) when the session has no context.mcp_servers
// or no entry matches the name.
func lookupFingerprintBySessionContext(sessionFPs []byte, eventServerName string) (string, string, bool) {
	if len(sessionFPs) == 0 || eventServerName == "" {
		return "", "", false
	}
	var entries []map[string]any
	if err := json.Unmarshal(sessionFPs, &entries); err != nil {
		return "", "", false
	}
	for _, e := range entries {
		name, _ := e["name"].(string)
		if name != eventServerName {
			continue
		}
		fp, _ := e["fingerprint"].(string)
		if fp == "" {
			return "", "", false
		}
		return fp, name, true
	}
	return "", "", false
}
