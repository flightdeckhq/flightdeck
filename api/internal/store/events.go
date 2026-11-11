package store

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// EventsParams defines filters for bulk event queries.
//
// Before, BeforeID and Order power the drawer's "Show older events"
// pagination. Rows sort by occurred_at, then id, so the order is total
// even when events share a timestamp. Before is a keyset cursor: when
// non-zero, only rows with occurred_at < Before are returned. BeforeID,
// the id of the row at the cursor, makes the keyset follow that total
// order: rows strictly before (Before, BeforeID), so rows that share
// the cursor's timestamp are neither skipped nor repeated. Order
// selects the sort direction ("asc" or "desc"); any other value
// (including empty) falls back to ASC for backwards compatibility with
// existing callers that rely on chronological order.
//
// The slice filters (EventTypes, Models, ErrorTypes, …) OR within a
// dimension and AND across dimensions. They back the `/events`
// event-grain facet sidebar. The payload-JSON filters extract from
// the `events.payload` column; AgentID and Frameworks resolve through
// a `sessions` subquery because the events table carries neither.
type EventsParams struct {
	From time.Time
	// To bounds occurred_at from above; the zero time leaves the
	// range without an upper bound.
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
	// facet. A colon-form plugin server key also matches the
	// flattened key older plugin releases stored
	// (expandMCPServerFilter).
	MCPServers []string
	// Terminal filters on the boolean `payload.terminal`; nil
	// means no terminal filter.
	Terminal *bool
	// Frameworks matches the bare `sessions.framework` OR any entry
	// of the legacy versioned `sessions.context.frameworks` array.
	Frameworks []string
	// Session-context facet filters. Each one resolves via a
	// `SELECT session_id FROM sessions WHERE <context key> IN (...)`
	// subquery against the partial expression indexes on the
	// context keys. Drives the 9 runtime-context dimensions
	// on the /v1/events facet sidebar.
	OSValues       []string
	Archs          []string
	Hostnames      []string
	Users          []string
	GitBranches    []string
	GitRepos       []string
	Orchestrations []string
	PythonVersions []string
	ProcessNames   []string
	// Query is a free-text case-insensitive search powering the
	// `/events` page top-of-page search bar. It matches the events
	// table's `event_type`, `model`, and `session_id` (as text), plus
	// the session-level `agent_name` / `framework` resolved through
	// a `sessions` subquery (the events table carries neither).
	// Empty means no free-text filter.
	Query    string
	Before   time.Time
	BeforeID string
	Order    string
	Limit    int
	Offset   int
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
	// Runtime-context dimensions sourced from sessions.context.
	// Each one is computed via the existing sessions JOIN; partial
	// expression indexes on the context keys back the GROUP BY
	// scans.
	OS            []EventFacetValue `json:"os"`
	Arch          []EventFacetValue `json:"arch"`
	Hostname      []EventFacetValue `json:"hostname"`
	User          []EventFacetValue `json:"user"`
	GitBranch     []EventFacetValue `json:"git_branch"`
	GitRepo       []EventFacetValue `json:"git_repo"`
	Orchestration []EventFacetValue `json:"orchestration"`
	PythonVersion []EventFacetValue `json:"python_version"`
	ProcessName   []EventFacetValue `json:"process_name"`
}

// facetTopN caps each facet dimension's returned values. The sidebar
// shows the highest-count values; an operator who needs a rarer one
// types it into the filter directly.
const facetTopN = 50

// eventFacetExprs is the exhaustive set of SQL value expressions
// GetEventFacets may GROUP BY, keyed by facet name. These are column
// names and JSON paths, which cannot be bound as query parameters —
// interpolating an out-of-list (e.g. request-derived) expression would
// be SQL injection. Every groupBy / groupBySessionsCol call MUST pass
// a key of this map; a miss fails the request closed. The expressions
// over `payload` read the filtered event set `f`; those over `s.`
// read the joined sessions row.
func (s *Store) eventFacetExprs() map[string]string {
	d := s.d
	return map[string]string{
		"event_type":               "event_type",
		"model":                    "model",
		"error_type":               d.JSONText("payload", "error", "error_type"),
		"close_reason":             d.JSONText("payload", "close_reason"),
		"estimated_via":            d.JSONText("payload", "estimated_via"),
		"originating_call_context": d.JSONText("payload", "originating_call_context"),
		"mcp_server":               s.mcpServerFacetExpr(),
		"terminal":                 d.JSONBoolText("payload", "terminal"),
		"matched_entry_id":         d.JSONText("payload", "policy_decision", "matched_entry_id"),
		"agent_id":                 "CAST(s.agent_id AS TEXT)",
		"framework":                "s.framework",
		// Runtime-context dimensions sourced from sessions.context.
		// Each expression is also a partial-index key; the GROUP BY
		// scan rides those indexes.
		"os":             d.JSONText("s.context", "os"),
		"arch":           d.JSONText("s.context", "arch"),
		"hostname":       d.JSONText("s.context", "hostname"),
		"user":           d.JSONText("s.context", "user"),
		"git_branch":     d.JSONText("s.context", "git_branch"),
		"git_repo":       d.JSONText("s.context", "git_repo"),
		"orchestration":  d.JSONText("s.context", "orchestration"),
		"python_version": d.JSONText("s.context", "python_version"),
		"process_name":   d.JSONText("s.context", "process_name"),
	}
}

// buildEventsWhere assembles the shared WHERE clause + args for both
// GetEvents and GetEventFacets so the two never drift. Conditions use
// `$1..$N` placeholders against unqualified `events` columns, so the
// clause embeds directly under `FROM events` (GetEvents) or
// `FROM events <where>` wrapped as a subquery (GetEventFacets).
func (s *Store) buildEventsWhere(params EventsParams) (conditions []string, args []any) {
	d := s.d
	argIdx := 1
	addText := func(col string, vals []string) {
		if len(vals) == 0 {
			return
		}
		conditions = append(conditions, d.InArray(col, fmt.Sprintf("$%d", argIdx)))
		args = append(args, d.ArrayArg(vals))
		argIdx++
	}

	conditions = append(conditions, fmt.Sprintf("occurred_at >= $%d", argIdx))
	args = append(args, params.From)
	argIdx++

	// A zero To leaves the range without an upper bound.
	if !params.To.IsZero() {
		conditions = append(conditions, fmt.Sprintf("occurred_at <= $%d", argIdx))
		args = append(args, params.To)
		argIdx++
	}

	if params.Flavor != "" {
		conditions = append(conditions, fmt.Sprintf("flavor = $%d", argIdx))
		args = append(args, params.Flavor)
		argIdx++
	}
	if params.SessionID != "" {
		conditions = append(conditions,
			fmt.Sprintf("session_id = $%d", argIdx))
		args = append(args, uuidArg(params.SessionID))
		argIdx++
	}
	if params.AgentID != "" {
		conditions = append(conditions, fmt.Sprintf(
			"session_id IN (SELECT session_id FROM sessions "+
				"WHERE agent_id = $%d)", argIdx))
		args = append(args, uuidArg(params.AgentID))
		argIdx++
	}
	addText("event_type", params.EventTypes)
	addText("model", params.Models)
	addText(d.JSONText("payload", "error", "error_type"), params.ErrorTypes)
	addText(d.JSONText("payload", "close_reason"), params.CloseReasons)
	addText(d.JSONText("payload", "estimated_via"), params.EstimatedVia)
	addText(d.JSONText("payload", "policy_decision", "matched_entry_id"),
		params.MatchedEntryIDs)
	addText(d.JSONText("payload", "originating_call_context"),
		params.OriginatingCallContexts)
	addText(d.JSONText("payload", "server_name"), expandMCPServerFilter(params.MCPServers))
	if params.Terminal != nil {
		// Compare as text ('true' / 'false'), the facet's value
		// shape; a corrupt non-boolean payload is a clean non-match
		// rather than a cast error.
		conditions = append(conditions,
			fmt.Sprintf("%s = $%d", d.JSONBoolText("payload", "terminal"), argIdx))
		args = append(args, strconv.FormatBool(*params.Terminal))
		argIdx++
	}
	if len(params.Frameworks) > 0 {
		// Mirrors the /v1/sessions framework filter: match the bare
		// `sessions.framework` name OR any element of the legacy
		// versioned `context.frameworks` array. One placeholder,
		// referenced twice.
		conditions = append(conditions,
			"session_id IN (SELECT s.session_id FROM sessions s WHERE "+
				s.frameworkMatchSQL("s", fmt.Sprintf("$%d", argIdx))+")")
		args = append(args, d.ArrayArg(params.Frameworks))
		argIdx++
	}
	// Session-context facet filters. Each one resolves via a
	// sessions subquery on the indexed context key expression. Same
	// shape as the Frameworks block above — `session_id IN (...)`
	// against the filtered sessions. The ``addContextFilter`` closure
	// guards against accidental SQL injection by validating the key
	// against the same ``eventFacetExprs`` the facet GROUP BY path
	// uses — a future caller passing a request-derived key would
	// fail closed at the boundary rather than relying on call-site
	// discipline.
	facetExprs := s.eventFacetExprs()
	addContextFilter := func(key string, vals []string) {
		if len(vals) == 0 {
			return
		}
		expr, ok := facetExprs[key]
		if !ok || expr != d.JSONText("s.context", key) {
			// Defensive — every call site below passes a
			// hardcoded key that IS in the allowlist. A miss
			// here means someone added a new context filter
			// without updating the allowlist; failing the
			// request closed surfaces that drift loudly.
			conditions = append(conditions, "1 = 0")
			return
		}
		conditions = append(conditions,
			"session_id IN (SELECT s.session_id FROM sessions s "+
				"WHERE "+d.InArray(expr, fmt.Sprintf("$%d", argIdx))+")")
		args = append(args, d.ArrayArg(vals))
		argIdx++
	}
	addContextFilter("os", params.OSValues)
	addContextFilter("arch", params.Archs)
	addContextFilter("hostname", params.Hostnames)
	addContextFilter("user", params.Users)
	addContextFilter("git_branch", params.GitBranches)
	addContextFilter("git_repo", params.GitRepos)
	addContextFilter("orchestration", params.Orchestrations)
	addContextFilter("python_version", params.PythonVersions)
	addContextFilter("process_name", params.ProcessNames)
	if params.Query != "" {
		// Free-text search for the `/events` page search bar. Matches
		// the events-table columns directly (event_type, model, and
		// session_id as text) and resolves agent_name / framework
		// — neither of which the events table carries — through a
		// sessions subquery. One placeholder, referenced multiple
		// times (same shape as the Frameworks block above). There is
		// no humanized "detail" column to search: the detail string
		// is computed client-side.
		pattern := sanitizeQuery(params.Query)
		q := fmt.Sprintf("$%d", argIdx)
		args = append(args, pattern)
		argIdx++
		conditions = append(conditions, `(
			`+d.ILike("event_type", q)+`
			OR `+d.ILike("COALESCE(model, '')", q)+`
			OR `+d.ILike("CAST(session_id AS TEXT)", q)+`
			OR session_id IN (
				SELECT session_id FROM sessions
				WHERE `+d.ILike("COALESCE(agent_name, '')", q)+`
				OR `+d.ILike("COALESCE(framework, '')", q)+`
			)
		)`)
	}
	if !params.Before.IsZero() {
		if params.BeforeID != "" {
			// Strictly before the cursor row in (occurred_at, id)
			// order. The leading occurred_at <= bound keeps the
			// session/occurred_at index usable; the OR then admits
			// the cursor's own timestamp only for smaller ids.
			conditions = append(conditions, fmt.Sprintf(
				"occurred_at <= $%[1]d AND (occurred_at < $%[1]d OR id < $%[2]d)",
				argIdx, argIdx+1))
			args = append(args, params.Before, uuidArg(params.BeforeID))
			argIdx += 2
		} else {
			conditions = append(conditions,
				fmt.Sprintf("occurred_at < $%d", argIdx))
			args = append(args, params.Before)
			argIdx++
		}
	}
	return conditions, args
}

// GetEvents returns events matching the given filters with pagination.
//
// The COUNT(*) and the data SELECT run inside a single read-only
// snapshot transaction so the returned `total` and `events` are
// consistent with the same snapshot. Concurrent inserts cannot produce
// a state where len(events) > total or has_more lies.
//
// HasMore is computed from `Offset + Limit <= total` rather than from
// `Offset + len(events) < total` so the semantics do not depend on
// len(events) equalling Limit at every page boundary. Inside the
// snapshot Total is fixed, so the comparison is exact.
//
// Each returned Event carries the session-level identity attributes
// (framework, client_type, agent_type) via a LEFT JOIN to `sessions`
// on session_id -- the events table stores none of them.
func (s *Store) GetEvents(ctx context.Context, params EventsParams) (*EventsResponse, error) {
	conditions, args := s.buildEventsWhere(params)

	// Default ASC preserves pre-pagination callers (bulk history loader,
	// Fleet historical events). Only ``desc`` flips the order.
	orderDir := "ASC"
	if strings.EqualFold(params.Order, "desc") {
		orderDir = "DESC"
	}

	where := "WHERE " + strings.Join(conditions, " AND ")

	tx, err := s.readTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Count total
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM events %s", where)
	var total int
	if err := tx.QueryRowContext(ctx, countSQL, args...).Scan(&total); err != nil {
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
	//
	// id breaks occurred_at ties, in the same direction, so the order
	// is total: events often share a timestamp (a client stamping whole
	// seconds, the reaper's session_end rows sharing one clock read),
	// and without the tiebreaker the planner may order tied rows
	// differently in each page's query, so an offset page could skip or
	// repeat a row. The keyset cursor (Before, BeforeID) follows the
	// same order.
	limitIdx := len(args) + 1
	querySQL := fmt.Sprintf(`
		SELECT `+eventColumns("e.")+`,
		       s.framework, s.client_type, s.agent_type
		FROM (
			SELECT * FROM events
			%s
			ORDER BY occurred_at %s, id %s
			LIMIT $%d OFFSET $%d
		) e
		LEFT JOIN sessions s ON s.session_id = e.session_id
		ORDER BY e.occurred_at %s, e.id %s
	`, where, orderDir, orderDir, limitIdx, limitIdx+1, orderDir, orderDir)
	args = append(args, params.Limit, params.Offset)

	rows, err := tx.QueryContext(ctx, querySQL, args...)
	if err != nil {
		return nil, fmt.Errorf("get events: %w", err)
	}
	defer func() { _ = rows.Close() }()

	events := []Event{}
	for rows.Next() {
		var framework, clientType, agentType *string
		e, err := scanEvent(rows, &framework, &clientType, &agentType)
		if err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		e.Framework, e.ClientType, e.AgentType = framework, clientType, agentType
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("events scan: %w", err)
	}
	_ = rows.Close()

	if err := tx.Commit(); err != nil {
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
// agent_id, framework and the context dimensions join `sessions`. All
// run in one read-only snapshot so the counts are mutually consistent.
func (s *Store) GetEventFacets(ctx context.Context, params EventsParams) (*EventFacets, error) {
	conditions, args := s.buildEventsWhere(params)
	where := "WHERE " + strings.Join(conditions, " AND ")
	// The filtered event set, reused by every dimension query.
	filtered := fmt.Sprintf("(SELECT * FROM events %s)", where)
	exprs := s.eventFacetExprs()

	tx, err := s.readTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// groupBy runs one facet GROUP BY: the named dimension's
	// expression evaluated over the filtered event set `f`.
	groupBy := func(name string) ([]EventFacetValue, error) {
		valueExpr, ok := exprs[name]
		if !ok {
			return nil, fmt.Errorf("facet expression not allowlisted: %q", name)
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
	// expression reached by joining the filtered event set on
	// session_id.
	groupBySessionsCol := func(name string) ([]EventFacetValue, error) {
		col, ok := exprs[name]
		if !ok {
			return nil, fmt.Errorf("facet expression not allowlisted: %q", name)
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
	for _, dim := range []struct {
		dest *[]EventFacetValue
		name string
		run  func(string) ([]EventFacetValue, error)
	}{
		{&facets.EventType, "event_type", groupBy},
		{&facets.Model, "model", groupBy},
		{&facets.ErrorType, "error_type", groupBy},
		{&facets.CloseReason, "close_reason", groupBy},
		{&facets.EstimatedVia, "estimated_via", groupBy},
		{&facets.MatchedEntryID, "matched_entry_id", groupBy},
		{&facets.OriginatingCallContext, "originating_call_context", groupBy},
		{&facets.MCPServer, "mcp_server", groupBy},
		{&facets.Terminal, "terminal", groupBy},
		{&facets.AgentID, "agent_id", groupBySessionsCol},
		{&facets.Framework, "framework", groupBySessionsCol},
		{&facets.OS, "os", groupBySessionsCol},
		{&facets.Arch, "arch", groupBySessionsCol},
		{&facets.Hostname, "hostname", groupBySessionsCol},
		{&facets.User, "user", groupBySessionsCol},
		{&facets.GitBranch, "git_branch", groupBySessionsCol},
		{&facets.GitRepo, "git_repo", groupBySessionsCol},
		{&facets.Orchestration, "orchestration", groupBySessionsCol},
		{&facets.PythonVersion, "python_version", groupBySessionsCol},
		{&facets.ProcessName, "process_name", groupBySessionsCol},
	} {
		values, err := dim.run(dim.name)
		if err != nil {
			return nil, err
		}
		*dim.dest = values
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	return facets, nil
}

func scanFacet(
	ctx context.Context, tx *sql.Tx, query string, args []any,
) ([]EventFacetValue, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("event facet query: %w", err)
	}
	defer func() { _ = rows.Close() }()
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
