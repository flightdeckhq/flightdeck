package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// DirectiveRequest is the request body for POST /v1/directives.
type DirectiveRequest struct {
	Action        string `json:"action"`
	SessionID     string `json:"session_id,omitempty"`
	Flavor        string `json:"flavor,omitempty"`
	Reason        string `json:"reason,omitempty"`
	GracePeriodMs int    `json:"grace_period_ms,omitempty"`
}

// CreateDirectiveHandler handles POST /v1/directives.
//
// @Summary      Create directive
// @Description  Issues a shutdown directive to a single agent session or all sessions of a flavor
// @Tags         directives
// @Accept       json
// @Produce      json
// @Param        directive  body      DirectiveRequest  true  "Directive definition"
// @Success      201  {object}  store.Directive
// @Failure      400  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/directives [post]
func CreateDirectiveHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
	if r.Action != "shutdown" && r.Action != "shutdown_flavor" {
		return "action must be 'shutdown' or 'shutdown_flavor'"
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
	return ""
}
