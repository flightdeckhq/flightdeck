package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/jackc/pgx/v5"
)

// EffectivePolicyHandler handles GET /v1/policy.
// Returns the most specific policy for a given flavor/session scope.
//
// @Summary      Get effective policy
// @Description  Returns the most specific policy for a given flavor/session scope. Lookup order: session > flavor > org
// @Tags         policies
// @Produce      json
// @Param        flavor      query  string  false  "Agent flavor"
// @Param        session_id  query  string  false  "Session ID"
// @Success      200  {object}  store.Policy
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/policy [get]
func EffectivePolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := r.URL.Query().Get("flavor")
		sessionID := r.URL.Query().Get("session_id")

		policy, err := s.GetEffectivePolicy(r.Context(), flavor, sessionID)
		if err != nil {
			slog.Error("get effective policy error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if policy == nil {
			writeError(w, http.StatusNotFound, "no policy found")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(policy)
	}
}

// PolicyRequest is the request body for creating/updating a policy.
type PolicyRequest struct {
	Scope        string  `json:"scope"`
	ScopeValue   string  `json:"scope_value"`
	TokenLimit   *int64  `json:"token_limit"`
	WarnAtPct    *int    `json:"warn_at_pct"`
	DegradeAtPct *int    `json:"degrade_at_pct"`
	DegradeTo    *string `json:"degrade_to"`
	BlockAtPct   *int    `json:"block_at_pct"`
}

func validatePolicyRequest(r PolicyRequest) string {
	validScopes := map[string]bool{"org": true, "flavor": true, "session": true}
	if !validScopes[r.Scope] {
		return "scope must be one of: org, flavor, session"
	}
	if r.Scope != "org" && r.ScopeValue == "" {
		return "scope_value is required for flavor and session scope"
	}
	if r.WarnAtPct != nil && (*r.WarnAtPct < 1 || *r.WarnAtPct > 99) {
		return "warn_at_pct must be 1-99"
	}
	if r.DegradeAtPct != nil && (*r.DegradeAtPct < 1 || *r.DegradeAtPct > 99) {
		return "degrade_at_pct must be 1-99"
	}
	if r.BlockAtPct != nil && (*r.BlockAtPct < 1 || *r.BlockAtPct > 100) {
		return "block_at_pct must be 1-100"
	}
	if r.WarnAtPct != nil && r.DegradeAtPct != nil && r.BlockAtPct != nil {
		if *r.WarnAtPct >= *r.DegradeAtPct || *r.DegradeAtPct > *r.BlockAtPct {
			return "thresholds must satisfy: warn_at_pct < degrade_at_pct <= block_at_pct"
		}
	}
	return ""
}

// PoliciesListHandler handles GET /v1/policies.
//
// @Summary      List policies
// @Description  Returns all token policies
// @Tags         policies
// @Produce      json
// @Success      200  {array}   store.Policy
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/policies [get]
func PoliciesListHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		policies, err := s.GetPolicies(r.Context())
		if err != nil {
			slog.Error("list policies error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(policies)
	}
}

// PolicyCreateHandler handles POST /v1/policies.
//
// @Summary      Create policy
// @Description  Creates a new token policy
// @Tags         policies
// @Accept       json
// @Produce      json
// @Param        policy  body      PolicyRequest  true  "Policy definition"
// @Success      201  {object}  store.Policy
// @Failure      400  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/policies [post]
func PolicyCreateHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req PolicyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if msg := validatePolicyRequest(req); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		policy, err := s.UpsertPolicy(r.Context(), store.Policy{
			Scope: req.Scope, ScopeValue: req.ScopeValue,
			TokenLimit: req.TokenLimit, WarnAtPct: req.WarnAtPct,
			DegradeAtPct: req.DegradeAtPct, DegradeTo: req.DegradeTo,
			BlockAtPct: req.BlockAtPct,
		})
		if err != nil {
			slog.Error("create policy error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(policy)
	}
}

// PolicyUpdateHandler handles PUT /v1/policies/{id}.
//
// @Summary      Update policy
// @Description  Updates an existing token policy
// @Tags         policies
// @Accept       json
// @Produce      json
// @Param        id      path      string         true  "Policy ID"
// @Param        policy  body      PolicyRequest  true  "Policy definition"
// @Success      200  {object}  store.Policy
// @Failure      400  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/policies/{id} [put]
func PolicyUpdateHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "policy id is required")
			return
		}
		// Check if policy exists
		existing, err := s.GetPolicyByID(r.Context(), id)
		if err != nil {
			slog.Error("get policy error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if existing == nil {
			writeError(w, http.StatusNotFound, "policy not found")
			return
		}
		var req PolicyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if msg := validatePolicyRequest(req); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		policy, err := s.UpsertPolicy(r.Context(), store.Policy{
			Scope: req.Scope, ScopeValue: req.ScopeValue,
			TokenLimit: req.TokenLimit, WarnAtPct: req.WarnAtPct,
			DegradeAtPct: req.DegradeAtPct, DegradeTo: req.DegradeTo,
			BlockAtPct: req.BlockAtPct,
		})
		if err != nil {
			slog.Error("update policy error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(policy)
	}
}

// PolicyDeleteHandler handles DELETE /v1/policies/{id}.
//
// @Summary      Delete policy
// @Description  Deletes a token policy
// @Tags         policies
// @Param        id  path  string  true  "Policy ID"
// @Success      204
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/policies/{id} [delete]
func PolicyDeleteHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "policy id is required")
			return
		}
		err := s.DeletePolicy(r.Context(), id)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusNotFound, "policy not found")
				return
			}
			slog.Error("delete policy error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
