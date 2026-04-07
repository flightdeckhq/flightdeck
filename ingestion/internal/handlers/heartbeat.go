package handlers

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
)

// HeartbeatHandler handles POST /v1/heartbeat.
//
// @Summary      Agent heartbeat
// @Description  Validates bearer token, publishes heartbeat to NATS, returns directive envelope
// @Tags         heartbeat
// @Accept       json
// @Produce      json
// @Param        Authorization  header    string  true  "Bearer token"
// @Param        heartbeat      body      object  true  "Heartbeat payload with session_id"
// @Success      200  {object}  map[string]interface{}
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/heartbeat [post]
func HeartbeatHandler(
	validator TokenValidator,
	publisher EventPublisher,
	dirStore DirectiveLookup,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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

		body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodyBytes))
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

		subject := inats.SubjectForEventType("heartbeat")
		if err := publisher.Publish(subject, body); err != nil {
			slog.Error("NATS publish error", "subject", subject, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		// Look up pending directive for this session
		resp := map[string]any{"status": "ok", "directive": nil}
		d, lookupErr := dirStore.LookupPending(r.Context(), sessionID)
		if lookupErr != nil {
			slog.Error("directive lookup error", "session_id", sessionID, "err", lookupErr)
		} else if d != nil {
			resp["directive"] = d
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}
