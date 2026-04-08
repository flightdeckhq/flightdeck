package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// SyncDirectivesRequest is the request body for POST /v1/directives/sync.
type SyncDirectivesRequest struct {
	Flavor     string   `json:"flavor"`
	Directives []struct {
		Name        string `json:"name"`
		Fingerprint string `json:"fingerprint"`
	} `json:"directives"`
}

// SyncDirectivesResponse is the response for POST /v1/directives/sync.
type SyncDirectivesResponse struct {
	UnknownFingerprints []string `json:"unknown_fingerprints"`
}

// RegisterDirectivesRequest is the request body for POST /v1/directives/register.
type RegisterDirectivesRequest struct {
	Flavor     string                 `json:"flavor"`
	Directives []store.CustomDirective `json:"directives"`
}

// RegisterDirectivesResponse is the response for POST /v1/directives/register.
type RegisterDirectivesResponse struct {
	Registered int `json:"registered"`
}

// CustomDirectivesListResponse is the response for GET /v1/directives/custom.
type CustomDirectivesListResponse struct {
	Directives []store.CustomDirective `json:"directives"`
}

// SyncDirectivesHandler handles POST /v1/directives/sync.
//
// @Summary      Sync custom directive fingerprints
// @Description  Checks which directive fingerprints are registered. Returns fingerprints not found.
// @Tags         custom-directives
// @Accept       json
// @Produce      json
// @Param        body  body      SyncDirectivesRequest  true  "Sync request with flavor and fingerprints"
// @Success      200   {object}  SyncDirectivesResponse
// @Failure      400   {object}  ErrorResponse
// @Failure      500   {object}  ErrorResponse
// @Router       /v1/directives/sync [post]
func SyncDirectivesHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req SyncDirectivesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		if len(req.Directives) == 0 {
			writeError(w, http.StatusBadRequest, "directives array is required")
			return
		}

		fingerprints := make([]string, len(req.Directives))
		for i, d := range req.Directives {
			if d.Fingerprint == "" {
				writeError(w, http.StatusBadRequest, "fingerprint is required for each directive")
				return
			}
			fingerprints[i] = d.Fingerprint
		}

		unknown, err := s.SyncDirectives(r.Context(), fingerprints)
		if err != nil {
			slog.Error("sync directives error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SyncDirectivesResponse{UnknownFingerprints: unknown})
	}
}

// RegisterDirectivesHandler handles POST /v1/directives/register.
//
// @Summary      Register custom directives
// @Description  Registers custom directive definitions. Updates last_seen_at on conflict.
// @Tags         custom-directives
// @Accept       json
// @Produce      json
// @Param        body  body      RegisterDirectivesRequest  true  "Registration request with directives"
// @Success      200   {object}  RegisterDirectivesResponse
// @Failure      400   {object}  ErrorResponse
// @Failure      500   {object}  ErrorResponse
// @Router       /v1/directives/register [post]
func RegisterDirectivesHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req RegisterDirectivesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		if len(req.Directives) == 0 {
			writeError(w, http.StatusBadRequest, "directives array is required")
			return
		}

		// Set flavor from top-level if not set per directive
		for i := range req.Directives {
			if req.Directives[i].Flavor == "" {
				req.Directives[i].Flavor = req.Flavor
			}
			if req.Directives[i].Fingerprint == "" {
				writeError(w, http.StatusBadRequest, "fingerprint is required for each directive")
				return
			}
			if req.Directives[i].Name == "" {
				writeError(w, http.StatusBadRequest, "name is required for each directive")
				return
			}
			if req.Directives[i].Flavor == "" {
				writeError(w, http.StatusBadRequest, "flavor is required for each directive")
				return
			}
		}

		if err := s.RegisterDirectives(r.Context(), req.Directives); err != nil {
			slog.Error("register directives error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(RegisterDirectivesResponse{Registered: len(req.Directives)})
	}
}

// GetCustomDirectivesHandler handles GET /v1/directives/custom.
//
// @Summary      List custom directives
// @Description  Returns all registered custom directives, optionally filtered by flavor.
// @Tags         custom-directives
// @Produce      json
// @Param        flavor  query     string  false  "Filter by flavor"
// @Success      200     {object}  CustomDirectivesListResponse
// @Failure      500     {object}  ErrorResponse
// @Router       /v1/directives/custom [get]
func GetCustomDirectivesHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := r.URL.Query().Get("flavor")

		directives, err := s.GetCustomDirectives(r.Context(), flavor)
		if err != nil {
			slog.Error("get custom directives error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CustomDirectivesListResponse{Directives: directives})
	}
}
