package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
)

const maxRequestBodyBytes = 1 << 20 // 1MB

// Phase 4 timestamp bounds. An event whose ``timestamp`` falls outside
// this window is rejected at the wire boundary with 400. Motivation:
// a sensor whose clock drifts (backwards) can backdate a session so
// the reconciler instantly marks it lost; a sensor whose clock drifts
// (forwards) can freeze a session in active forever because
// ``last_seen_at > NOW()`` trips no staleness condition. Both are
// observable in prod but silent today (D7/D8 in audit-phase-4.md).
//
// Bounds are deliberately generous:
//   maxClockSkewPast  — 48h: covers retry-after-long-outage scenarios,
//                       batch replay, and the E2E ``aged-closed``
//                       fixture (28h old) that lives outside the
//                       swimlane window by design. Anything older is
//                       almost certainly a clock bug rather than a
//                       legitimate backlog.
//   maxClockSkewFuture — 5m: tight enough to catch a forward-drifting
//                         clock, loose enough to absorb ordinary NTP
//                         jitter on a fleet of machines that are not
//                         tightly synchronised.
const (
	maxClockSkewPast   = 48 * time.Hour
	maxClockSkewFuture = 5 * time.Minute
)

// D114 / D115 vocabulary lock, enforced at the wire boundary so a
// non-conforming third-party emitter gets a 400 instead of polluting
// the database. The Python sensor and Claude Code plugin emit these
// values already; the schema's CHECK constraints enforce them at the
// storage layer -- this middleware rejection produces a cleaner
// error message than a Postgres constraint violation surfaced through
// the NATS worker path. See DECISIONS.md D115, D116.
var validAgentTypes = map[string]bool{
	"coding":     true,
	"production": true,
}

var validClientTypes = map[string]bool{
	"claude_code":       true,
	"flightdeck_sensor": true,
}

// uuidRegex matches the canonical 8-4-4-4-12 hex form. Any version
// (v1/v4/v5) and any variant bits are accepted -- the identity
// derivation produces v5 UUIDs and legacy session_ids may be v4, but
// the schema's UUID column rejects malformed values regardless. We
// match both here so the ingestion API returns 400 with a meaningful
// message instead of letting a malformed UUID propagate to the worker
// and FK-violate at INSERT time.
var uuidRegex = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
)

// Session-state admission (closed vs lost vs stale) is enforced on the
// worker side by processor.handleSessionGuard (D105 revive-on-event,
// D106 lazy-create). The ingestion handler intentionally stays
// state-unaware: admitting every event lets a live sensor recover
// from a stale server-side view without the ingestion and worker
// having to share a session-state cache. KI13 resolved.

// TokenValidator resolves bearer tokens to an access_tokens row. The
// resolved (id, name) are injected into the NATS payload for
// session_start events so the worker's UpsertSession can persist them
// onto the new session row (D095).
type TokenValidator interface {
	Validate(ctx context.Context, rawToken string) (auth.ValidationResult, error)
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

		// Auth. Phase 4.5 N-1: error string aligned with the
		// api-side wording in api/internal/auth/token.go for
		// operator-clarity parity.
		token := extractBearerToken(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		result, err := validator.Validate(ctx, token)
		if err != nil {
			slog.Error("token validation error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if !result.Valid {
			reason := result.Reason
			if reason == "" {
				reason = "invalid token"
			}
			writeError(w, http.StatusUnauthorized, reason)
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

		// D10 (Phase 4): reject non-UUID session_ids at the wire
		// boundary. Previously a malformed session_id propagated to
		// the worker and fell over at Postgres's ``::uuid`` cast
		// (SQLSTATE 22P02) with a cryptic redelivery loop. The
		// regex mirrors the agent_id check below; enforcing at the
		// same layer keeps both UUID fields symmetric.
		if !uuidRegex.MatchString(sessionID) {
			writeError(w, http.StatusBadRequest, "session_id must be a canonical UUID")
			return
		}

		// D7/D8 (Phase 4): reject events whose ``timestamp`` falls
		// outside [NOW()-24h, NOW()+5m]. See maxClockSkewPast/Future
		// comment above for motivation. Timestamp is RFC 3339; if
		// the field is missing or not a string we do NOT reject --
		// the worker's Processor.Process substitutes NOW() and
		// proceeds, matching pre-Phase-4 behaviour for older sensors
		// that pre-date timestamp injection.
		if tsRaw, ok := payload["timestamp"].(string); ok && tsRaw != "" {
			ts, terr := time.Parse(time.RFC3339, tsRaw)
			if terr != nil {
				writeError(w, http.StatusBadRequest,
					"timestamp must be RFC 3339 format")
				return
			}
			now := time.Now().UTC()
			// Phase 4.5 M-1: don't reveal the exact validation
			// window in the client-facing message. The previous
			// strings ("more than 24h in the past", "more than 5m
			// in the future") leaked the policy bounds to anyone
			// who could submit an event. Log the precise reason
			// server-side; surface a generic clock-skew error.
			if ts.Before(now.Add(-maxClockSkewPast)) {
				slog.Warn("event timestamp clock-skew (past)",
					"timestamp", tsRaw,
					"now", now.Format(time.RFC3339),
					"max_past", maxClockSkewPast.String(),
					"session_id", sessionID,
				)
				writeError(w, http.StatusBadRequest,
					"timestamp out of allowed clock-skew window; check sensor host clock")
				return
			}
			if ts.After(now.Add(maxClockSkewFuture)) {
				slog.Warn("event timestamp clock-skew (future)",
					"timestamp", tsRaw,
					"now", now.Format(time.RFC3339),
					"max_future", maxClockSkewFuture.String(),
					"session_id", sessionID,
				)
				writeError(w, http.StatusBadRequest,
					"timestamp out of allowed clock-skew window; check sensor host clock")
				return
			}
		}

		// D15 (Phase 4): reject negative token counts. JSON-decoded
		// numbers land as float64 in the map[string]any payload; we
		// inspect only the three fields that carry real LLM usage.
		// Missing values are fine (many events don't carry usage);
		// only an explicit negative trips the reject path.
		for _, key := range []string{"tokens_input", "tokens_output", "tokens_total"} {
			if v, ok := payload[key]; ok && v != nil {
				if n, isNum := v.(float64); isNum && n < 0 {
					writeError(w, http.StatusBadRequest,
						fmt.Sprintf("%s must be >= 0", key))
					return
				}
			}
		}

		// D115 / D116: agent identity validation at the wire boundary.
		// Every event payload must carry a valid agent_id (UUID
		// canonical form), agent_type from the D114 vocabulary, and
		// client_type from the closed set {claude_code,
		// flightdeck_sensor}. Rejecting at ingestion means a
		// misbehaving third-party emitter gets an immediate 400 with
		// a specific message rather than writing junk rows that the
		// dashboard then has to defend against.
		agentID, _ := payload["agent_id"].(string)
		agentType, _ := payload["agent_type"].(string)
		clientType, _ := payload["client_type"].(string)
		if agentID == "" {
			writeError(w, http.StatusBadRequest, "agent_id is required")
			return
		}
		if !uuidRegex.MatchString(agentID) {
			writeError(w, http.StatusBadRequest, "agent_id must be a canonical UUID")
			return
		}
		if !validAgentTypes[agentType] {
			writeError(w, http.StatusBadRequest,
				"agent_type must be one of: coding, production")
			return
		}
		if !validClientTypes[clientType] {
			writeError(w, http.StatusBadRequest,
				"client_type must be one of: claude_code, flightdeck_sensor")
			return
		}

		// On session_start, attach the resolved token id/name so the
		// worker's UpsertSession can persist them onto the new session
		// row (D095). Subsequent events carry no token fields -- a
		// session belongs to whichever token opened it. We re-encode
		// the payload only in the session_start branch to avoid paying
		// the marshal cost on the hot post_call/heartbeat path.
		if eventType == "session_start" && result.ID != "" {
			payload["token_id"] = result.ID
			payload["token_name"] = result.Name
			rebuilt, mErr := json.Marshal(payload)
			if mErr != nil {
				// Phase 4.5 M-10: silent fallback would have dropped
				// token_id/token_name from the worker's UpsertSession
				// (D095), leaving the session row without its owning
				// token. The map was just successfully unmarshaled from
				// `body` so re-marshal can only fail on pathological
				// inputs (NaN/Inf floats). Surface as 500 rather than
				// silently dropping audit fields.
				slog.Error("re-marshal session_start payload with token",
					"session_id", sessionID, "err", mErr,
				)
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			body = rebuilt
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
