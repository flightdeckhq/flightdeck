package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// SessionsParams defines filters for paginated session queries.
type SessionsParams struct {
	From    time.Time
	To      time.Time
	Query   string   // Full-text search (ILIKE across multiple fields)
	States  []string // active, idle, stale, closed, lost
	Flavors []string
	// AgentID filters sessions to one specific agent (D115). The
	// Investigate page surfaces this via the ``agent_id`` URL param
	// and the AGENT sidebar facet. Empty string = no agent filter.
	AgentID string
	// AgentTypes filters sessions by the agent_type column. D114
	// vocabulary (``coding``, ``production``); other values are
	// accepted but yield empty results.
	AgentTypes []string
	// ClientTypes filters sessions by the denormalized client_type
	// column on sessions (``claude_code`` | ``flightdeck_sensor``).
	// Handler enforces the CHECK-constraint vocabulary so an invalid
	// value 400s rather than silently matching nothing.
	ClientTypes []string
	// ErrorTypes (Phase 4) filters sessions to those that emitted at
	// least one ``llm_error`` event whose structured ``error_type``
	// matches one of the listed values. Multi-value OR within. Backed
	// by an EXISTS subquery over the events table, keyed on
	// ``payload->'error'->>'error_type'``. An empty slice means "no
	// error-type filter".
	ErrorTypes []string
	// PolicyEventTypes filters sessions to those that emitted at
	// least one event of the listed policy enforcement types
	// (``policy_warn`` | ``policy_degrade`` | ``policy_block``).
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
	// ContextFilters carries the generic scalar-key filters on
	// sessions.context JSONB (user, os, arch, hostname, process_name,
	// node_version, python_version, git_branch, git_commit, git_repo,
	// orchestration). Each key maps to a list of accepted values; a
	// session passes the filter when its ``context->>'<key>'`` matches
	// any value. Keys outside AllowedContextFilterKeys are rejected by
	// the handler so callers cannot inject arbitrary JSONB paths.
	ContextFilters map[string][]string
	Model   string
	Sort    string // started_at, duration, tokens_used, flavor
	Order   string // asc, desc
	Limit   int
	Offset  int
}

// AllowedContextFilterKeys is the closed whitelist of scalar
// ``sessions.context`` JSONB keys that can be used as filters on the
// ``/v1/sessions`` endpoint. Restricting the set at both the handler
// and store layer means ``context->>'<key>'`` interpolation in the
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

// IsAllowedContextFilterKey reports whether ``key`` is part of the
// scalar filter whitelist. Handler-layer callers use this to reject
// unknown query-string names with a 400 before the param reaches
// the store.
func IsAllowedContextFilterKey(key string) bool {
	return allowedContextFilterSet[key]
}

// BuildContextFilterClause returns the ``s.context->>'<key>' IN ($n,
// ...)`` WHERE fragment plus the extended arg list and next placeholder
// index. Returns ``""`` (empty fragment, unchanged args, same idx) when
// ``values`` is empty so callers can unconditionally invoke this
// without filter-counting.
//
// ``key`` MUST come from AllowedContextFilterKeys. M-11 fix: returns
// an error rather than panicking — handlers validate the key before
// calling, but a future bug that lets an unvalidated key reach this
// function would otherwise crash the request goroutine. Returning an
// error lets the caller surface a 500 instead. Empty ``values`` is a
// no-op return, not an error.
func BuildContextFilterClause(
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
	clause = fmt.Sprintf(
		"s.context->>'%s' IN (%s)",
		key, strings.Join(placeholders, ", "),
	)
	return clause, args, argIdx, nil
}

// SessionListItem is one row in the paginated sessions response.
// It includes the full context JSONB so the frontend can extract
// os, hostname, orchestration, git_branch, frameworks without a
// second round-trip.
type SessionListItem struct {
	SessionID      string                 `json:"session_id"`
	Flavor         string                 `json:"flavor"`
	AgentType      string                 `json:"agent_type"`
	// D115 identity (nullable for lazy-created rows awaiting an
	// authoritative session_start).
	AgentID        *string                `json:"agent_id,omitempty"`
	AgentName      *string                `json:"agent_name,omitempty"`
	ClientType     *string                `json:"client_type,omitempty"`
	Host           *string                `json:"host"`
	Model          *string                `json:"model"`
	State          string                 `json:"state"`
	StartedAt      time.Time              `json:"started_at"`
	EndedAt        *time.Time             `json:"ended_at"`
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
	// D095: attribution for the access_tokens row that opened this
	// session. TokenID is nullable because revocation clears the FK
	// (ON DELETE SET NULL); TokenName is preserved for auditability
	// so the UI can still render "Created via: Staging K8s (revoked)"
	// long after the token row is gone.
	TokenID   *string `json:"token_id"`
	TokenName *string `json:"token_name"`
	// ErrorTypes lists every distinct ``payload->'error'->>'error_type''
	// observed across the session's ``llm_error`` events. Always
	// present on the wire (empty array when the session has no
	// errors) so dashboard code can treat the slice as
	// non-nullable. Mirrors the ``frameworks`` JSONB-array surfacing
	// shape: aggregated server-side via a correlated subquery on the
	// listing query so the dashboard can render the ERROR TYPE facet
	// and the row-level error indicator without a per-session
	// follow-up fetch.
	ErrorTypes []string `json:"error_types"`
	// PolicyEventTypes lists every distinct policy enforcement
	// ``event_type`` observed in the session: any subset of
	// ``policy_warn`` / ``policy_degrade`` / ``policy_block``.
	// Always present on the wire (empty array when the session
	// carries no policy events). Same surfacing pattern as
	// ErrorTypes — correlated subquery on the listing query so the
	// dashboard renders the POLICY facet and severity-ranked
	// session-row indicator without a per-session follow-up fetch.
	PolicyEventTypes []string `json:"policy_event_types"`
}

// SessionsResponse is the paginated response for GET /v1/sessions.
type SessionsResponse struct {
	Sessions []SessionListItem `json:"sessions"`
	Total    int               `json:"total"`
	Limit    int               `json:"limit"`
	Offset   int               `json:"offset"`
	HasMore  bool              `json:"has_more"`
}

// allowedSorts prevents SQL injection in the ORDER BY clause.
// v0.4.0 phase 2: added last_seen_at, model, hostname. hostname falls
// back to ``context->>'hostname'`` because the sessions.host column
// is nullable for sessions that predate the sensor filling it in;
// COALESCE keeps the sort stable either way.
var allowedSorts = map[string]string{
	"started_at":   "s.started_at",
	"last_seen_at": "s.last_seen_at",
	"duration":     "EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at))",
	"tokens_used":  "s.tokens_used",
	"flavor":       "s.flavor",
	"model":        "s.model",
	"hostname":     "COALESCE(s.host, s.context->>'hostname', '')",
	// State sort uses a custom severity ordinal (S-TBL-2): ascending
	// orders most-needs-attention first (active → idle → stale → lost
	// → closed). Descending reverses. CASE expression maps each state
	// to its ordinal so ORDER BY uses the lifecycle severity, not
	// alphabetical. Any state outside the documented vocabulary maps
	// to 99 so unexpected rows fall to the bottom regardless of
	// direction.
	"state": "CASE s.state " +
		"WHEN 'active'  THEN 0 " +
		"WHEN 'idle'    THEN 1 " +
		"WHEN 'stale'   THEN 2 " +
		"WHEN 'lost'    THEN 3 " +
		"WHEN 'closed'  THEN 4 " +
		"ELSE 99 END",
}

// GetSessions returns sessions matching the given filters with pagination.
//
// Follows the same pattern as GetEvents: REPEATABLE READ transaction
// wrapping a COUNT(*) and a data SELECT so total and rows are
// consistent within one snapshot.
func (s *Store) GetSessions(ctx context.Context, params SessionsParams) (*SessionsResponse, error) {
	var conditions []string
	var args []interface{}
	argIdx := 1

	// Time range on started_at
	conditions = append(conditions, fmt.Sprintf("s.started_at >= $%d", argIdx))
	args = append(args, params.From)
	argIdx++

	conditions = append(conditions, fmt.Sprintf("s.started_at <= $%d", argIdx))
	args = append(args, params.To)
	argIdx++

	// State filter (repeatable: OR within group)
	if len(params.States) > 0 {
		placeholders := make([]string, len(params.States))
		for i, st := range params.States {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, st)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("s.state IN (%s)", strings.Join(placeholders, ", ")))
	}

	// Flavor filter (repeatable: OR within group)
	if len(params.Flavors) > 0 {
		placeholders := make([]string, len(params.Flavors))
		for i, fl := range params.Flavors {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, fl)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("s.flavor IN (%s)", strings.Join(placeholders, ", ")))
	}

	// Single-agent filter (D115). The Investigate page sends this
	// both via URL deep-link and the AGENT sidebar facet click.
	// Parameterised against the uuid column so a malformed value
	// produces a cast error rather than a bypassed filter.
	if params.AgentID != "" {
		conditions = append(conditions, fmt.Sprintf("s.agent_id = $%d::uuid", argIdx))
		args = append(args, params.AgentID)
		argIdx++
	}

	// Agent-type filter (repeatable: OR within group). Mirrors the
	// flavor filter shape so the handler can just forward the parsed
	// list without special-casing.
	if len(params.AgentTypes) > 0 {
		placeholders := make([]string, len(params.AgentTypes))
		for i, at := range params.AgentTypes {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, at)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("s.agent_type IN (%s)", strings.Join(placeholders, ", ")))
	}

	// Client-type filter (repeatable: OR within group). Added in
	// v0.4.0 phase 2 so the dashboard can partition the session
	// table by Claude Code vs. the generic Python sensor.
	if len(params.ClientTypes) > 0 {
		placeholders := make([]string, len(params.ClientTypes))
		for i, ct := range params.ClientTypes {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, ct)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("s.client_type IN (%s)", strings.Join(placeholders, ", ")))
	}

	// Phase 4: error-type filter. Uses an EXISTS subquery over the
	// events table so "sessions that had a rate_limit error" is the
	// correct predicate, not "sessions whose most-recent event was a
	// rate_limit error". The events table carries one llm_error row
	// per error occurrence; the classification lives at
	// payload->'error'->>'error_type'.
	if len(params.ErrorTypes) > 0 {
		placeholders := make([]string, len(params.ErrorTypes))
		for i, et := range params.ErrorTypes {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, et)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf(
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND e.event_type = 'llm_error' "+
				"AND e.payload->'error'->>'error_type' IN (%s))",
			strings.Join(placeholders, ", "),
		))
	}

	// Policy-event-type filter. The dimension IS the event_type
	// itself — unlike error_types which is keyed off a payload
	// JSONB field — so the subquery filters on
	// ``e.event_type IN (...)`` directly.
	if len(params.PolicyEventTypes) > 0 {
		placeholders := make([]string, len(params.PolicyEventTypes))
		for i, pt := range params.PolicyEventTypes {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, pt)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf(
			"EXISTS (SELECT 1 FROM events e "+
				"WHERE e.session_id = s.session_id "+
				"AND e.event_type IN (%s))",
			strings.Join(placeholders, ", "),
		))
	}

	// Model filter
	if params.Model != "" {
		conditions = append(conditions, fmt.Sprintf("s.model = $%d", argIdx))
		args = append(args, params.Model)
		argIdx++
	}

	// Framework filter. Phase 4 polish: this filter now matches BOTH
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
	// queryable too. Pre-fix the filter only consulted the JSONB
	// array, so a session with ``framework=langchain`` (bare) and an
	// empty context array silently returned empty for any filter
	// value -- the cross-cut bug the supervisor's V-pass addition
	// flagged.
	if len(params.Frameworks) > 0 {
		conditions = append(conditions, fmt.Sprintf(
			"(s.framework = ANY($%d::text[]) "+
				"OR COALESCE(s.context->'frameworks', '[]'::jsonb) ?| $%d::text[])",
			argIdx, argIdx,
		))
		args = append(args, params.Frameworks)
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
			key, values, args, argIdx,
		)
		if fcErr != nil {
			// Should be unreachable: handlers validate ``key`` against
			// AllowedContextFilterKeys before reaching this code path.
			// M-11 surfaces an internal error rather than panicking so a
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
		qPlaceholder := fmt.Sprintf("$%d", argIdx)
		args = append(args, pattern)
		argIdx++
		conditions = append(conditions, fmt.Sprintf(`(
			s.flavor ILIKE %[1]s
			OR COALESCE(s.agent_name, '') ILIKE %[1]s
			OR COALESCE(s.host, '') ILIKE %[1]s
			OR COALESCE(s.model, '') ILIKE %[1]s
			OR s.session_id::text ILIKE %[1]s
			OR COALESCE(s.context->>'hostname', '') ILIKE %[1]s
			OR COALESCE(s.context->>'os', '') ILIKE %[1]s
			OR COALESCE(s.context->>'git_branch', '') ILIKE %[1]s
			OR COALESCE(s.context->>'python_version', '') ILIKE %[1]s
			OR COALESCE((s.context->'frameworks')::text, '') ILIKE %[1]s
		)`, qPlaceholder))
	}

	where := "WHERE " + strings.Join(conditions, " AND ")

	// Resolve sort column (validated by handler; fallback defensively)
	sortExpr, ok := allowedSorts[params.Sort]
	if !ok {
		sortExpr = "s.started_at"
	}
	orderDir := "DESC"
	if strings.EqualFold(params.Order, "asc") {
		orderDir = "ASC"
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Count total
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM sessions s %s", where)
	var total int
	if err := tx.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count sessions: %w", err)
	}

	// Fetch page
	querySQL := fmt.Sprintf(`
		SELECT
			s.session_id::text,
			s.flavor,
			s.agent_type,
			s.agent_id::text,
			s.agent_name,
			s.client_type,
			s.host,
			s.model,
			s.state,
			s.started_at,
			s.ended_at,
			s.last_seen_at,
			EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) AS duration_s,
			s.tokens_used,
			s.token_limit,
			s.context,
			EXISTS(
				SELECT 1 FROM events e
				WHERE e.session_id = s.session_id
				AND e.has_content = true
				LIMIT 1
			) AS capture_enabled,
			s.token_id::text,
			s.token_name,
			COALESCE(
				ARRAY(
					SELECT DISTINCT e.payload->'error'->>'error_type'
					FROM events e
					WHERE e.session_id = s.session_id
					AND e.event_type = 'llm_error'
					AND e.payload->'error'->>'error_type' IS NOT NULL
				),
				ARRAY[]::text[]
			) AS error_types,
			COALESCE(
				ARRAY(
					SELECT DISTINCT e.event_type
					FROM events e
					WHERE e.session_id = s.session_id
					AND e.event_type IN ('policy_warn', 'policy_degrade', 'policy_block')
				),
				ARRAY[]::text[]
			) AS policy_event_types
		FROM sessions s
		%s
		ORDER BY %s %s
		LIMIT $%d OFFSET $%d
	`, where, sortExpr, orderDir, argIdx, argIdx+1)
	args = append(args, params.Limit, params.Offset)

	rows, err := tx.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, fmt.Errorf("get sessions: %w", err)
	}
	defer rows.Close()

	var sessions []SessionListItem
	for rows.Next() {
		var item SessionListItem
		var contextRaw []byte
		if err := rows.Scan(
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
			&item.DurationS,
			&item.TokensUsed,
			&item.TokenLimit,
			&contextRaw,
			&item.CaptureEnabled,
			&item.TokenID,
			&item.TokenName,
			&item.ErrorTypes,
			&item.PolicyEventTypes,
		); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		if item.ErrorTypes == nil {
			item.ErrorTypes = []string{}
		}
		if item.PolicyEventTypes == nil {
			item.PolicyEventTypes = []string{}
		}
		if len(contextRaw) > 0 {
			var v map[string]interface{}
			if jsonErr := json.Unmarshal(contextRaw, &v); jsonErr == nil {
				item.Context = v
			}
		}
		if item.Context == nil {
			item.Context = map[string]interface{}{}
		}
		sessions = append(sessions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sessions scan: %w", err)
	}
	if sessions == nil {
		sessions = []SessionListItem{}
	}

	if err := tx.Commit(ctx); err != nil {
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
