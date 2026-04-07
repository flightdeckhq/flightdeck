package handlers

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
)

// HeartbeatHandler handles POST /v1/heartbeat.
// Validates the bearer token, publishes heartbeat to NATS.
func HeartbeatHandler(
	validator *auth.Validator,
	publisher *inats.Publisher,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Auth
		token := extractBearerToken(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "missing or invalid authorization")
			return
		}
		valid, err := validator.Validate(r.Context(), token)
		if err != nil {
			slog.Error("token validation error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if !valid {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}

		// Parse body
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeError(w, http.StatusBadRequest, "unable to read request body")
			return
		}

		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		sessionID, _ := payload["session_id"].(string)
		if sessionID == "" {
			writeError(w, http.StatusBadRequest, "session_id is required")
			return
		}

		// Publish heartbeat
		subject := inats.SubjectForEventType("heartbeat")
		if err := publisher.Publish(subject, body); err != nil {
			slog.Error("NATS publish error", "subject", subject, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}
