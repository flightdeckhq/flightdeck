package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// EventsParams defines filters for bulk event queries.
//
// Before and Order power the drawer's "Show older events" pagination.
// Before is a keyset cursor: when non-zero, only rows with
// occurred_at < Before are returned. Order selects the sort direction
// ("asc" or "desc"); any other value (including empty) falls back to
// ASC for backwards compatibility with existing callers that rely on
// chronological order.
//
// The slice filters (EventTypes, Models, ErrorTypes, …) OR within a
// dimension and AND across dimensions. They back the `/events`
// event-grain facet sidebar. The payload-JSONB filters extract from
// the `events.payload` column; AgentID and Frameworks resolve through
// a `sessions` subquery because the events table carries neither.
type EventsParams struct {
	From       time.Time
	To         time.Time
	Flavor     string
	EventTypes []string
	SessionID  string
	// AgentID scopes the query to every event across all of one
	// agent's runs. The events table has no agent_id column, so the
	// filter resolves through a `sessions` subquery on the indexed
	// `sessions.agent_id`. Empty means no agent scoping.
	AgentID string
	// Event-grain facet filters.
	Models                  []string
	ErrorTypes              []string
	CloseReasons            []string
	EstimatedVia            []string
	MatchedEntryIDs         []string
	OriginatingCallContexts []string
	// MCPServers matches an MCP event's payload `server_name` —
	// the event-grain analogue of the session-grain MCP SERVER
	// facet.
	MCPServers []string
	// Terminal filters on the boolean `payload->>'terminal'`; nil
	// means no terminal filter.
	Terminal *bool
	// Frameworks matches the bare `sessions.framework` OR any entry
	// of the legacy versioned `sessions.context->'frameworks'` array.
	Frameworks []string
	// Query is a free-text ILIKE search powering the `/events` page
	// top-of-page search bar. It matches the events table's
	// `event_type`, `model`, and `session_id` (cast to text), plus
	// the session-level `agent_name` / `framework` resolved through
	// a `sessions` subquery (the events table carries neither).
	// Empty means no free-text filter.
	Query  string
	Before time.Time
	Order  string
	Limit  int
	Offset int
}

// EventsResponse is the paginated response for GET /v1/events.
type EventsResponse struct {
	Events  []Event `json:"events"`
	Total   int     `json:"total"`
	Limit   int     `json:"limit"`
	Offset  int     `json:"offset"`
	HasMore bool    `json:"has_more"`
}

// EventFacetValue is one (value, count) pair in an event-grain facet.
type EventFacetValue struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// EventFacets carries per-dimension chip counts for the `/events`
// facet sidebar, computed over the active filter set. Every slice is
// non-nil on the wire (empty when the dimension has no values).
// `policy_event_type` is not a separate dimension — the dashboard
// derives it by classifying the `event_type` facet.
type EventFacets struct {
	EventType              []EventFacetValue `json:"event_type"`
	Model                  []EventFacetValue `json:"model"`
	Framework              []EventFacetValue `json:"framework"`
	AgentID                []EventFacetValue `json:"agent_id"`
	ErrorType              []EventFacetValue `json:"error_type"`
	CloseReason            []EventFacetValue `json:"close_reason"`
	EstimatedVia           []EventFacetValue `json:"estimated_via"`
	MatchedEntryID         []EventFacetValue `json:"matched_entry_id"`
	OriginatingCallContext []EventFacetValue `json:"originating_call_context"`
	MCPServer              []EventFacetValue `json:"mcp_server"`
	Terminal               []EventFacetValue `json:"terminal"`
}

// facetTopN caps each facet dimension's returned values. The sidebar
// shows the highest-count values; an operator who needs a rarer one
// types it into the filter directly.
const facetTopN = 50

// facetExprAllowlist is the exhaustive set of SQL value expressions
// GetEventFacets may GROUP BY. These are column names and JSONB paths,
// which cannot be bound as query parameters — interpolating an
// out-of-list (e.g. request-derived) expression would be SQL
// injection. Every groupBy / groupBySessionsCol call MUST pass a
// member of this set; a miss fails the request closed.
var facetExprAllowlist = map[string]bool{
	"event_type":                                      true,
	"model":                                           true,
	"payload->'error'->>'error_type'":                 true,
	"payload->>'close_reason'":                        true,
	"payload->>'estimated_via'":                       true,
	"payload->>'originating_call_context'":            true,
	"payload->>'server_name'":                         true,
	"payload->>'terminal'":                            true,
	"payload->'policy_decision'->>'matched_entry_id'": true,
	"s.agent_id::text":                                true,
	"s.framework":                                     true,
}

// buildEventsWhere assembles the shared WHERE clause + args for both
// GetEvents and GetEventFacets so the two never drift. Conditions use
// `$1..$N` placeholders against unqualified `events` columns, so the
// clause embeds directly under `FROM events` (GetEvents) or
// `FROM events <where>` wrapped as a subquery (GetEventFacets).
func buildEventsWhere(params EventsParams) (conditions []string, args []any) {
	argIdx := 1
	addText := func(col string, vals []string) {
		if len(vals) == 0 {
			return
		}
		conditions = append(conditions,
			fmt.Sprintf("%s = ANY($%d::text[])", col, argIdx))
		args = append(args, vals)
		argIdx++
	}

	conditions = append(conditions, fmt.Sprintf("occurred_at >= $%d", argIdx))
	args = append(args, params.From)
	argIdx++

	conditions = append(conditions, fmt.Sprintf("occurred_at <= $%d", argIdx))
	args = append(args, params.To)
	argIdx++

	if params.Flavor != "" {
		conditions = append(conditions, fmt.Sprintf("flavor = $%d", argIdx))
		args = append(args, params.Flavor)
		argIdx++
	}
	if params.SessionID != "" {
		conditions = append(conditions,
			fmt.Sprintf("session_id = $%d::uuid", argIdx))
		args = append(args, params.SessionID)
		argIdx++
	}
	if params.AgentID != "" {
		conditions = append(conditions, fmt.Sprintf(
			"session_id IN (SELECT session_id FROM sessions "+
				"WHERE agent_id = $%d::uuid)", argIdx))
		args = append(args, params.AgentID)
		argIdx++
	}
	addText("event_type", params.EventTypes)
	addText("model", params.Models)
	addText("payload->'error'->>'error_type'", params.ErrorTypes)
	addText("payload->>'close_reason'", params.CloseReasons)
	addText("payload->>'estimated_via'", params.EstimatedVia)
	addText("payload->'policy_decision'->>'matched_entry_id'",
		params.MatchedEntryIDs)
	addText("payload->>'originating_call_context'",
		params.OriginatingCallContexts)
	addText("payload->>'server_name'", params.MCPServers)
	if params.Terminal != nil {
		// Compare as text against the partial index on
		// payload->>'terminal'. A ::boolean cast predicate cannot use
		// that index and turns a corrupt non-boolean payload into a
		// 500 rather than a clean non-match.
		conditions = append(conditions,
			fmt.Sprintf("payload->>'terminal' = $%d", argIdx))
		args = append(args, strconv.FormatBool(*params.Terminal))
		argIdx++
	}
	if len(params.Frameworks) > 0 {
		// Mirrors the /v1/sessions framework filter: match the bare
		// `sessions.framework` name OR any element of the legacy
		// versioned `context->'frameworks'` array. One placeholder,
		// referenced twice.
		conditions = append(conditions, fmt.Sprintf(
			"session_id IN (SELECT session_id FROM sessions "+
				"WHERE framework = ANY($%d::text[]) "+
				"OR COALESCE(context->'frameworks', '[]'::jsonb) "+
				"?| $%d::text[])", argIdx, argIdx))
		args = append(args, params.Frameworks)
		argIdx++
	}
	if params.Query != "" {
		// Free-text search for the `/events` page search bar. Matches
		// the events-table columns directly (event_type, model, and
		// session_id cast to text) and resolves agent_name / framework
		// — neither of which the events table carries — through a
		// sessions subquery. One placeholder, referenced multiple
		// times via %[1]s indexing (same shape as the Frameworks
		// block above). There is no humanized "detail" column to
		// search: the detail string is computed client-side.
		pattern := sanitizeQuery(params.Query)
		qPlaceholder := fmt.Sprintf("$%d", argIdx)
		args = append(args, pattern)
		argIdx++
		conditions = append(conditions, fmt.Sprintf(`(
			event_type ILIKE %[1]s
			OR COALESCE(model, '') ILIKE %[1]s
			OR session_id::text ILIKE %[1]s
			OR session_id IN (
				SELECT session_id FROM sessions
				WHERE COALESCE(agent_name, '') ILIKE %[1]s
				OR COALESCE(framework, '') ILIKE %[1]s
			)
		)`, qPlaceholder))
	}
	if !params.Before.IsZero() {
		conditions = append(conditions,
			fmt.Sprintf("occurred_at < $%d", argIdx))
		args = append(args, params.Before)
		argIdx++
	}
	return conditions, args
}

// GetEvents returns events matching the given filters with pagination.
//
// The COUNT(*) and the data SELECT run inside a single read-only
// REPEATABLE READ transaction so the returned `total` and `events`
// are consistent with the same snapshot. Concurrent inserts cannot
// produce a state where len(events) > total or has_more lies.
//
// HasMore is computed from `Offset + Limit <= total` rather than from
// `Offset + len(events) < total` so the semantics do not depend on
// len(events) equalling Limit at every page boundary. Inside the
// repeatable-read snapshot Total is fixed, so the comparison is exact.
//
// Each returned Event carries the session-level identity attributes
// (framework, client_type, agent_type) via a LEFT JOIN to `sessions`
// on session_id -- the events table stores none of them.
func (s *Store) GetEvents(ctx context.Context, params EventsParams) (*EventsResponse, error) {
	conditions, args := buildEventsWhere(params)

	// Default ASC preserves pre-pagination callers (bulk history loader,
	// Fleet historical events). Only ``desc`` flips the order.
	orderDir := "ASC"
	if strings.EqualFold(params.Order, "desc") {
		orderDir = "DESC"
	}

	where := "WHERE " + strings.Join(conditions, " AND ")

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Count total
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM events %s", where)
	var total int
	if err := tx.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count events: %w", err)
	}

	// Fetch page. The events filter + ORDER/LIMIT/OFFSET run inside a
	// subquery so buildEventsWhere's unqualified column references
	// (flavor, model, session_id, ...) stay unambiguous; the outer
	// LEFT JOIN to `sessions` then projects the session-level identity
	// columns (framework, client_type, agent_type) onto each event
	// row. Pagination runs inside the subquery so only the page's rows
	// are joined. The events.session_id FK guarantees a matching
	// `sessions` row, so LEFT vs INNER is immaterial for real data --
	// LEFT is the defensive choice. ORDER BY is repeated outside the
	// subquery because a join does not preserve the inner ordering.
	limitIdx := len(args) + 1
	querySQL := fmt.Sprintf(`
		SELECT e.id::text, e.session_id::text, e.flavor, e.event_type, e.model,
		       e.tokens_input, e.tokens_output, e.tokens_total,
		       e.tokens_cache_read, e.tokens_cache_creation,
		       e.latency_ms, e.tool_name, e.has_content, e.payload, e.occurred_at,
		       s.framework, s.client_type, s.agent_type
		FROM (
			SELECT * FROM events
			%s
			ORDER BY occurred_at %s
			LIMIT $%d OFFSET $%d
		) e
		LEFT JOIN sessions s ON s.session_id = e.session_id
		ORDER BY e.occurred_at %s
	`, where, orderDir, limitIdx, limitIdx+1, orderDir)
	args = append(args, params.Limit, params.Offset)

	rows, err := tx.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, fmt.Errorf("get events: %w", err)
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var e Event
		var payloadRaw []byte
		if err := rows.Scan(
			&e.ID, &e.SessionID, &e.Flavor, &e.EventType, &e.Model,
			&e.TokensInput, &e.TokensOutput, &e.TokensTotal,
			&e.TokensCacheRead, &e.TokensCacheCreation,
			&e.LatencyMs, &e.ToolName, &e.HasContent, &payloadRaw, &e.OccurredAt,
			&e.Framework, &e.ClientType, &e.AgentType,
		); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		if len(payloadRaw) > 0 {
			var v map[string]any
			if jsonErr := json.Unmarshal(payloadRaw, &v); jsonErr == nil && len(v) > 0 {
				e.Payload = v
			}
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("events scan: %w", err)
	}
	if events == nil {
		events = []Event{}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &EventsResponse{
		Events:  events,
		Total:   total,
		Limit:   params.Limit,
		Offset:  params.Offset,
		HasMore: params.Offset+params.Limit <= total,
	}, nil
}

// GetEventFacets returns per-dimension chip counts for the `/events`
// facet sidebar, computed over the same filter set GetEvents would
// apply. Each dimension is one GROUP BY over the filtered event set;
// agent_id and framework join `sessions`. All run in one read-only
// snapshot so the counts are mutually consistent.
func (s *Store) GetEventFacets(ctx context.Context, params EventsParams) (*EventFacets, error) {
	conditions, args := buildEventsWhere(params)
	where := "WHERE " + strings.Join(conditions, " AND ")
	// The filtered event set, reused by every dimension query.
	filtered := fmt.Sprintf("(SELECT * FROM events %s)", where)

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// groupBy runs one facet GROUP BY: `valueExpr` is the dimension
	// expression evaluated over the filtered event set `f`.
	groupBy := func(valueExpr string) ([]EventFacetValue, error) {
		if !facetExprAllowlist[valueExpr] {
			return nil, fmt.Errorf(
				"facet expression not allowlisted: %q", valueExpr)
		}
		q := fmt.Sprintf(`
			SELECT v, COUNT(*) AS c FROM (
				SELECT %s AS v FROM %s f
			) d
			WHERE v IS NOT NULL AND v <> ''
			GROUP BY v
			ORDER BY c DESC, v ASC
			LIMIT %d
		`, valueExpr, filtered, facetTopN)
		return scanFacet(ctx, tx, q, args)
	}
	// groupBySessionsCol runs a facet GROUP BY over a `sessions`
	// column reached by joining the filtered event set on session_id.
	groupBySessionsCol := func(col string) ([]EventFacetValue, error) {
		if !facetExprAllowlist[col] {
			return nil, fmt.Errorf(
				"facet expression not allowlisted: %q", col)
		}
		q := fmt.Sprintf(`
			SELECT v, COUNT(*) AS c FROM (
				SELECT %s AS v
				FROM %s f
				JOIN sessions s ON s.session_id = f.session_id
			) d
			WHERE v IS NOT NULL AND v <> ''
			GROUP BY v
			ORDER BY c DESC, v ASC
			LIMIT %d
		`, col, filtered, facetTopN)
		return scanFacet(ctx, tx, q, args)
	}

	facets := &EventFacets{}
	var err2 error
	if facets.EventType, err2 = groupBy("event_type"); err2 != nil {
		return nil, err2
	}
	if facets.Model, err2 = groupBy("model"); err2 != nil {
		return nil, err2
	}
	if facets.ErrorType, err2 = groupBy(
		"payload->'error'->>'error_type'"); err2 != nil {
		return nil, err2
	}
	if facets.CloseReason, err2 = groupBy(
		"payload->>'close_reason'"); err2 != nil {
		return nil, err2
	}
	if facets.EstimatedVia, err2 = groupBy(
		"payload->>'estimated_via'"); err2 != nil {
		return nil, err2
	}
	if facets.MatchedEntryID, err2 = groupBy(
		"payload->'policy_decision'->>'matched_entry_id'"); err2 != nil {
		return nil, err2
	}
	if facets.OriginatingCallContext, err2 = groupBy(
		"payload->>'originating_call_context'"); err2 != nil {
		return nil, err2
	}
	if facets.MCPServer, err2 = groupBy(
		"payload->>'server_name'"); err2 != nil {
		return nil, err2
	}
	if facets.Terminal, err2 = groupBy(
		"payload->>'terminal'"); err2 != nil {
		return nil, err2
	}
	if facets.AgentID, err2 = groupBySessionsCol(
		"s.agent_id::text"); err2 != nil {
		return nil, err2
	}
	if facets.Framework, err2 = groupBySessionsCol(
		"s.framework"); err2 != nil {
		return nil, err2
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	return facets, nil
}

func scanFacet(
	ctx context.Context, tx pgx.Tx, query string, args []any,
) ([]EventFacetValue, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("event facet query: %w", err)
	}
	defer rows.Close()
	out := []EventFacetValue{}
	for rows.Next() {
		var fv EventFacetValue
		if err := rows.Scan(&fv.Value, &fv.Count); err != nil {
			return nil, fmt.Errorf("scan event facet: %w", err)
		}
		out = append(out, fv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("event facet rows: %w", err)
	}
	return out, nil
}
