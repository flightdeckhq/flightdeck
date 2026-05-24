package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"golang.org/x/sync/errgroup"
)

// SearchResultAgent is a search hit on the agents table.
//
// AgentID is the wire value the Investigate “?agent_id=“ filter
// and the AgentDrawer “?agent_drawer=“ param consume. The result
// type carries it so the dashboard can route a click without a
// second round-trip to look up the identity.
type SearchResultAgent struct {
	AgentID   string `json:"agent_id"`
	AgentName string `json:"agent_name"`
	AgentType string `json:"agent_type"`
	LastSeen  string `json:"last_seen"`
}

// SearchResultSession is a search hit on the sessions table.
// Includes all fields needed to render a sessions table row in the
// Investigate screen without a second round-trip per hit.
type SearchResultSession struct {
	SessionID  string                 `json:"session_id"`
	Flavor     string                 `json:"flavor"`
	Host       string                 `json:"host"`
	State      string                 `json:"state"`
	StartedAt  string                 `json:"started_at"`
	EndedAt    *string                `json:"ended_at"`
	Model      string                 `json:"model"`
	TokensUsed int                    `json:"tokens_used"`
	TokenLimit *int64                 `json:"token_limit"`
	Context    map[string]interface{} `json:"context"`
}

// SearchResultEvent is a search hit on the events table.
type SearchResultEvent struct {
	EventID    string `json:"event_id"`
	SessionID  string `json:"session_id"`
	EventType  string `json:"event_type"`
	ToolName   string `json:"tool_name"`
	Model      string `json:"model"`
	OccurredAt string `json:"occurred_at"`
}

// SearchResults groups search hits by entity type.
type SearchResults struct {
	Agents   []SearchResultAgent   `json:"agents"`
	Sessions []SearchResultSession `json:"sessions"`
	Events   []SearchResultEvent   `json:"events"`
}

// curatedEventTypeTerms maps user-facing English terms to the
// underlying event_type values they should match. Source of truth
// for the events ILIKE expansion — a query like “LLM“ returns
// every event whose event_type appears in this list under “llm“,
// even though no event_type literally contains the substring
// "LLM". Lookup keys are lowercased; values are matched verbatim
// against the events.event_type column (which the sensor emits as
// snake_case lowercase strings).
//
// Extending this map is the supported way to broaden the search
// vocabulary; the unit test pins the list so a silent typo can't
// shrink coverage.
var curatedEventTypeTerms = map[string][]string{
	"llm":       {"pre_call", "post_call", "llm_error"},
	"tool":      {"tool_call", "mcp_tool_list", "mcp_tool_call"},
	"policy":    {"policy_warn", "policy_degrade", "policy_block", "policy_mcp_warn", "policy_mcp_block"},
	"error":     {"llm_error", "policy_block", "policy_mcp_block"},
	"embedding": {"embeddings"},
	"mcp": {
		"mcp_tool_list", "mcp_tool_call",
		"mcp_resource_list", "mcp_resource_read",
		"mcp_prompt_list", "mcp_prompt_get",
		"policy_mcp_warn", "policy_mcp_block",
		"mcp_server_name_changed", "mcp_server_attached",
	},
	"session":   {"session_start", "session_end"},
	"block":     {"policy_block", "policy_mcp_block"},
	"directive": {"directive_result"},
}

// expandCuratedTerms returns the event_type slice mapped from the
// query, or nil when the query (case-insensitive) is not a known
// curated term. pgx/v5 encodes a nil []string as SQL NULL, and
// “event_type = ANY(NULL)“ is always false — so the curated arm
// short-circuits to no-match while the ILIKE arms in the WHERE
// still run. No rows are lost; the curated branch simply doesn't
// contribute when the term is unknown.
func expandCuratedTerms(query string) []string {
	return curatedEventTypeTerms[strings.ToLower(strings.TrimSpace(query))]
}

// likeEscape escapes LIKE special characters (“\“, “%“, “_“)
// so user input is matched literally instead of as wildcards.
// Backslash is escaped first to avoid double-escaping the introduced
// escapes.
func likeEscape(q string) string {
	escaped := strings.ReplaceAll(q, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "%", "\\%")
	escaped = strings.ReplaceAll(escaped, "_", "\\_")
	return escaped
}

// sanitizeQuery wraps the query for substring ILIKE matching.
func sanitizeQuery(q string) string {
	return "%" + likeEscape(q) + "%"
}

// sanitizePrefix builds a prefix ILIKE pattern (“q%“).
func sanitizePrefix(q string) string {
	return likeEscape(q) + "%"
}

// sanitizeExact builds an exact ILIKE pattern (the escaped query
// with no wildcards). Used so the rank CASE in each query can
// distinguish an exact case-insensitive match from a prefix or
// substring match without juggling LOWER() on both sides.
func sanitizeExact(q string) string {
	return likeEscape(q)
}

// Search performs a cross-entity case-insensitive search across
// agents, sessions, and events. All three queries run in parallel.
// Returns up to 5 results per group, ordered by rank then by the
// entity's natural recency column.
//
// Ranking is shared across entities: exact match (rank 0) outranks
// prefix (rank 4 for events, 3 for agents) which outranks substring.
// Within each tier, fields are tied by a fixed precedence so a
// query that matches multiple fields on the same row lands in the
// most semantic field's slot:
//
//   - events:  event_type > tool_name > model
//   - agents:  agent_name > hostname > user_name
//   - sessions: session_id > flavor > host > model
//
// Events additionally honour a curated English-term-to-event_types
// map (see curatedEventTypeTerms) at rank 3, so “LLM“ /
// “policy“ / “embedding“ surface the right events even though
// no event_type literally contains those substrings.
func (s *Store) Search(ctx context.Context, query string) (*SearchResults, error) {
	pattern := sanitizeQuery(query)
	prefixPat := sanitizePrefix(query)
	exactPat := sanitizeExact(query)
	curated := expandCuratedTerms(query)
	var results SearchResults

	// Rename the derived context so the outer ``ctx`` parameter
	// isn't shadowed — the closures below read ``gCtx`` explicitly,
	// matching the pattern in postgres.go.
	g, gCtx := errgroup.WithContext(ctx)

	// Search agents. agents.agent_name is the human-readable label;
	// hostname and user_name are added so a query for the device or
	// the operator surfaces the agent even when agent_name doesn't
	// embed them (the sensor's per-host agents do embed user@host,
	// but seeded / test / cloud agents often don't).
	g.Go(func() error {
		rows, err := s.pool.Query(gCtx, `
			SELECT agent_id::text, agent_name, agent_type, last_seen_at::text
			FROM (
				SELECT a.*,
					CASE
						WHEN agent_name ILIKE $3 THEN 0
						WHEN COALESCE(hostname, '') ILIKE $3 THEN 1
						WHEN COALESCE(user_name, '') ILIKE $3 THEN 2
						WHEN agent_name ILIKE $2 THEN 3
						WHEN COALESCE(hostname, '') ILIKE $2 THEN 4
						WHEN COALESCE(user_name, '') ILIKE $2 THEN 5
						WHEN agent_name ILIKE $1 THEN 6
						WHEN COALESCE(hostname, '') ILIKE $1 THEN 7
						WHEN COALESCE(user_name, '') ILIKE $1 THEN 8
						ELSE 99
					END AS rank
				FROM agents a
				WHERE agent_name ILIKE $1
				   OR COALESCE(hostname, '') ILIKE $1
				   OR COALESCE(user_name, '') ILIKE $1
			) ranked
			ORDER BY rank ASC, last_seen_at DESC
			LIMIT 5
		`, pattern, prefixPat, exactPat)
		if err != nil {
			return fmt.Errorf("search agents: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var a SearchResultAgent
			if err := rows.Scan(&a.AgentID, &a.AgentName, &a.AgentType, &a.LastSeen); err != nil {
				return fmt.Errorf("scan agent: %w", err)
			}
			results.Agents = append(results.Agents, a)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate agents: %w", err)
		}
		return nil
	})

	// Search sessions — keep the existing breadth across core
	// columns and context JSONB. Ranking promotes session_id /
	// flavor / host / model exact hits ahead of the JSONB substring
	// pool, so a UUID paste or a flavor literal lands first.
	// Rows matched only via context-JSONB fall through to the ``ELSE
	// 99`` sentinel and sort below all core-column matches — they
	// still appear in the page, just under the more relevant hits.
	g.Go(func() error {
		rows, err := s.pool.Query(gCtx, `
			SELECT session_id::text, flavor, host, state, started_at::text,
			       ended_at::text, model, tokens_used, token_limit, context
			FROM (
				SELECT
					session_id, flavor,
					COALESCE(host, '') AS host,
					state, started_at, ended_at,
					COALESCE(model, '') AS model,
					tokens_used, token_limit, context,
					CASE
						WHEN session_id::text ILIKE $3 THEN 0
						WHEN flavor ILIKE $3 THEN 1
						WHEN COALESCE(host, '') ILIKE $3 THEN 2
						WHEN COALESCE(model, '') ILIKE $3 THEN 3
						WHEN session_id::text ILIKE $2 THEN 4
						WHEN flavor ILIKE $2 THEN 5
						WHEN COALESCE(host, '') ILIKE $2 THEN 6
						WHEN COALESCE(model, '') ILIKE $2 THEN 7
						ELSE 99
					END AS rank
				FROM sessions
				WHERE session_id::text ILIKE $1
				   OR flavor ILIKE $1
				   OR COALESCE(host, '') ILIKE $1
				   OR COALESCE(model, '') ILIKE $1
				   OR COALESCE(context->>'hostname', '') ILIKE $1
				   OR COALESCE(context->>'os', '') ILIKE $1
				   OR COALESCE(context->>'git_branch', '') ILIKE $1
				   OR COALESCE(context->>'python_version', '') ILIKE $1
				   OR COALESCE((context->'frameworks')::text, '') ILIKE $1
			) ranked
			ORDER BY rank ASC, started_at DESC
			LIMIT 5
		`, pattern, prefixPat, exactPat)
		if err != nil {
			return fmt.Errorf("search sessions: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var sr SearchResultSession
			var endedAt *string
			var contextRaw []byte
			if err := rows.Scan(
				&sr.SessionID, &sr.Flavor, &sr.Host, &sr.State, &sr.StartedAt,
				&endedAt, &sr.Model, &sr.TokensUsed, &sr.TokenLimit, &contextRaw,
			); err != nil {
				return fmt.Errorf("scan session: %w", err)
			}
			sr.EndedAt = endedAt
			if len(contextRaw) > 0 {
				var v map[string]interface{}
				if jsonErr := json.Unmarshal(contextRaw, &v); jsonErr == nil {
					sr.Context = v
				}
			}
			if sr.Context == nil {
				sr.Context = map[string]interface{}{}
			}
			results.Sessions = append(results.Sessions, sr)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate sessions: %w", err)
		}
		return nil
	})

	// Search events. event_type is the most semantic field, then
	// tool_name, then model. The curated map (rank 3) lets terms
	// like ``LLM``/``policy``/``embedding`` return the right rows
	// without any event_type literally containing those substrings.
	g.Go(func() error {
		rows, err := s.pool.Query(gCtx, `
			SELECT id::text, session_id::text, event_type, tool_name, model, occurred_at::text
			FROM (
				SELECT
					id, session_id, event_type,
					COALESCE(tool_name, '') AS tool_name,
					COALESCE(model, '') AS model,
					occurred_at,
					CASE
						WHEN event_type ILIKE $3 THEN 0
						WHEN COALESCE(tool_name, '') ILIKE $3 THEN 1
						WHEN COALESCE(model, '') ILIKE $3 THEN 2
						WHEN event_type = ANY($4::text[]) THEN 3
						WHEN event_type ILIKE $2 THEN 4
						WHEN COALESCE(tool_name, '') ILIKE $2 THEN 5
						WHEN COALESCE(model, '') ILIKE $2 THEN 6
						WHEN event_type ILIKE $1 THEN 7
						WHEN COALESCE(tool_name, '') ILIKE $1 THEN 8
						WHEN COALESCE(model, '') ILIKE $1 THEN 9
						ELSE 99
					END AS rank
				FROM events
				WHERE event_type ILIKE $1
				   OR COALESCE(tool_name, '') ILIKE $1
				   OR COALESCE(model, '') ILIKE $1
				   OR event_type = ANY($4::text[])
			) ranked
			ORDER BY rank ASC, occurred_at DESC
			LIMIT 5
		`, pattern, prefixPat, exactPat, curated)
		if err != nil {
			return fmt.Errorf("search events: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var e SearchResultEvent
			if err := rows.Scan(&e.EventID, &e.SessionID, &e.EventType, &e.ToolName, &e.Model, &e.OccurredAt); err != nil {
				return fmt.Errorf("scan event: %w", err)
			}
			results.Events = append(results.Events, e)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate events: %w", err)
		}
		return nil
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	if results.Agents == nil {
		results.Agents = []SearchResultAgent{}
	}
	if results.Sessions == nil {
		results.Sessions = []SearchResultSession{}
	}
	if results.Events == nil {
		results.Events = []SearchResultEvent{}
	}

	return &results, nil
}
