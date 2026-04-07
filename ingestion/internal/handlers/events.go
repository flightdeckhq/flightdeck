package handlers

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/directive"
	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
)

// EventsHandler handles POST /v1/events.
// Validates the bearer token, parses the event payload, publishes to NATS,
// looks up pending directives, and returns the response envelope.
func EventsHandler(
	validator *auth.Validator,
	publisher *inats.Publisher,
	dirStore *directive.Store,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Auth
		token := extractBearerToken(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "missing or invalid authorization")
			return
		}
		valid, err := validator.Validate(ctx, token)
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
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
		if err != nil {
			writeError(w, http.StatusBadRequest, "unable to read request body")
			return
		}

		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		// Validate required fields
		sessionID, _ := payload["session_id"].(string)
		eventType, _ := payload["event_type"].(string)
		if sessionID == "" || eventType == "" {
			writeError(w, http.StatusBadRequest, "session_id and event_type are required")
			return
		}

		// Publish to NATS
		subject := inats.SubjectForEventType(eventType)
		if err := publisher.Publish(subject, body); err != nil {
			slog.Error("NATS publish error", "subject", subject, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		// Look up pending directive
		resp := buildResponse(ctx, dirStore, sessionID)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func buildResponse(ctx context.Context, dirStore *directive.Store, sessionID string) map[string]any {
	resp := map[string]any{
		"status":    "ok",
		"directive": nil,
	}

	d, err := dirStore.LookupPending(ctx, sessionID)
	if err != nil {
		slog.Error("directive lookup error", "session_id", sessionID, "err", err)
		return resp
	}
	if d != nil {
		resp["directive"] = d
	}
	return resp
}

func extractBearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
