package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// SessionsParams defines filters for paginated session queries.
type SessionsParams struct {
	From time.Time
	// To bounds started_at from above; the zero time leaves the range
	// without an upper bound.
	To      time.Time
	Query   string   // Full-text search (ILIKE across multiple fields)
	States  []string // active, idle, stale, closed, lost
	Flavors []string
	// AgentID filters sessions to one specific agent. The
	// Investigate page surfaces this via the ``agent_id`` URL param
	// and the AGENT sidebar facet. Empty string = no agent filter.
	AgentID string
	// AgentTypes filters sessions by the agent_type column. Locked
	// vocabulary (``coding``, ``production``); other values are
	// accepted but yield empty results.
	AgentTypes []string
	// ClientTypes filters sessions by the denormalized client_type
	// column on sessions (an id from contracts/client_types.json).
	// Handler enforces the CHECK-constraint vocabulary so an invalid
	// value 400s rather than silently matching nothing.
	ClientTypes []string
	// ErrorTypes filters sessions to those that emitted at
	// least one error event (an ``llm_error`` or a failed
	// ``tool_call``, errorEventFilter) whose structured ``error_type``
	// matches one of the listed values. Multi-value OR within. Backed
	// by an EXISTS subquery over the events table, keyed on
	// ``payload->'error'->>'error_type'``. An empty slice means "no
	// error-type filter".
	ErrorTypes []string
	// PolicyEventTypes filters sessions to those that emitted at
	// least one event of the listed policy enforcement types
	// (``policy_warn`` | ``policy_degrade`` | ``policy_block`` |
	// ``policy_mcp_warn`` | ``policy_mcp_block`` |
	// ``mcp_server_name_changed`` | ``mcp_policy_user_remembered``).
	// Multi-value OR within. EXISTS subquery on the events table
	// keyed on ``event_type``; the policy event_type IS the filter
	// dimension (unlike error_types which lives in payload JSONB).
	// Handler validates the vocabulary so an out-of-band value 400s
	// rather than silently matching nothing. Empty slice means "no
	// policy-event-type filter".
	PolicyEventTypes []string
	// Frameworks filters on sessions.context->'frameworks' (JSONB
	// array of strings like "langgraph/1.1.6"). Multi-value: any
	// match across the array passes (``?|`` operator).
	Frameworks []string
	// MCPServers filters sessions to those that connected
	// to at least one MCP server with a matching ``name``. Multi-
	// value OR within. Backed by an EXISTS over jsonb_array_elements
	// of ``sessions.context->'mcp_servers'`` rather than a session
	// column — server identity is stored in the context JSONB on
	// session_start with set-once semantics, parallel to the
	// frameworks[] pattern. Empty slice = no MCP-server filter.
	MCPServers []string
	// Sub-agent observability filters. Each field is independent;
	// passing more than one composes via AND in the WHERE clause so a
	// caller asking for ``?has_sub_agents=true&agent_role=Researcher``
	// gets parents whose Researcher children are visible elsewhere on
	// the page rather than the union.
	//
	// ParentSessionID filters to the children of one specific parent
	// session — used by the Sub-agents tab to fetch the per-parent
	// child list without a context-id-shaped JOIN. Empty string = no
	// filter.
	ParentSessionID string
	// AgentRoles filters by the framework-supplied role string
	// (CrewAI ``Agent.role``, LangGraph node name, Claude Code Task
	// agent_type). Multi-value OR within. Empty slice = no filter.
	AgentRoles []string
	// HasSubAgents (when true) restricts to parent sessions — those
	// referenced as a parent_session_id by at least one other
	// session. EXISTS subquery on sessions self-join.
	HasSubAgents bool
	// IsSubAgent (when true) restricts to child sessions — those
	// whose own parent_session_id is non-null. Cheap WHERE clause.
	IsSubAgent bool
	// IncludeParents (when true) augments the returned page with
	// the parent session of every child session in the page,
	// even if a parent falls outside the time-range filter or
	// the LIMIT window. Pure ordering-tweak knob: the primary
	// page is still computed by the user-supplied Sort + Order +
	// Limit + Offset; the parents ride along so a frontend that
	// derives topology from in-window sessions never sees a
	// "child whose parent fell off the page" gap. Fleet's
	// swimlane sets this; Investigate leaves it false so its
	// pagination math stays exact. Total remains the count of
	// FILTERED rows so callers' pagination UI is unchanged --
	// returned sessions[] may exceed Total when extra parents
	// land in the response.
	IncludeParents bool
	// IncludePureChildren gates the Investigate default scope. When nil
	// the listing returns every session matching the other filters
	// (existing behaviour preserved for any client that doesn't
	// know about the flag). When set to false, excludes pure
	// children — sessions whose parent_session_id is non-null AND
	// no other session references them as parent — leaving
	// parents-with-children + lone sessions in the response. The
	// Investigate page sends false as its default scope; the
	// "Is sub-agent" facet override switches to IsSubAgent=true
	// instead. Pointer-to-bool so omit / explicit-true / explicit-
	// false are three distinct states on the wire.
	IncludePureChildren *bool
	// Operator-actionable enrichment facet filters. Each maps to an
	// EXISTS subquery over the events table keyed on a payload field
	// or specific event_type set. Multi-value entries OR within the
	// dimension; AND composes across dimensions.
	//
	//   * CloseReasons: session_end events whose payload.close_reason
	//     matches any listed value. Closed enum (normal_exit /
	//     directive_shutdown / policy_block / orphan_timeout /
	//     sigkill_detected / unknown).
	//   * EstimatedVias: pre_call/post_call/embeddings events whose
	//     payload.estimated_via matches any listed value. Closed enum
	//     (tiktoken / heuristic / none).
	//   * TerminalOnly: when true, restrict to sessions with at least
	//     one llm_error event whose payload.terminal == "true". Single
	//     bool toggle.
	//   * MatchedEntryIDs: policy_mcp_warn / policy_mcp_block events
	//     whose payload.policy_decision.matched_entry_id matches any
	//     listed value. Free-form (UUIDs).
	//   * OriginatingCallContexts: events whose
	//     payload.originating_call_context matches any listed value.
	//     Vocabulary is the MCP method name (call_tool, read_resource,
	//     list_tools, ...) but free-form so plugin-side variations land.
	CloseReasons            []string
	EstimatedVias           []string
	TerminalOnly            bool
	MatchedEntryIDs         []string
	OriginatingCallContexts []string
	// ContextFilters carries the generic scalar-key filters on
	// sessions.context JSONB (user, os, arch, hostname, process_name,
	// node_version, python_version, git_branch, git_commit, git_repo,
	// orchestration). Each key maps to a list of accepted values; a
	// session passes the filter when its ``context->>'<key>'`` matches
	// any value. Keys outside AllowedContextFilterKeys are rejected by
	// the handler so callers cannot inject arbitrary JSONB paths.
	ContextFilters map[string][]string
	Model          string
	Sort           string // started_at, duration, tokens_used, flavor
	Order          string // asc, desc
	Limit          int
	Offset         int
}

// AllowedContextFilterKeys is the closed whitelist of scalar
// “sessions.context“ JSONB keys that can be used as filters on the
// “/v1/sessions“ endpoint. Restricting the set at both the handler
// and store layer means “context->>'<key>'“ interpolation in the
// WHERE clause cannot be weaponised -- a caller cannot smuggle a
// custom JSONB path through the query string. Keep this list in sync
// with the facet whitelist on the dashboard (Investigate computeFacets)
// and with the ContextFilters TypeScript interface in lib/api.ts.
var AllowedContextFilterKeys = []string{
	"user",
	"os",
	"arch",
	"hostname",
	"process_name",
	"node_version",
	"python_version",
	"git_branch",
	"git_commit",
	"git_repo",
	"orchestration",
}

// allowedContextFilterSet mirrors AllowedContextFilterKeys as a set
// for O(1) membership checks.
var allowedContextFilterSet = func() map[string]bool {
	m := make(map[string]bool, len(AllowedContextFilterKeys))
	for _, k := range AllowedContextFilterKeys {
		m[k] = true
	}
	return m
}()

// IsAllowedContextFilterKey reports whether “key“ is part of the
// scalar filter whitelist. Handler-layer callers use this to reject
// unknown query-string names with a 400 before the param reaches
// the store.
func IsAllowedContextFilterKey(key string) bool {
	return allowedContextFilterSet[key]
}

// BuildContextFilterClause returns the "<context key> IN ($n, ...)"
// WHERE fragment over the sessions row aliased s, plus the extended arg
// list and next placeholder index. Returns "" (empty fragment, unchanged
// args, same idx) when values is empty so callers can unconditionally
// invoke this without filter-counting. The key is read through
// d.JSONText so the fragment is valid on both backends.
//
// key MUST come from AllowedContextFilterKeys. Returns an error rather
// than panicking -- handlers validate the key before calling, but a
// future bug that lets an unvalidated key reach this function would
// otherwise crash the request goroutine. Returning an error lets the
// caller surface a 500 instead. Empty values is a no-op return, not an
// error.
func BuildContextFilterClause(
	d storage.Dialect,
	key string,
	values []string,
	args []any,
	argIdx int,
) (clause string, nextArgs []any, nextIdx int, err error) {
	if len(values) == 0 {
		return "", args, argIdx, nil
	}
	if !allowedContextFilterSet[key] {
		return "", args, argIdx, fmt.Errorf(
			"BuildContextFilterClause: key %q is not in AllowedContextFilterKeys",
			key,
		)
	}
	placeholders := make([]string, len(values))
	for i, v := range values {
		placeholders[i] = fmt.Sprintf("$%d", argIdx)
		args = append(args, v)
		argIdx++
	}
	// key is interpolated (not parameterized) but safe: the allowlist
	// check above rejects any key outside allowedContextFilterSet, so it
	// can never carry caller-controlled input. Never interpolate a key
	// that has not passed that guard. Values are always parameterized.
	clause = fmt.Sprintf(
		"%s IN (%s)",
		d.JSONText("s.context", key), strings.Join(placeholders, ", "),
	)
	return clause, args, argIdx, nil
}

// SessionListItem is one row in the paginated sessions response.
// It includes the full context JSONB so the frontend can extract
// os, hostname, orchestration, git_branch, frameworks without a
// second round-trip.
type SessionListItem struct {
	SessionID string `json:"session_id"`
	Flavor    string `json:"flavor"`
	AgentType string `json:"agent_type"`
	// Agent identity (nullable for lazy-created rows awaiting an
	// authoritative session_start).
	AgentID    *string    `json:"agent_id,omitempty"`
	AgentName  *string    `json:"agent_name,omitempty"`
	ClientType *string    `json:"client_type,omitempty"`
	Host       *string    `json:"host"`
	Model      *string    `json:"model"`
	State      string     `json:"state"`
	StartedAt  time.Time  `json:"started_at"`
	EndedAt    *time.Time `json:"ended_at"`
	// LastSeenAt is the most-recent activity timestamp on the session.
	// For active/idle/stale/lost: max(events.occurred_at), projected
	// through the worker's last_seen_at column. For closed: aligned
	// with ended_at. Drives the Investigate "Last Seen" column
	// (S-TBL-1) and is sortable via ?sort=last_seen_at.
	LastSeenAt     time.Time              `json:"last_seen_at"`
	DurationS      float64                `json:"duration_s"`
	TokensUsed     int                    `json:"tokens_used"`
	TokenLimit     *int64                 `json:"token_limit"`
	Context        map[string]interface{} `json:"context"`
	CaptureEnabled bool                   `json:"capture_enabled"`
	// Attribution for the access_tokens row that opened this
	// session. TokenID is nullable because revocation clears the FK
	// (ON DELETE SET NULL); TokenName is preserved for auditability
	// so the UI can still render "Created via: Staging K8s (revoked)"
	// long after the token row is gone.
	TokenID   *string `json:"token_id"`
	TokenName *string `json:"token_name"`
	// ErrorTypes lists every distinct ``payload->'error'->>'error_type''
	// observed across the session's error events: its ``llm_error``
	// events and its failed ``tool_call`` events (errorEventFilter). Always
	// present on the wire (empty array when the session has no
	// errors) so dashboard code can treat the slice as
	// non-nullable. Mirrors the ``frameworks`` JSONB-array surfacing
	// shape: aggregated server-side via a correlated subquery on the
	// listing query so the dashboard can render the ERROR TYPE facet
	// and the row-level error indicator without a per-session
	// follow-up fetch.
	ErrorTypes []string `json:"error_types"`
	// PolicyEventTypes lists every distinct policy enforcement
	// ``event_type`` observed in the session. Includes both the
	// token-budget axis (``policy_warn`` / ``policy_degrade`` /
	// ``policy_block``) and the MCP Protection Policy axis
	// (``policy_mcp_warn`` / ``policy_mcp_block`` /
	// ``mcp_server_name_changed`` / ``mcp_policy_user_remembered``).
	// Always present on the wire (empty array when the session
	// carries no policy events). Same surfacing pattern as
	// ErrorTypes — correlated subquery on the listing query so the
	// dashboard renders the POLICY + MCP POLICY facets and
	// severity-ranked session-row indicator without a per-session
	// follow-up fetch. The dashboard splits the unified array into
	// two sidebar facets via the EVENT_TYPE_GROUPS classification.
	PolicyEventTypes []string `json:"policy_event_types"`
	// MCPServerNames lists every distinct MCP server name
	// the session connected to, derived at query time from
	// ``sessions.context->'mcp_servers'`` JSONB. Always present on
	// the wire (empty array when the session connected to no MCP
	// server) so dashboard code treats the slice as non-nullable.
	// Names only — the listing payload stays lean; the full
	// fingerprint (transport, version, capabilities, instructions)
	// rides along on the detail endpoint via the existing context
	// envelope. Mirrors the ErrorTypes / PolicyEventTypes shape.
	MCPServerNames []string `json:"mcp_server_names"`
	// MCPErrorTypes lists every distinct
	// ``payload->'error'->>'error_type'`` observed across the
	// session's MCP events (any event_type starting with ``mcp_``
	// whose payload carries an ``error`` object). Always present on
	// the wire (empty array when no MCP event in the session
	// failed). Mirrors the ErrorTypes correlated-subquery pattern,
	// scoped to MCP rather than llm_error rows so the Investigate
	// session-row red MCP indicator can render without a per-session
	// follow-up fetch.
	MCPErrorTypes []string `json:"mcp_error_types"`

	// Per-session aggregates for the operator-actionable enrichment
	// facets. Each field is a distinct-value array (or boolean) over
	// the session's events. Same correlated-subquery pattern as
	// ErrorTypes / PolicyEventTypes so the dashboard renders the
	// new sidebar facets without a per-session follow-up fetch.
	//
	//   * CloseReasons: distinct close_reason values across the
	//     session's session_end events.
	//   * EstimatedViaValues: distinct estimated_via values across
	//     pre_call / post_call / embeddings events.
	//   * HasTerminalError: true when at least one llm_error event
	//     in the session carries terminal=true.
	//   * MatchedEntryIDs: distinct policy_decision.matched_entry_id
	//     values across MCP-policy events.
	//   * OriginatingCallContexts: distinct
	//     payload->>'originating_call_context' values across the
	//     session's events (the MCP method that triggered downstream
	//     activity — call_tool / read_resource / etc.).
	CloseReasons            []string `json:"close_reasons"`
	EstimatedViaValues      []string `json:"estimated_via_values"`
	HasTerminalError        bool     `json:"has_terminal_error"`
	MatchedEntryIDs         []string `json:"matched_entry_ids"`
	OriginatingCallContexts []string `json:"originating_call_contexts"`

	// Sub-agent observability columns. Both nullable, both
	// populated only on sub-agent sessions (Claude Code Task
	// subagent, CrewAI agent execution, LangGraph agent-bearing
	// node). The dashboard's swimlane relationship pill,
	// SessionDrawer Sub-agents tab, Investigate ROLE / PARENT
	// columns and TOPOLOGY / ROLE facets read these directly.
	ParentSessionID *string `json:"parent_session_id,omitempty"`
	AgentRole       *string `json:"agent_role,omitempty"`
	// ChildCount — derived count of
	// sessions whose parent_session_id equals this row's
	// session_id. Always present on the wire (zero on lone agents
	// and on pure children that have no descendants of their
	// own). Surfaced server-side via a correlated subquery on the
	// listing query so the Investigate parent-row pill (``→ N``)
	// renders without a per-row follow-up fetch — same pattern as
	// ErrorTypes / PolicyEventTypes / MCPErrorTypes above. Hits
	// the existing ``sessions_parent_session_id_idx`` partial
	// index.
	ChildCount int `json:"child_count"`
	// AttachmentCount is the number of recorded re-attachments to
	// this session (rows in ``session_attachments`` — the initial
	// session creation is not an attachment, so a run that has only
	// ever run once reports 0). Surfaced via a correlated subquery
	// on the listing query — same pattern as ChildCount — so the
	// agent drawer Runs tab can render its "attached" pill from the
	// listing without a per-row detail fetch.
	AttachmentCount int `json:"attachment_count"`
}

// SessionsResponse is the paginated response for GET /v1/sessions.
type SessionsResponse struct {
	Sessions []SessionListItem `json:"sessions"`
	Total    int               `json:"total"`
	Limit    int               `json:"limit"`
	Offset   int               `json:"offset"`
	HasMore  bool              `json:"has_more"`
}

// sessionListProjection is the SELECT clause used by every
// session-listing query (the paginated page + the parent-include
// follow-up). Built once per store so the two queries can't drift
// apart in column order or COALESCE shape -- the scan loop reads in
// fixed order, so the smallest typo in either copy would silently
// corrupt the read. The distinct-value aggregates are JSON arrays
// (distinctJSONArray) read through jsonStrings.
func (s *Store) sessionListProjection() string {
	d := s.d
	errorType := d.JSONText("e.payload", "error", "error_type")
	estimatedVia := d.JSONText("e.payload", "estimated_via")
	matchedEntry := d.JSONText("e.payload", "policy_decision", "matched_entry_id")
	callContext := d.JSONText("e.payload", "originating_call_context")
	return `
		SELECT
			CAST(s.session_id AS TEXT),
			s.flavor,
			s.agent_type,
			CAST(s.agent_id AS TEXT),
			s.agent_name,
			s.client_type,
			s.host,
			s.model,
			s.state,
			s.started_at,
			s.ended_at,
			s.last_seen_at,
			` + s.durationSQL() + ` AS duration_s,
			s.tokens_used,
			s.token_limit,
			s.context,
			` + captureEnabledSQL("s.session_id") + ` AS capture_enabled,
			CAST(s.token_id AS TEXT),
			s.token_name,
			` + s.distinctJSONArray(errorType, `FROM events e
				WHERE e.session_id = s.session_id
				AND `+s.errorEventFilter()+`
				AND `+errorType+` IS NOT NULL`) + ` AS error_types,
			` + s.distinctJSONArray("e.event_type", `FROM events e
				WHERE e.session_id = s.session_id
				AND e.event_type IN (
					'policy_warn', 'policy_degrade', 'policy_block',
					'policy_mcp_warn', 'policy_mcp_block',
					'mcp_server_name_changed', 'mcp_policy_user_remembered'
				)`) + ` AS policy_event_types,
			` + s.distinctJSONArray(d.JSONText("srv.value", "name"), `FROM `+
		d.JSONArrayElements(d.JSONArray("s.context", "mcp_servers"), "srv")+`
				WHERE `+d.JSONText("srv.value", "name")+` IS NOT NULL`) + ` AS mcp_server_names,
			` + s.distinctJSONArray(errorType, `FROM events e
				WHERE e.session_id = s.session_id
				AND e.event_type LIKE 'mcp\_%' ESCAPE '\'
				AND `+d.JSONTypeOf("e.payload", "error")+` = 'object'
				AND `+errorType+` IS NOT NULL`) + ` AS mcp_error_types,
			` + s.closeReasonsSQL("s.session_id") + ` AS close_reasons,
			` + s.distinctJSONArray(estimatedVia, `FROM events e
				WHERE e.session_id = s.session_id
				AND e.event_type IN ('pre_call', 'post_call', 'embeddings')
				AND `+estimatedVia+` IS NOT NULL`) + ` AS estimated_via_values,
			EXISTS(
				SELECT 1 FROM events e
				WHERE e.session_id = s.session_id
				AND e.event_type = 'llm_error'
				AND ` + d.JSONIsTrue("e.payload", "terminal") + `
			) AS has_terminal_error,
			` + s.distinctJSONArray(matchedEntry, `FROM events e
				WHERE e.session_id = s.session_id
				AND e.event_type IN ('policy_mcp_warn', 'policy_mcp_block')
				AND `+matchedEntry+` IS NOT NULL`) + ` AS matched_entry_ids,
			` + s.distinctJSONArray(callContext, `FROM events e
				WHERE e.session_id = s.session_id
				AND `+callContext+` IS NOT NULL`) + ` AS originating_call_contexts,
			CAST(s.parent_session_id AS TEXT),
			s.agent_role,
			(SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = s.session_id) AS child_count,
			(SELECT COUNT(*) FROM session_attachments sa WHERE sa.session_id = s.session_id) AS attachment_count
		FROM sessions s
`
}

// durationSQL is a session's duration in seconds: until its ended_at,
// or until now for a run still open.
func (s *Store) durationSQL() string {
	return s.d.SecondsBetween("COALESCE(s.ended_at, "+s.d.Now()+")", "s.started_at")
}

// sortExpr resolves a ?sort value to its ORDER BY expression. The
// hostname sort falls back to the context's hostname because the
// sessions.host column is nullable for sessions that predate the sensor
// filling it in; COALESCE keeps the sort stable either way. An unknown
// value falls back to started_at (the handler validates first).
func (s *Store) sortExpr(sort string) string {
	switch sort {
	case "started_at":
		return "s.started_at"
	case "last_seen_at":
		return "s.last_seen_at"
	case "duration":
		return s.durationSQL()
	case "tokens_used":
		return "s.tokens_used"
	case "flavor":
		return "s.flavor"
	case "model":
		return "s.model"
	case "hostname":
		return "COALESCE(s.host, " + s.d.JSONText("s.context", "hostname") + ", '')"
	case "state":
		// State sort uses a custom severity ordinal: ascending
		// orders most-needs-attention first (active → idle → stale →
		// lost → closed). Descending reverses. CASE expression maps
		// each state to its ordinal so ORDER BY uses the lifecycle
		// severity, not alphabetical. Any state outside the documented
		// vocabulary maps to 99 so unexpected rows fall to the bottom
		// regardless of direction.
		return "CASE s.state " +
			"WHEN 'active'  THEN 0 " +
			"WHEN 'idle'    THEN 1 " +
			"WHEN 'stale'   THEN 2 " +
			"WHEN 'lost'    THEN 3 " +
			"WHEN 'closed'  THEN 4 " +
			"ELSE 99 END"
	}
	return "s.started_at"
}

// scanSessionListItem reads one sessionListProjection row.
func scanSessionListItem(row interface{ Scan(dest ...any) error }) (SessionListItem, error) {
	var item SessionListItem
	var contextRaw []byte
	var duration sql.NullFloat64
	var errorTypes, policyEventTypes, mcpServerNames, mcpErrorTypes jsonStrings
	var closeReasons, estimatedVia, matchedEntryIDs, callContexts jsonStrings
	if err := row.Scan(
		&item.SessionID,
		&item.Flavor,
		&item.AgentType,
		&item.AgentID,
		&item.AgentName,
		&item.ClientType,
		&item.Host,
		&item.Model,
		&item.State,
		&item.StartedAt,
		&item.EndedAt,
		&item.LastSeenAt,
		&duration,
		&item.TokensUsed,
		&item.TokenLimit,
		&contextRaw,
		&item.CaptureEnabled,
		&item.TokenID,
		&item.TokenName,
		&errorTypes,
		&policyEventTypes,
		&mcpServerNames,
		&mcpErrorTypes,
		&closeReasons,
		&estimatedVia,
		&item.HasTerminalError,
		&matchedEntryIDs,
		&callContexts,
		&item.ParentSessionID,
		&item.AgentRole,
		&item.ChildCount,
		&item.AttachmentCount,
	); err != nil {
		return item, err
	}
	item.DurationS = duration.Float64
	item.ErrorTypes = errorTypes.strings()
	item.PolicyEventTypes = policyEventTypes.strings()
	item.MCPServerNames = mcpServerNames.strings()
	item.MCPErrorTypes = mcpErrorTypes.strings()
	item.CloseReasons = closeReasons.strings()
	item.EstimatedViaValues = estimatedVia.strings()
	item.MatchedEntryIDs = matchedEntryIDs.strings()
	item.OriginatingCallContexts = callContexts.strings()
	if len(contextRaw) > 0 {
		var v map[string]interface{}
		if jsonErr := json.Unmarshal(contextRaw, &v); jsonErr == nil {
			item.Context = v
		}
	}
	if item.Context == nil {
		item.Context = map[string]interface{}{}
	}
	return item, nil
}

// inList renders "col IN ($n, $n+1, ...)" for values, appending them to
// args, and returns the clause with the updated args and next index.
func inList(col string, values []string, args []any, argIdx int) (string, []any, int) {
	placeholders := make([]string, len(values))
	for i, v := range values {
		placeholders[i] = fmt.Sprintf("$%d", argIdx)
		args = append(args, v)
		argIdx++
	}
	return fmt.Sprintf("%s IN (%s)", col, strings.Join(placeholders, ", ")), args, argIdx
}

// GetSessions returns sessions matching the given filters with pagination.
//
// Follows the same pattern as GetEvents: a read-only snapshot
// transaction wrapping a COUNT(*) and a data SELECT so total and rows
// are consistent within one snapshot.
func (s *Store) GetSessions(ctx context.Context, params SessionsParams) (*SessionsResponse, error) {
	d := s.d
	var conditions []string
	var args []interface{}
	argIdx := 1

	// Time range on started_at
	conditions = append(conditions, fmt.Sprintf("s.started_at >= $%d", argIdx))
	args = append(args, params.From)
	argIdx++

	// A zero To leaves the range without an upper bound.
	if !params.To.IsZero() {
		conditions = append(conditions, fmt.Sprintf("s.started_at <= $%d", argIdx))
		args = append(args, params.To)
		argIdx++
	}

	// Repeatable filters: OR within each group.
	var clause string
	if len(params.States) > 0 {
		clause, args, argIdx = inList("s.state", params.States, args, argIdx)
		conditions = append(conditions, clause)
	}
	if len(params.Flavors) > 0 {
		clause, args, argIdx = inList("s.flavor", params.Flavors, args, argIdx)
		conditions = append(conditions, clause)
	}

	// Single-agent filter. The Investigate page sends this both via
	// URL deep-link and the AGENT sidebar facet click. The id is
	// normalised to the canonical spelling both backends store.
	if params.AgentID != "" {
		conditions = append(conditions, fmt.Sprintf("s.agent_id = $%d", argIdx))
		args = append(args, uuidArg(params.AgentID))
		argIdx++
	}

	if len(params.AgentTypes) > 0 {
		clause, args, argIdx = inList("s.agent_type", params.AgentTypes, args, argIdx)
		conditions = append(conditions, clause)
	}
	// Client-type filter lets the dashboard partition the session
	// table by Claude Code vs. the generic Python sensor.
	if len(params.ClientTypes) > 0 {
		clause, args, argIdx = inList("s.client_type", params.ClientTypes, args, argIdx)
		conditions = append(conditions, clause)
	}

	// Error-type filter. Uses an EXISTS subquery over the
	// events table so "sessions that had a rate_limit error" is the
	// correct predicate, not "sessions whose most-recent event was a
	// rate_limit error". The events table carries one error event
	// (an llm_error or a failed tool_call, errorEventFilter) per
	// error occurrence; the classification lives at
	// payload.error.error_type. Matches the error_types
	// aggregate, so a facet value read off it filters to its sessions.
	errorType := d.JSONText("e.payload", "error", "error_type")
	if len(params.ErrorTypes) > 0 {
		clause, args, argIdx = inList(errorType, params.ErrorTypes, args, argIdx)
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND "+s.errorEventFilter()+" "+
				"AND "+clause+")")
	}

	// Policy-event-type filter. The dimension IS the event_type
	// itself — unlike error_types which is keyed off a payload
	// field — so the subquery filters on e.event_type directly.
	if len(params.PolicyEventTypes) > 0 {
		clause, args, argIdx = inList("e.event_type", params.PolicyEventTypes, args, argIdx)
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND "+clause+")")
	}

	// Model filter
	if params.Model != "" {
		conditions = append(conditions, fmt.Sprintf("s.model = $%d", argIdx))
		args = append(args, params.Model)
		argIdx++
	}

	// Sub-agent observability filters. ParentSessionID,
	// AgentRoles, HasSubAgents, IsSubAgent compose via AND so a
	// caller asking for ``?has_sub_agents=true&agent_role=Researcher``
	// gets the intersection (parents whose Researcher children
	// surface as their own rows) rather than a union. Each branch
	// is independent and skipped when its filter is unset.
	if params.ParentSessionID != "" {
		conditions = append(conditions, fmt.Sprintf(
			"s.parent_session_id = $%d", argIdx,
		))
		args = append(args, uuidArg(params.ParentSessionID))
		argIdx++
	}
	if len(params.AgentRoles) > 0 {
		conditions = append(conditions, d.InArray("s.agent_role", fmt.Sprintf("$%d", argIdx)))
		args = append(args, d.ArrayArg(params.AgentRoles))
		argIdx++
	}
	// TOPOLOGY filters. Single flag → AND'd into the WHERE
	// clause as expected. Both flags set simultaneously → OR'd
	// together (the facet offers both checkboxes at once and reads
	// them as the OR of the two). The OR composition is the union of
	// "is sub-agent" and "has sub-agents", which renders as "any
	// sub-agent relationship" — what an operator scanning the
	// whole sub-agent graph wants. AND'ing both would only match
	// depth-2 nested sub-agents (children that themselves spawn
	// children) which is a rare niche, and would also be the
	// surprising default given the dashboard checkbox UX.
	switch {
	case params.IsSubAgent && params.HasSubAgents:
		conditions = append(conditions,
			"(s.parent_session_id IS NOT NULL OR "+
				"EXISTS (SELECT 1 FROM sessions child "+
				"WHERE child.parent_session_id = s.session_id))")
	case params.IsSubAgent:
		// child sessions only — non-null parent_session_id. Hits the
		// partial index ``sessions_parent_session_id_idx`` directly.
		conditions = append(conditions, "s.parent_session_id IS NOT NULL")
	case params.HasSubAgents:
		// parent sessions only — referenced as a parent_session_id by
		// at least one other session. EXISTS over the same partial
		// index. Operator note: at the data volumes the index covers
		// (sub-agent sessions are a minority of the overall fleet),
		// the planner picks the index lookup; the analytics
		// known performance characteristic of the sub-agent metrics
		// applies to their recursive CTE, not to this filter.
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM sessions child "+
				"WHERE child.parent_session_id = s.session_id)")
	}

	// IncludePureChildren=false
	// excludes pure children (rows whose parent_session_id is set
	// AND who themselves have no descendants). Rendered in SQL as
	// the negation of the pure-child predicate so a row passes
	// when EITHER it's a root (parent_session_id IS NULL) OR it
	// has at least one descendant. AND-composes cleanly with the
	// IsSubAgent / HasSubAgents branches above; the Investigate
	// page's default scope sends IncludePureChildren=false alone,
	// while the "Is sub-agent" facet override sends
	// IsSubAgent=true (omitting IncludePureChildren) so the two
	// don't fight. Pointer-to-bool gates omit-vs-explicit; nil
	// preserves the existing API contract for any caller that
	// doesn't know about the flag.
	if params.IncludePureChildren != nil && !*params.IncludePureChildren {
		conditions = append(conditions,
			"(s.parent_session_id IS NULL OR "+
				"EXISTS (SELECT 1 FROM sessions child "+
				"WHERE child.parent_session_id = s.session_id))")
	}

	// Operator-actionable enrichment facet filters. Each is an
	// EXISTS subquery over events scoped to the right event_type
	// set. Multi-value OR within; AND composes across.
	//
	// Cost shape: ListSessions now runs ~10 EXISTS subqueries
	// against events per call (error_type + policy_event_type +
	// the five new ones, plus the aggregate columns in the SELECT
	// list). All hit events_session_idx so the join key is hot.
	// If the slow-query log surfaces this in production, a partial
	// composite index on (session_id, event_type) WHERE event_type
	// IN ('session_end','llm_error','pre_call','post_call',
	// 'embeddings','policy_mcp_warn','policy_mcp_block') is the
	// cheapest hedge.
	if len(params.CloseReasons) > 0 {
		clause, args, argIdx = inList(d.JSONText("e.payload", "close_reason"), params.CloseReasons, args, argIdx)
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND e.event_type = 'session_end' "+
				"AND "+clause+")")
	}
	if len(params.EstimatedVias) > 0 {
		clause, args, argIdx = inList(d.JSONText("e.payload", "estimated_via"), params.EstimatedVias, args, argIdx)
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND e.event_type IN ('pre_call', 'post_call', 'embeddings') "+
				"AND "+clause+")")
	}
	if params.TerminalOnly {
		// A boolean true or the string "true" in payload.terminal; a
		// malformed or missing terminal field on a non-llm_error row
		// never throws inside the subquery.
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND e.event_type = 'llm_error' "+
				"AND "+d.JSONIsTrue("e.payload", "terminal")+")")
	}
	if len(params.MatchedEntryIDs) > 0 {
		clause, args, argIdx = inList(d.JSONText("e.payload", "policy_decision", "matched_entry_id"), params.MatchedEntryIDs, args, argIdx)
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND e.event_type IN ('policy_mcp_warn', 'policy_mcp_block') "+
				"AND "+clause+")")
	}
	if len(params.OriginatingCallContexts) > 0 {
		clause, args, argIdx = inList(d.JSONText("e.payload", "originating_call_context"), params.OriginatingCallContexts, args, argIdx)
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND "+clause+")")
	}

	// MCP-server filter. Multi-value OR-within: a session
	// passes when its context.mcp_servers list contains at least one
	// entry whose ``name`` matches a supplied value. The aggregation
	// reads sessions.context rather than touching events, so a
	// session that bootstrapped an MCP fingerprint at session_start
	// matches even when no MCP_* events have been emitted yet.
	if len(params.MCPServers) > 0 {
		conditions = append(conditions,
			"EXISTS (SELECT 1 FROM "+d.JSONArrayElements(d.JSONArray("s.context", "mcp_servers"), "srv")+
				" WHERE "+d.InArray(d.JSONText("srv.value", "name"), fmt.Sprintf("$%d", argIdx))+")")
		args = append(args, d.ArrayArg(params.MCPServers))
		argIdx++
	}

	// Framework filter. This filter matches BOTH
	// the new bare-name per-event attribution (``sessions.framework``,
	// populated from ``Session.record_framework``) AND the legacy
	// versioned ``context.frameworks[]`` array. A session's framework
	// is considered a match when:
	//
	//   - the bare name in ``s.framework`` equals one of the supplied
	//     values (e.g. ``langchain``), OR
	//   - any element of ``s.context->'frameworks'`` matches one of
	//     the supplied values (e.g. ``langchain/0.3.27``).
	//
	// The OR-combined filter keeps existing versioned-string callers
	// working while making the new bare-name attribution path
	// queryable too. Consulting only the JSON array would mean a
	// session with ``framework=langchain`` (bare) and an empty
	// context array silently returns empty for any filter
	// value -- the cross-cut bug this clause exists to prevent.
	if len(params.Frameworks) > 0 {
		conditions = append(conditions, "("+s.frameworkMatchSQL("s", fmt.Sprintf("$%d", argIdx))+")")
		args = append(args, d.ArrayArg(params.Frameworks))
		argIdx++
	}

	// Generic scalar-key context filters (user, os, arch, hostname,
	// process_name, node_version, python_version, git_branch,
	// git_commit, git_repo, orchestration). Iterate the allow-list so
	// the clause ordering is stable regardless of Go map iteration
	// order -- easier to read in logs and deterministic for any
	// future snapshot test of the generated SQL.
	for _, key := range AllowedContextFilterKeys {
		values := params.ContextFilters[key]
		clause, nextArgs, nextIdx, fcErr := BuildContextFilterClause(
			d, key, values, args, argIdx,
		)
		if fcErr != nil {
			// Should be unreachable: handlers validate ``key`` against
			// AllowedContextFilterKeys before reaching this code path.
			// Surfacing an internal error rather than panicking means a
			// future bug becomes a 500 with logs, not a goroutine crash.
			return nil, fmt.Errorf(
				"context filter for %q: %w", key, fcErr,
			)
		}
		if clause == "" {
			continue
		}
		conditions = append(conditions, clause)
		args = nextArgs
		argIdx = nextIdx
	}

	// Full-text search across multiple fields
	if params.Query != "" {
		pattern := sanitizeQuery(params.Query)
		q := fmt.Sprintf("$%d", argIdx)
		args = append(args, pattern)
		argIdx++
		like := func(expr string) string { return d.ILike(expr, q) }
		conditions = append(conditions, "("+strings.Join([]string{
			like("s.flavor"),
			like("COALESCE(s.agent_name, '')"),
			like("COALESCE(s.host, '')"),
			like("COALESCE(s.model, '')"),
			like("CAST(s.session_id AS TEXT)"),
			like("COALESCE(" + d.JSONText("s.context", "hostname") + ", '')"),
			like("COALESCE(" + d.JSONText("s.context", "os") + ", '')"),
			like("COALESCE(" + d.JSONText("s.context", "git_branch") + ", '')"),
			like("COALESCE(" + d.JSONText("s.context", "python_version") + ", '')"),
			like("COALESCE(" + d.JSONText("s.context", "frameworks") + ", '')"),
		}, "\n\t\t\tOR ")+")")
	}

	where := "WHERE " + strings.Join(conditions, " AND ")

	// Resolve sort column (validated by handler; fallback defensively)
	sortExpr := s.sortExpr(params.Sort)
	orderDir := "DESC"
	if strings.EqualFold(params.Order, "asc") {
		orderDir = "ASC"
	}

	tx, err := s.readTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Count total
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM sessions s %s", where)
	var total int
	if err := tx.QueryRowContext(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count sessions: %w", err)
	}

	// Fetch page. session_id breaks ties on the sort key so pages are
	// stable, and a NULL sort key (a session without a model) sorts
	// last in either direction: Postgres and SQLite place NULLs at
	// opposite ends by default, so the order is spelled out.
	querySQL := fmt.Sprintf(
		"%s %s\n\tORDER BY %s %s NULLS LAST, s.session_id ASC\n\tLIMIT $%d OFFSET $%d",
		s.sessionListProjection(), where, sortExpr, orderDir, argIdx, argIdx+1,
	)
	args = append(args, params.Limit, params.Offset)

	sessions, err := s.querySessionListItems(ctx, tx, querySQL, args)
	if err != nil {
		return nil, fmt.Errorf("get sessions: %w", err)
	}

	// IncludeParents follow-up: when the caller asked for it (Fleet
	// swimlane today), bring in the parent of every child session in
	// the page so a topology resolver that walks the in-window set
	// never sees a child whose parent fell off the LIMIT cliff. The
	// parent rows ride along regardless of the time-range filter --
	// a child can be brand-new while its parent has been around for
	// hours, and the parent should still resolve.
	if params.IncludeParents && len(sessions) > 0 {
		present := make(map[string]struct{}, len(sessions))
		for _, sess := range sessions {
			present[sess.SessionID] = struct{}{}
		}
		missingParents := make([]string, 0, len(sessions))
		seenParent := make(map[string]struct{})
		for _, sess := range sessions {
			if sess.ParentSessionID == nil {
				continue
			}
			pid := *sess.ParentSessionID
			if pid == "" {
				continue
			}
			if _, ok := present[pid]; ok {
				continue
			}
			if _, ok := seenParent[pid]; ok {
				continue
			}
			seenParent[pid] = struct{}{}
			missingParents = append(missingParents, pid)
		}
		if len(missingParents) > 0 {
			parentSQL := s.sessionListProjection() +
				" WHERE " + d.InUUIDArray("s.session_id", "$1") + " ORDER BY s.started_at DESC, s.session_id ASC"
			parents, err := s.querySessionListItems(ctx, tx, parentSQL, []any{d.ArrayArg(missingParents)})
			if err != nil {
				return nil, fmt.Errorf("get parent sessions: %w", err)
			}
			sessions = append(sessions, parents...)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &SessionsResponse{
		Sessions: sessions,
		Total:    total,
		Limit:    params.Limit,
		Offset:   params.Offset,
		HasMore:  params.Offset+params.Limit <= total,
	}, nil
}

// querySessionListItems runs a sessionListProjection query on tx and
// scans every row; the result is never nil.
func (s *Store) querySessionListItems(ctx context.Context, tx *sql.Tx, query string, args []any) ([]SessionListItem, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	sessions := []SessionListItem{}
	for rows.Next() {
		item, err := scanSessionListItem(rows)
		if err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		sessions = append(sessions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sessions scan: %w", err)
	}
	return sessions, nil
}

// frameworkMatchSQL matches the sessions row aliased alias against the
// framework names in the array bound at param (ArrayArg): the bare
// sessions.framework, or any entry of the legacy versioned
// context.frameworks array.
func (s *Store) frameworkMatchSQL(alias, param string) string {
	d := s.d
	return d.InArray(alias+".framework", param) +
		" OR EXISTS (SELECT 1 FROM " + d.JSONArrayElements(d.JSONArray(alias+".context", "frameworks"), "fwm") +
		" WHERE " + d.InArray(d.JSONElementText("fwm"), param) + ")"
}
