package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// customPayload is the JSONB payload stored for action="custom" directives.
type customPayload struct {
	DirectiveName string          `json:"directive_name"`
	Fingerprint   string          `json:"fingerprint"`
	Parameters    json.RawMessage `json:"parameters,omitempty" swaggertype:"object"`
}

// DirectiveRequest is the request body for POST /v1/directives.
type DirectiveRequest struct {
	Action        string          `json:"action"`
	SessionID     string          `json:"session_id,omitempty"`
	Flavor        string          `json:"flavor,omitempty"`
	Reason        string          `json:"reason,omitempty"`
	GracePeriodMs int             `json:"grace_period_ms,omitempty"`
	DirectiveName string          `json:"directive_name,omitempty"`
	Fingerprint   string          `json:"fingerprint,omitempty"`
	Parameters    json.RawMessage `json:"parameters,omitempty" swaggertype:"object"`
}

// CreateDirectiveHandler handles POST /v1/directives.
//
// @Summary      Create directive
// @Description  Issues a shutdown or custom directive to a single agent session or all sessions of a flavor
// @Tags         directives
// @Accept       json
// @Produce      json
// @Param        directive  body      DirectiveRequest  true  "Directive definition"
// @Success      201  {object}  store.Directive
// @Failure      400  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      422  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/directives [post]
func CreateDirectiveHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limitBody(w, r)
		var req DirectiveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		if msg := validateDirectiveRequest(req); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}

		if req.GracePeriodMs <= 0 {
			req.GracePeriodMs = 5000
		}

		// For shutdown_flavor: fan out into one directive per active session
		// so each session receives its own directive via the atomic lookup.
		if req.Action == "shutdown_flavor" {
			sessionIDs, err := s.GetActiveSessionIDsByFlavor(r.Context(), req.Flavor)
			if err != nil {
				slog.Error("get active sessions error", "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			if len(sessionIDs) == 0 {
				writeError(w, http.StatusNotFound, "no active sessions found for flavor")
				return
			}
			var lastResult *store.Directive
			for _, sid := range sessionIDs {
				d := store.Directive{
					Action:        "shutdown",
					GracePeriodMs: req.GracePeriodMs,
					SessionID:     &sid,
				}
				if req.Flavor != "" {
					d.Flavor = &req.Flavor
				}
				if req.Reason != "" {
					d.Reason = &req.Reason
				}
				result, err := s.CreateDirective(r.Context(), d)
				if err != nil {
					slog.Error("create directive error", "session_id", sid, "err", err)
					continue
				}
				lastResult = result
			}
			if lastResult == nil {
				writeError(w, http.StatusInternalServerError, "failed to create directives")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(lastResult)
			return
		}

		// Custom directive: fan out by flavor or target single session
		if req.Action == "custom" {
			// Verify the fingerprint is registered before creating any
			// directive rows. Without this check the dashboard could
			// create dangling directive rows that no sensor can execute
			// (the sensor refuses unknown fingerprints, fail open).
			exists, err := s.CustomDirectiveExists(r.Context(), req.Fingerprint, req.Flavor)
			if err != nil {
				slog.Error("custom directive exists check error", "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			if !exists {
				writeError(w, http.StatusUnprocessableEntity, "unknown directive fingerprint")
				return
			}

			payloadBytes, err := json.Marshal(customPayload{
				DirectiveName: req.DirectiveName,
				Fingerprint:   req.Fingerprint,
				Parameters:    req.Parameters,
			})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			raw := json.RawMessage(payloadBytes)

			if req.Flavor != "" {
				// Fan out to per-session directives (same pattern as shutdown_flavor)
				sessionIDs, err := s.GetActiveSessionIDsByFlavor(r.Context(), req.Flavor)
				if err != nil {
					slog.Error("get active sessions error", "err", err)
					writeError(w, http.StatusInternalServerError, "internal server error")
					return
				}
				if len(sessionIDs) == 0 {
					writeError(w, http.StatusNotFound, "no active sessions found for flavor")
					return
				}
				var lastResult *store.Directive
				for _, sid := range sessionIDs {
					d := store.Directive{
						Action:        "custom",
						GracePeriodMs: req.GracePeriodMs,
						SessionID:     &sid,
						Flavor:        &req.Flavor,
						Payload:       &raw,
					}
					if req.Reason != "" {
						d.Reason = &req.Reason
					}
					result, err := s.CreateDirective(r.Context(), d)
					if err != nil {
						slog.Error("create custom directive error", "session_id", sid, "err", err)
						continue
					}
					lastResult = result
				}
				if lastResult == nil {
					writeError(w, http.StatusInternalServerError, "failed to create directives")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(w).Encode(lastResult)
				return
			}

			// Single session custom directive
			d := store.Directive{
				Action:        "custom",
				GracePeriodMs: req.GracePeriodMs,
				SessionID:     &req.SessionID,
				Payload:       &raw,
			}
			if req.Reason != "" {
				d.Reason = &req.Reason
			}
			result, err := s.CreateDirective(r.Context(), d)
			if err != nil {
				slog.Error("create custom directive error", "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(result)
			return
		}

		// Single session shutdown
		d := store.Directive{
			Action:        req.Action,
			GracePeriodMs: req.GracePeriodMs,
		}
		if req.SessionID != "" {
			d.SessionID = &req.SessionID
		}
		if req.Reason != "" {
			d.Reason = &req.Reason
		}

		result, err := s.CreateDirective(r.Context(), d)
		if err != nil {
			slog.Error("create directive error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(result)
	}
}

func validateDirectiveRequest(r DirectiveRequest) string {
	if r.Action != "shutdown" && r.Action != "shutdown_flavor" && r.Action != "custom" {
		return "action must be 'shutdown', 'shutdown_flavor', or 'custom'"
	}
	if r.Action == "shutdown" {
		if r.SessionID == "" {
			return "session_id is required when action is 'shutdown'"
		}
		if r.Flavor != "" {
			return "flavor must be empty when action is 'shutdown'"
		}
	}
	if r.Action == "shutdown_flavor" {
		if r.Flavor == "" {
			return "flavor is required when action is 'shutdown_flavor'"
		}
		if r.SessionID != "" {
			return "session_id must be empty when action is 'shutdown_flavor'"
		}
	}
	if r.Action == "custom" {
		if r.DirectiveName == "" {
			return "directive_name is required when action is 'custom'"
		}
		if r.Fingerprint == "" {
			return "fingerprint is required when action is 'custom'"
		}
		if r.SessionID == "" && r.Flavor == "" {
			return "session_id or flavor is required when action is 'custom'"
		}
	}
	return ""
}
