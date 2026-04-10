package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
)

const maxRequestBodyBytes = 1 << 20 // 1MB

// TODO(KI13)[Phase 5]: Ingestion accepts events for closed and lost
// sessions. The handler does not check the session's terminal state
// before publishing to NATS, so a sensor (or a buggy test) can keep
// posting events to a session that has already received session_end.
// The dashboard then renders circles past the END marker.
// Fix: query the worker-side session state cache before publishing,
// and reject events with HTTP 409 when the session is closed/lost.
// See KNOWN_ISSUES.md KI13.

// TokenValidator validates bearer tokens against stored hashes.
type TokenValidator interface {
	Validate(ctx context.Context, rawToken string) (bool, error)
}

// EventPublisher publishes event payloads to the message queue.
type EventPublisher interface {
	Publish(subject string, data []byte) error
}

// DirectiveLookup finds pending directives for a given session.
type DirectiveLookup interface {
	LookupPending(ctx context.Context, sessionID string) (*DirectiveResponse, error)
}

// DirectiveResponse represents the directive payload returned in the response envelope.
type DirectiveResponse struct {
	ID            string  `json:"id"`
	Action        string  `json:"action"`
	Reason        string  `json:"reason"`
	DegradeTo     *string `json:"degrade_to,omitempty"`
	GracePeriodMs int     `json:"grace_period_ms"`
}

// EventResponse is the response envelope for POST /v1/events.
type EventResponse struct {
	Status    string             `json:"status"`
	Directive *DirectiveResponse `json:"directive,omitempty"`
}

// EventsHandler handles POST /v1/events.
//
// @Summary      Submit agent event
// @Description  Validates bearer token, publishes event to NATS, returns directive envelope
// @Tags         events
// @Accept       json
// @Produce      json
// @Param        Authorization  header    string  true  "Bearer token"
// @Param        event          body      object  true  "Event payload"
// @Success      200  {object}  EventResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      429  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/events [post]
func EventsHandler(
	validator TokenValidator,
	publisher EventPublisher,
	dirStore DirectiveLookup,
	limiter *RateLimiter,
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

		// Rate limit
		if limiter != nil {
			allowed, retryAfter := limiter.Allow(token)
			if !allowed {
				w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
				writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
				return
			}
		}

		// Parse body
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

func buildResponse(ctx context.Context, dirStore DirectiveLookup, sessionID string) map[string]any {
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
