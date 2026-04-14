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

// SessionAttacher reports whether a session_start event is attaching
// to a pre-existing session row, and (for terminal rows) revives the
// row synchronously so the sensor's next event lands on state=active.
// See ingestion/internal/session/store.go and DECISIONS.md D094.
type SessionAttacher interface {
	Attach(ctx context.Context, sessionID string) (attached bool, priorState string, err error)
}

// DirectiveResponse represents the directive payload returned in the response envelope.
//
// Payload is a JSONB blob carrying action-specific data -- for action="custom"
// it contains directive_name / fingerprint / parameters which the sensor's
// DirectivePayloadSchema validates before dispatching to the registered
// handler. It must be projected through from directive.Directive in the
// adapter; previously the adapter dropped it, leaving the sensor with an
// empty payload and a Pydantic validation error on every custom directive.
// Phase 4.5 audit B-F fix.
type DirectiveResponse struct {
	ID            string           `json:"id"`
	Action        string           `json:"action"`
	Reason        string           `json:"reason"`
	DegradeTo     *string          `json:"degrade_to,omitempty"`
	GracePeriodMs int              `json:"grace_period_ms"`
	Payload       *json.RawMessage `json:"payload,omitempty" swaggertype:"object"`
}

// EventResponse is the response envelope for POST /v1/events.
//
// Attached surfaces the D094 backend-attachment decision to the sensor.
// It is set exclusively on session_start responses (non-session_start
// event types always return Attached=false). When true, the sensor's
// Session._post_event logs a single INFO line so operators can trace
// which agent executions reused a prior session_id.
type EventResponse struct {
	Status    string             `json:"status"`
	Directive *DirectiveResponse `json:"directive,omitempty"`
	Attached  bool               `json:"attached"`
}

// EventsHandler handles POST /v1/events.
//
// @Summary      Submit agent event
// @Description  Validates bearer token, publishes event to NATS, returns directive envelope. On session_start events, also reports whether the session was attached to a pre-existing row (D094).
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
	sessAttacher SessionAttacher,
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

		// Synchronous session-attachment check for session_start.
		// Runs BEFORE NATS publish so that the decision is locked in
		// the moment the ingestion API commits to the response -- a
		// worker that hasn't yet consumed the event cannot change
		// what we already told the sensor. For any non-session_start
		// event type, attached is forced to false (D094: "Only
		// session_start responses carry attached=true").
		//
		// On DB error we log and fall through with attached=false
		// rather than failing the request: the attach flag is
		// informational, the event payload itself must still flow to
		// the worker.
		attached := false
		if eventType == "session_start" && sessAttacher != nil {
			att, priorState, err := sessAttacher.Attach(ctx, sessionID)
			if err != nil {
				slog.Error("session attach lookup failed",
					"session_id", sessionID,
					"err", err,
				)
			} else {
				attached = att
				if att && (priorState == "closed" || priorState == "lost") {
					slog.Info("session revived",
						"session_id", sessionID,
						"prior_state", priorState,
					)
				}
			}
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
		resp["attached"] = attached

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
