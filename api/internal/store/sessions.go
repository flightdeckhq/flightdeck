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
// ``key`` MUST come from AllowedContextFilterKeys -- the function
// panics otherwise. Calling with an unvalidated key is a
// programming error, never a user-input path; the handler filters
// unknowns before calling. Panic is preferable to silently
// returning a broken query.
func BuildContextFilterClause(
	key string,
	values []string,
	args []any,
	argIdx int,
) (clause string, nextArgs []any, nextIdx int) {
	if len(values) == 0 {
		return "", args, argIdx
	}
	if !allowedContextFilterSet[key] {
		panic(fmt.Sprintf("BuildContextFilterClause: key %q is not in AllowedContextFilterKeys", key))
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
	return clause, args, argIdx
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

	// Model filter
	if params.Model != "" {
		conditions = append(conditions, fmt.Sprintf("s.model = $%d", argIdx))
		args = append(args, params.Model)
		argIdx++
	}

	// Framework filter: any element of sessions.context->'frameworks'
	// matches any name in the supplied list. The ?| operator requires
	// a text[] right-hand side, so we pass the slice as a single
	// positional arg and cast server-side. A session with a missing
	// or empty frameworks array never matches, which is the intent.
	if len(params.Frameworks) > 0 {
		conditions = append(conditions, fmt.Sprintf(
			"COALESCE(s.context->'frameworks', '[]'::jsonb) ?| $%d::text[]", argIdx,
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
		clause, nextArgs, nextIdx := BuildContextFilterClause(key, values, args, argIdx)
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
			s.token_name
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
			&item.DurationS,
			&item.TokensUsed,
			&item.TokenLimit,
			&contextRaw,
			&item.CaptureEnabled,
			&item.TokenID,
			&item.TokenName,
		); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
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
