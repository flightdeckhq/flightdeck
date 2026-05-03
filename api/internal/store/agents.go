package store

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// AgentListParams carries every filter, sort, search, and pagination
// option accepted by ``GET /v1/agents``. Every slice is OR-within a
// dimension; slices across dimensions are AND. Empty/zero values
// mean "no filter on this dimension".
type AgentListParams struct {
	// Vocabulary filters (handler-level whitelist enforced before
	// reaching the store; the store trusts its caller).
	AgentType  []string // coding | production
	ClientType []string // claude_code | flightdeck_sensor
	State      []string // active | idle | stale | closed | lost

	// Identity-column filters (free-form).
	Hostname []string
	UserName []string

	// Runtime-context filters (derived from sessions.context JSONB
	// via an EXISTS subquery — an agent matches if ANY of their
	// sessions recorded the value).
	OS            []string
	Orchestration []string

	// Substring search across ``agent_name`` and ``hostname``. ILIKE
	// '%'||q||'%'; case-insensitive. Empty string means no search.
	Search string

	// UpdatedSince filters on ``agents.last_seen_at >= UpdatedSince``.
	// nil means no filter.
	UpdatedSince *time.Time

	// Sort column. One of AllowedAgentSortColumns. Empty string
	// means default (``last_seen_at``). The store panics on an
	// unknown value; the handler is responsible for the 400.
	Sort string

	// Order: "asc" or "desc". Empty means default (``desc``).
	Order string

	Limit  int // >=1, <=100; handler enforces
	Offset int // >=0
}

// AllowedAgentSortColumns maps the handler-visible sort name to the
// SQL expression that produces the ordering value. The state column
// is special-cased: it's LATERAL-computed, so the ORDER BY works off
// a CASE-over-ordinal wrapper that puts the most-engaged state first
// in DESC ("active > idle > stale > closed > lost").
var AllowedAgentSortColumns = map[string]string{
	"last_seen_at":   "a.last_seen_at",
	"first_seen_at":  "a.first_seen_at",
	"agent_name":     "a.agent_name",
	"total_sessions": "a.total_sessions",
	"total_tokens":   "a.total_tokens",
	"user":           "a.user_name",
	"hostname":       "a.hostname",
	// state ordinal: active=5 (highest), idle=4, stale=3, closed=2,
	// lost=1 (lowest). Encoded so that DESC puts active first —
	// matches the plan's Q4 lock ("active > idle > stale > closed >
	// lost" ordered high-to-low) and operator intuition ("sort by
	// state desc = most-engaged agents at the top"). Unknown/empty
	// states sort to 0 so they trail even ``lost`` under DESC.
	"state": `(CASE rollup.state ` +
		`WHEN 'active' THEN 5 ` +
		`WHEN 'idle' THEN 4 ` +
		`WHEN 'stale' THEN 3 ` +
		`WHEN 'closed' THEN 2 ` +
		`WHEN 'lost' THEN 1 ` +
		`ELSE 0 END)`,
}

// AgentListResponse is the JSON shape of ``GET /v1/agents``.
type AgentListResponse struct {
	Agents  []AgentSummary `json:"agents"`
	Total   int            `json:"total"`
	Limit   int            `json:"limit"`
	Offset  int            `json:"offset"`
	HasMore bool           `json:"has_more"`
}

// ListAgents runs the filtered + sorted + paginated agents query.
// Returns a fully-populated AgentListResponse; ``Agents`` is always
// a non-nil slice (empty rather than null in JSON).
//
// Ordering policy. Primary key is the caller-chosen column; secondary
// is always ``a.agent_id ASC`` so pages are stable when multiple
// rows tie on the primary. Without a tie-breaker, two pages could
// include the same agent (two adjacent reads of ORDER BY
// last_seen_at DESC silently swap two rows with identical
// last_seen_at on each evaluation).
func (s *Store) ListAgents(
	ctx context.Context, params AgentListParams,
) (*AgentListResponse, error) {
	conds, args := buildAgentFilterClause(params)

	// The LATERAL state rollup mirrors GetAgentFleet's shape so the
	// state column is available for both WHERE filtering and
	// ORDER BY expressions. Keeping the two queries in lock-step on
	// the rollup shape prevents drift between fleet-overview and
	// agents-list state semantics.
	rollupSQL := `
		LEFT JOIN LATERAL (
			SELECT CASE
				WHEN EXISTS (
					SELECT 1 FROM sessions s
					WHERE s.agent_id = a.agent_id AND s.state = 'active'
				) THEN 'active'
				ELSE (
					SELECT s.state
					FROM sessions s
					WHERE s.agent_id = a.agent_id
					ORDER BY s.started_at DESC
					LIMIT 1
				)
			END AS state
		) rollup ON TRUE`

	whereSQL := ""
	if len(conds) > 0 {
		whereSQL = " WHERE " + strings.Join(conds, " AND ")
	}

	// Count query. Uses the same rollup + filters so state filters
	// produce the right total. No LIMIT/OFFSET.
	countQuery := `SELECT COUNT(*) FROM agents a` + rollupSQL + whereSQL
	var total int
	if err := s.pool.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count agents: %w", err)
	}

	// Sort + pagination. Resolve sort column (caller should have
	// validated; panic on unknown makes a handler bug fail loudly).
	sortCol, ok := AllowedAgentSortColumns[normaliseSort(params.Sort)]
	if !ok {
		return nil, fmt.Errorf("unknown sort column %q", params.Sort)
	}
	direction := "DESC"
	if strings.ToLower(params.Order) == "asc" {
		direction = "ASC"
	}

	limit := params.Limit
	if limit <= 0 {
		limit = 25
	}
	offset := params.Offset
	if offset < 0 {
		offset = 0
	}

	args = append(args, limit, offset)
	limitPlaceholder := fmt.Sprintf("$%d", len(args)-1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args))

	selectQuery := `
		SELECT
			a.agent_id::text, a.agent_name, a.agent_type, a.client_type,
			a.user_name, a.hostname, a.first_seen_at, a.last_seen_at,
			a.total_sessions, a.total_tokens,
			COALESCE(rollup.state, '') AS state,
			d126.agent_role,
			d126.topology
		FROM agents a` + rollupSQL + `
		LEFT JOIN LATERAL (` + d126AgentRollupSQL + `) d126 ON TRUE` + whereSQL + `
		ORDER BY ` + sortCol + ` ` + direction + `, a.agent_id ASC
		LIMIT ` + limitPlaceholder + ` OFFSET ` + offsetPlaceholder

	rows, err := s.pool.Query(ctx, selectQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer rows.Close()

	result := make([]AgentSummary, 0)
	for rows.Next() {
		var a AgentSummary
		var rollupState *string
		var topology *string
		if err := rows.Scan(
			&a.AgentID, &a.AgentName, &a.AgentType, &a.ClientType,
			&a.UserName, &a.Hostname, &a.FirstSeenAt, &a.LastSeenAt,
			&a.TotalSessions, &a.TotalTokens, &rollupState,
			&a.AgentRole, &topology,
		); err != nil {
			return nil, fmt.Errorf("scan agent: %w", err)
		}
		if rollupState != nil {
			a.State = *rollupState
		}
		if topology != nil {
			a.Topology = *topology
		} else {
			a.Topology = "lone"
		}
		result = append(result, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agents: %w", err)
	}

	return &AgentListResponse{
		Agents:  result,
		Total:   total,
		Limit:   limit,
		Offset:  offset,
		HasMore: offset+limit < total,
	}, nil
}

// GetAgentByID returns a single agent with its rollup state. Returns
// (nil, nil) when no row matches the id — handler turns this into a
// 404. Returns (nil, err) on malformed UUID (Postgres surfaces the
// cast error; handler maps that to a 400). Pattern mirrors
// GetSession.
func (s *Store) GetAgentByID(
	ctx context.Context, agentID string,
) (*AgentSummary, error) {
	query := `
		SELECT
			a.agent_id::text, a.agent_name, a.agent_type, a.client_type,
			a.user_name, a.hostname, a.first_seen_at, a.last_seen_at,
			a.total_sessions, a.total_tokens,
			COALESCE(rollup.state, '') AS state,
			d126.agent_role,
			d126.topology
		FROM agents a
		LEFT JOIN LATERAL (
			SELECT CASE
				WHEN EXISTS (
					SELECT 1 FROM sessions s
					WHERE s.agent_id = a.agent_id AND s.state = 'active'
				) THEN 'active'
				ELSE (
					SELECT s.state
					FROM sessions s
					WHERE s.agent_id = a.agent_id
					ORDER BY s.started_at DESC
					LIMIT 1
				)
			END AS state
		) rollup ON TRUE
		LEFT JOIN LATERAL (` + d126AgentRollupSQL + `) d126 ON TRUE
		WHERE a.agent_id = $1::uuid
		LIMIT 1`

	var a AgentSummary
	var rollupState *string
	var topology *string
	err := s.pool.QueryRow(ctx, query, agentID).Scan(
		&a.AgentID, &a.AgentName, &a.AgentType, &a.ClientType,
		&a.UserName, &a.Hostname, &a.FirstSeenAt, &a.LastSeenAt,
		&a.TotalSessions, &a.TotalTokens, &rollupState,
		&a.AgentRole, &topology,
	)
	if err != nil {
		// pgx returns ErrNoRows as a sentinel; bubble up so the
		// caller can map 404 vs "real error" (cast failure, etc.).
		if strings.Contains(err.Error(), "no rows in result set") {
			return nil, nil //nolint:nilnil // "no match" is not an error
		}
		return nil, fmt.Errorf("get agent by id: %w", err)
	}
	if rollupState != nil {
		a.State = *rollupState
	}
	if topology != nil {
		a.Topology = *topology
	} else {
		a.Topology = "lone"
	}
	return &a, nil
}

// buildAgentFilterClause produces the WHERE conditions and their
// parameter args for an AgentListParams. Returned conds are joined
// with AND by the caller; each cond uses placeholders that match the
// args slice in order.
//
// Exported for tests so the filter layer can be exercised
// independently of a live Postgres.
func buildAgentFilterClause(params AgentListParams) (conds []string, args []any) {
	addIn := func(col string, values []string) {
		if len(values) == 0 {
			return
		}
		args = append(args, values)
		conds = append(conds, fmt.Sprintf("%s = ANY($%d::text[])", col, len(args)))
	}

	addIn("a.agent_type", params.AgentType)
	addIn("a.client_type", params.ClientType)
	addIn("a.user_name", params.UserName)
	addIn("a.hostname", params.Hostname)

	// State is LATERAL-computed; filter lives on the rollup alias.
	if len(params.State) > 0 {
		args = append(args, params.State)
		conds = append(conds,
			fmt.Sprintf("rollup.state = ANY($%d::text[])", len(args)))
	}

	// Context-derived filters require an EXISTS subquery on sessions.
	// An agent matches if ANY of its sessions recorded the value.
	addContextExists := func(jsonKey string, values []string) {
		if len(values) == 0 {
			return
		}
		args = append(args, values)
		conds = append(conds, fmt.Sprintf(
			"EXISTS (SELECT 1 FROM sessions s "+
				"WHERE s.agent_id = a.agent_id "+
				"AND s.context->>'%s' = ANY($%d::text[]))",
			jsonKey, len(args),
		))
	}
	addContextExists("os", params.OS)
	addContextExists("orchestration", params.Orchestration)

	if params.Search != "" {
		args = append(args, "%"+params.Search+"%")
		conds = append(conds, fmt.Sprintf(
			"(a.agent_name ILIKE $%d OR a.hostname ILIKE $%d)",
			len(args), len(args),
		))
	}

	if params.UpdatedSince != nil {
		args = append(args, *params.UpdatedSince)
		conds = append(conds, fmt.Sprintf("a.last_seen_at >= $%d", len(args)))
	}

	return conds, args
}

func normaliseSort(s string) string {
	if s == "" {
		return "last_seen_at"
	}
	return s
}
