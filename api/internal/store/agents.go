package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// AgentListParams carries every filter, sort, search, and pagination
// option accepted by “GET /v1/agents“. Every slice is OR-within a
// dimension; slices across dimensions are AND. Empty/zero values
// mean "no filter on this dimension".
type AgentListParams struct {
	// Vocabulary filters (handler-level whitelist enforced before
	// reaching the store; the store trusts its caller).
	AgentType  []string // coding | production
	ClientType []string // an id from contracts/client_types.json
	State      []string // active | idle | stale | closed | lost

	// Identity-column filters (free-form).
	Hostname []string
	UserName []string

	// Runtime-context filters (derived from sessions.context JSON
	// via an EXISTS subquery — an agent matches if ANY of their
	// sessions recorded the value).
	//
	// SEMANTIC DIVERGENCE WARNING: this any-session filter
	// semantic differs from the latest-session-only semantic the
	// AgentSummary projection (``OS``, ``Orchestration`` on the
	// response struct) uses. An agent that once ran on Linux but
	// most-recently ran on macOS would be FILTERED-IN by
	// ``?os=Linux`` while its row would render ``os=Darwin``.
	// The /agents page sidebar relies on the response projection
	// and filters client-side, so it never hits this divergence;
	// direct ``/v1/agents?os=...`` callers (other surfaces, ops
	// tooling) get any-session matching. Documented here so
	// neither semantic surprises a future contributor.
	OS            []string
	Orchestration []string

	// Substring search across ``agent_name`` and ``hostname``,
	// case-insensitive. Empty string means no search.
	Search string

	// UpdatedSince filters on ``agents.last_seen_at >= UpdatedSince``.
	// nil means no filter.
	UpdatedSince *time.Time

	// Sort column. One of AllowedAgentSortColumns. Empty string
	// means default (``last_seen_at``). The store returns an
	// ``unknown sort column`` error on an unrecognised value; the
	// handler validates the value before this call so the error
	// is a belt-and-suspenders guard, not the primary 400 path.
	Sort string

	// Order: "asc" or "desc". Empty means default (``desc``).
	Order string

	Limit  int // >=1, <=100; handler enforces
	Offset int // >=0
}

// AllowedAgentSortColumns maps the handler-visible sort name to the
// SQL expression that produces the ordering value. The state column
// is special-cased: it's the rolled-up a.rollup_state (agentFrom), so
// the ORDER BY works off a CASE-over-ordinal wrapper that puts the
// most-engaged state first in DESC ("active > idle > stale > closed >
// lost").
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
	// matches the engagement order ("active > idle > stale > closed >
	// lost", high-to-low) and operator intuition ("sort by
	// state desc = most-engaged agents at the top"). Unknown/empty
	// states sort to 0 so they trail even ``lost`` under DESC.
	"state": `(CASE a.rollup_state ` +
		`WHEN 'active' THEN 5 ` +
		`WHEN 'idle' THEN 4 ` +
		`WHEN 'stale' THEN 3 ` +
		`WHEN 'closed' THEN 2 ` +
		`WHEN 'lost' THEN 1 ` +
		`ELSE 0 END)`,
}

// AgentListResponse is the JSON shape of “GET /v1/agents“.
type AgentListResponse struct {
	Agents  []AgentSummary `json:"agents"`
	Total   int            `json:"total"`
	Limit   int            `json:"limit"`
	Offset  int            `json:"offset"`
	HasMore bool           `json:"has_more"`
}

// ListAgents runs the filtered + sorted + paginated agents query.
// Returns a fully-populated AgentListResponse; “Agents“ is always
// a non-nil slice (empty rather than null in JSON).
//
// Ordering policy. Primary key is the caller-chosen column; secondary
// is always “a.agent_id ASC“ so pages are stable when multiple
// rows tie on the primary. Without a tie-breaker, two pages could
// include the same agent (two adjacent reads of ORDER BY
// last_seen_at DESC silently swap two rows with identical
// last_seen_at on each evaluation).
func (s *Store) ListAgents(
	ctx context.Context, params AgentListParams,
) (*AgentListResponse, error) {
	conds, args := buildAgentFilterClause(s.d, params)

	whereSQL := ""
	if len(conds) > 0 {
		whereSQL = " WHERE " + strings.Join(conds, " AND ")
	}

	// Count query. Uses the same rollup (agentsWithStateSQL) +
	// filters so state filters produce the right total. No
	// LIMIT/OFFSET.
	countQuery := `SELECT COUNT(*) FROM (` + agentsWithStateSQL + `) a` + whereSQL
	var total int
	if err := s.reader().QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count agents: %w", err)
	}

	// Sort + pagination. Resolve sort column (caller should have
	// validated; an unknown value makes a handler bug fail loudly).
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

	selectQuery := s.agentProjection() + agentFrom + whereSQL + `
		ORDER BY ` + sortCol + ` ` + direction + `, a.agent_id ASC
		LIMIT ` + limitPlaceholder + ` OFFSET ` + offsetPlaceholder

	rows, err := s.reader().QueryContext(ctx, selectQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer func() { _ = rows.Close() }()

	result := make([]AgentSummary, 0)
	for rows.Next() {
		a, err := scanAgentSummary(rows)
		if err != nil {
			return nil, fmt.Errorf("scan agent: %w", err)
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
// (nil, nil) when no row matches the id — the caller turns this into
// a 404. Pattern mirrors GetSession.
//
// Sole caller: AgentSummaryHandler, which calls this as a cheap
// existence check before running the expensive summary aggregate so
// the /v1/agents/{id}/summary 404 contract stays exact.
func (s *Store) GetAgentByID(
	ctx context.Context, agentID string,
) (*AgentSummary, error) {
	query := s.agentProjection() + agentFrom + `
		WHERE a.agent_id = $1
		LIMIT 1`

	a, err := scanAgentSummary(s.reader().QueryRowContext(ctx, query, uuidArg(agentID)))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil //nolint:nilnil // "no match" is not an error
		}
		return nil, fmt.Errorf("get agent by id: %w", err)
	}
	return &a, nil
}

// GetAgentState returns the agent's rolled-up state ("active" when any
// of its runs is active, else its most recently started run's state),
// computed by the same agentStateRollupSQL as GetAgentByID and the
// agent list, without their topology and context rollups: the hub
// calls it once per broadcast. An unknown agent yields "".
func (s *Store) GetAgentState(ctx context.Context, agentID string) (string, error) {
	var state string
	err := s.reader().QueryRowContext(ctx, `
		SELECT COALESCE(`+agentStateRollupSQL+`, '')
		FROM agents a
		WHERE a.agent_id = $1`, uuidArg(agentID)).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get agent state %s: %w", agentID, err)
	}
	return state, nil
}

// buildAgentFilterClause produces the WHERE conditions and their
// parameter args for an AgentListParams over the agentFrom row aliased
// a. Returned conds are joined with AND by the caller; each cond uses
// placeholders that match the args slice in order.
//
// Exported for tests so the filter layer can be exercised
// independently of a live database.
func buildAgentFilterClause(d storage.Dialect, params AgentListParams) (conds []string, args []any) {
	addIn := func(col string, values []string) {
		if len(values) == 0 {
			return
		}
		args = append(args, d.ArrayArg(values))
		conds = append(conds, d.InArray(col, fmt.Sprintf("$%d", len(args))))
	}

	addIn("a.agent_type", params.AgentType)
	addIn("a.client_type", params.ClientType)
	addIn("a.user_name", params.UserName)
	addIn("a.hostname", params.Hostname)

	// State is the rolled-up column agentFrom computes.
	addIn("a.rollup_state", params.State)

	// Context-derived filters require an EXISTS subquery on sessions.
	// An agent matches if ANY of its sessions recorded the value
	// (any-session semantics — different from the AgentSummary
	// projection's latest-session semantics; see the divergence
	// docblock on `AgentListParams.OS` for the rationale).
	//
	// SAFETY: ``jsonKey`` is interpolated directly into the SQL
	// because a JSON path cannot be a bound parameter. Every
	// caller below passes a compile-time string constant from the
	// closed key set (``os``, ``orchestration``). NEVER pass user
	// input or a value derived from request data here — that
	// would re-open the SQL injection surface this closure
	// guards against by convention.
	addContextExists := func(jsonKey string, values []string) {
		if len(values) == 0 {
			return
		}
		args = append(args, d.ArrayArg(values))
		conds = append(conds,
			"EXISTS (SELECT 1 FROM sessions s "+
				"WHERE s.agent_id = a.agent_id "+
				"AND "+d.InArray(d.JSONText("s.context", jsonKey), fmt.Sprintf("$%d", len(args)))+")")
	}
	addContextExists("os", params.OS)
	addContextExists("orchestration", params.Orchestration)

	if params.Search != "" {
		args = append(args, sanitizeQuery(params.Search))
		p := fmt.Sprintf("$%d", len(args))
		conds = append(conds, "("+d.ILike("a.agent_name", p)+" OR "+d.ILike("a.hostname", p)+")")
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
