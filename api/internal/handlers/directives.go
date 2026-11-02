package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// DirectiveCountHeader is the response header that says how many
// directive rows a POST /v1/directives created: 1 for one session, one
// per session reached for a flavor or an agent. The dashboard reads it
// to say how many runs a stop reached; the CORS middleware exposes it
// so a dashboard served from another origin can read it too.
const DirectiveCountHeader = "X-Directive-Count"

// defaultGracePeriodMs is the grace period of a directive whose request
// names none. It matches the directives.grace_period_ms column default
// and the dashboard's SHUTDOWN_GRACE_PERIOD_MS: time for the agent to
// finish the call in flight before it acts on a stop.
const defaultGracePeriodMs = 5000

// noAgentTargetsMessage answers a directive addressed to an agent none
// of whose live runs can act on it.
const noAgentTargetsMessage = "no live session of this agent can take this directive"

// customPayload is the JSONB payload stored for action="custom" directives.
type customPayload struct {
	DirectiveName string          `json:"directive_name"`
	Fingerprint   string          `json:"fingerprint"`
	Parameters    json.RawMessage `json:"parameters,omitempty" swaggertype:"object"`
}

// DirectiveRequest is the request body for POST /v1/directives.
type DirectiveRequest struct {
	// shutdown, shutdown_flavor or custom.
	Action string `json:"action"`
	// One session to direct (shutdown, custom). Exclusive with agent_id.
	SessionID string `json:"session_id,omitempty"`
	// An agent (UUID) whose live runs that can act on the directive all
	// receive it (shutdown, custom). Exclusive with session_id; not
	// accepted with shutdown_flavor.
	AgentID string `json:"agent_id,omitempty" format:"uuid"`
	// shutdown_flavor: the flavor to stop. custom: every live session of
	// the flavor; with agent_id, keeps the agent's runs of this flavor;
	// with session_id, only narrows the fingerprint check. Empty for
	// shutdown.
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
// @Description  Issues a shutdown or custom directive. Targets: one session (session_id); every live (active or idle) session of a flavor (shutdown_flavor, or custom with flavor); or every live run of an agent that can act on it (agent_id, with shutdown or custom). A run takes a shutdown when its context.supports_directives is true, or when it omits the flag and its client type supports directives by default (a run with no client type does unless it is marked Claude Code). A custom directive also needs a client type that runs custom handlers and a run flavor that registered the fingerprint; with agent_id, an optional flavor keeps the agent's runs of that flavor. A custom directive with session_id goes to that session alone, and a flavor beside it only narrows the fingerprint check. All rows of a fan-out are inserted in one transaction. The body is the last row created, and the X-Directive-Count header says how many were created.
// @Tags         directives
// @Accept       json
// @Produce      json
// @Param        directive  body      DirectiveRequest  true  "Directive definition"
// @Success      201  {object}  store.Directive
// @Header       201  {integer}  X-Directive-Count  "Number of directive rows created: 1 for one session, one per session reached for a flavor or an agent"
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse  "No live session of the flavor or the agent can take the directive"
// @Failure      422  {object}  ErrorResponse  "Unknown custom directive fingerprint"
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
			req.GracePeriodMs = defaultGracePeriodMs
		}

		tmpl := store.Directive{Action: req.Action, GracePeriodMs: req.GracePeriodMs}
		if req.Reason != "" {
			tmpl.Reason = &req.Reason
		}
		if req.Action == "custom" {
			payload, ok := customDirectivePayload(w, r, s, req)
			if !ok {
				return
			}
			tmpl.Payload = payload
		}

		switch {
		case req.SessionID != "":
			// One session. A custom directive's flavor, if any, only
			// narrowed the fingerprint check above.
			tmpl.SessionID = &req.SessionID
			result, err := s.CreateDirective(r.Context(), tmpl)
			if err != nil {
				slog.Error("create directive error", "session_id", req.SessionID, "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			writeDirectivesCreated(w, result, 1)

		case req.AgentID != "":
			// Every live run of the agent that can act on the directive,
			// including runs the dashboard has not loaded. The rows carry
			// no flavor: each is addressed to its own session.
			sessionIDs, err := s.GetDirectiveTargetsForAgent(r.Context(), store.AgentDirectiveTargetQuery{
				AgentID:     req.AgentID,
				Custom:      req.Action == "custom",
				Fingerprint: req.Fingerprint,
				Flavor:      req.Flavor,
			})
			if err != nil {
				slog.Error("get agent directive targets error", "agent_id", req.AgentID, "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			if len(sessionIDs) == 0 {
				writeError(w, http.StatusNotFound, noAgentTargetsMessage)
				return
			}
			createFanOut(w, r, s, tmpl, sessionIDs)

		default:
			// A flavor: shutdown_flavor, or a custom directive by flavor.
			// One row per live session, each naming the flavor too, so
			// each session receives its own directive via the atomic
			// lookup.
			sessionIDs, err := s.GetActiveSessionIDsByFlavor(r.Context(), req.Flavor)
			if err != nil {
				slog.Error("get active sessions error", "flavor", req.Flavor, "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			if len(sessionIDs) == 0 {
				writeError(w, http.StatusNotFound, "no active sessions found for flavor")
				return
			}
			if req.Action == "shutdown_flavor" {
				tmpl.Action = "shutdown"
			}
			tmpl.Flavor = &req.Flavor
			createFanOut(w, r, s, tmpl, sessionIDs)
		}
	}
}

// customDirectivePayload checks that the custom directive's fingerprint
// is registered (under the request's flavor when it names one) and
// builds the payload its rows store. It answers the request itself and
// returns false when the directive cannot be created: without the check
// the dashboard could create rows no sensor can run (the sensor refuses
// unknown fingerprints and fails open).
func customDirectivePayload(w http.ResponseWriter, r *http.Request, s store.Querier, req DirectiveRequest) (*json.RawMessage, bool) {
	exists, err := s.CustomDirectiveExists(r.Context(), req.Fingerprint, req.Flavor)
	if err != nil {
		slog.Error("custom directive exists check error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return nil, false
	}
	if !exists {
		writeError(w, http.StatusUnprocessableEntity, "unknown directive fingerprint")
		return nil, false
	}
	payloadBytes, err := json.Marshal(customPayload{
		DirectiveName: req.DirectiveName,
		Fingerprint:   req.Fingerprint,
		Parameters:    req.Parameters,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal server error")
		return nil, false
	}
	raw := json.RawMessage(payloadBytes)
	return &raw, true
}

// createFanOut inserts one directive per session in one transaction and
// answers 201 with the last row and the count.
func createFanOut(w http.ResponseWriter, r *http.Request, s store.Querier, tmpl store.Directive, sessionIDs []string) {
	rows, err := s.CreateDirectives(r.Context(), tmpl, sessionIDs)
	if err != nil {
		slog.Error("create directives error", "action", tmpl.Action, "sessions", len(sessionIDs), "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if len(rows) == 0 {
		writeError(w, http.StatusInternalServerError, "failed to create directives")
		return
	}
	writeDirectivesCreated(w, &rows[len(rows)-1], len(rows))
}

// writeDirectivesCreated answers 201 with the last directive created and
// how many the request created.
func writeDirectivesCreated(w http.ResponseWriter, last *store.Directive, count int) {
	w.Header().Set(DirectiveCountHeader, strconv.Itoa(count))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(last)
}

func validateDirectiveRequest(r DirectiveRequest) string {
	if r.Action != "shutdown" && r.Action != "shutdown_flavor" && r.Action != "custom" {
		return "action must be 'shutdown', 'shutdown_flavor', or 'custom'"
	}
	if r.AgentID != "" {
		if r.Action == "shutdown_flavor" {
			return "agent_id must be empty when action is 'shutdown_flavor'"
		}
		if !uuidRE.MatchString(r.AgentID) {
			return "agent_id must be a UUID"
		}
		if r.SessionID != "" {
			return "session_id and agent_id are mutually exclusive"
		}
	}
	switch r.Action {
	case "shutdown":
		if r.SessionID == "" && r.AgentID == "" {
			return "session_id or agent_id is required when action is 'shutdown'"
		}
		if r.Flavor != "" {
			return "flavor must be empty when action is 'shutdown'"
		}
	case "shutdown_flavor":
		if r.Flavor == "" {
			return "flavor is required when action is 'shutdown_flavor'"
		}
		if r.SessionID != "" {
			return "session_id must be empty when action is 'shutdown_flavor'"
		}
	case "custom":
		if r.DirectiveName == "" {
			return "directive_name is required when action is 'custom'"
		}
		if r.Fingerprint == "" {
			return "fingerprint is required when action is 'custom'"
		}
		if r.SessionID == "" && r.Flavor == "" && r.AgentID == "" {
			return "session_id, flavor or agent_id is required when action is 'custom'"
		}
	}
	return ""
}
