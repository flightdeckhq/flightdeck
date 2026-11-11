package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"
)

// SearchResultAgent is a search hit on the agents table.
//
// AgentID is the wire value the Investigate “?agent_id=“ filter
// and the AgentDrawer “?agent_drawer=“ param consume. The result
// type carries it so the dashboard can route a click without a
// second round-trip to look up the identity.
//
// ClientType + State match the /v1/agents listing projection so
// the palette's AgentRow can reuse the same identity primitives
// the /agents table row uses (ClaudeCodeLogo for Claude Code
// clients, AgentTypeBadge, AgentStatusBadge). State is derived
// via the shared “agentStateRollupSQL“ so /v1/search and
// /agents agree on the rolled-up state per agent.
type SearchResultAgent struct {
	AgentID    string `json:"agent_id"`
	AgentName  string `json:"agent_name"`
	AgentType  string `json:"agent_type"`
	ClientType string `json:"client_type"`
	State      string `json:"state"`
	// LastSeen is the agent's last_seen_at as an RFC 3339 UTC
	// timestamp.
	LastSeen string `json:"last_seen"`
	// Telemetry is the agent's latest session's `context.telemetry`
	// ("otlp" for a session reported over OpenTelemetry), as on
	// AgentSummary, so the palette labels the agent's source.
	Telemetry *string `json:"telemetry,omitempty"`
}

// SearchResultSession is a search hit on the sessions table.
// Includes all fields needed to render a sessions table row in the
// Investigate screen without a second round-trip per hit. The
// timestamps are RFC 3339 UTC strings.
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
	// ClientType is the session's client_type ("" on a parent-stub
	// row that has none), so the palette names the client beside the
	// session's source.
	ClientType string `json:"client_type"`
}

// SearchResultEvent is a search hit on the events table. OccurredAt is
// an RFC 3339 UTC string.
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
// for the events search expansion — a query like “LLM“ returns
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
// curated term. An empty array binds as an empty set, so the curated
// arm short-circuits to no-match while the pattern arms in the WHERE
// still run. No rows are lost; the curated branch simply doesn't
// contribute when the term is unknown.
func expandCuratedTerms(query string) []string {
	return curatedEventTypeTerms[strings.ToLower(strings.TrimSpace(query))]
}

// likeEscape escapes LIKE special characters (“\“, “%“, “_“)
// so user input is matched literally instead of as wildcards.
// Backslash is escaped first to avoid double-escaping the introduced
// escapes. Every LIKE the store issues declares ESCAPE '\'
// (Dialect.ILike does), since SQLite has no default escape character.
func likeEscape(q string) string {
	escaped := strings.ReplaceAll(q, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "%", "\\%")
	escaped = strings.ReplaceAll(escaped, "_", "\\_")
	return escaped
}

// sanitizeQuery wraps the query for substring matching.
func sanitizeQuery(q string) string {
	return "%" + likeEscape(q) + "%"
}

// sanitizePrefix builds a prefix pattern (“q%“).
func sanitizePrefix(q string) string {
	return likeEscape(q) + "%"
}

// sanitizeExact builds an exact pattern (the escaped query with no
// wildcards). Used so the rank CASE in each query can distinguish an
// exact case-insensitive match from a prefix or substring match.
func sanitizeExact(q string) string {
	return likeEscape(q)
}

// searchTime renders a timestamp for a search result.
func searchTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
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
	d := s.d
	var results SearchResults

	// $1 is the substring pattern, $2 the prefix pattern, $3 the exact
	// pattern.
	sub := func(expr string) string { return d.ILike(expr, "$1") }
	prefix := func(expr string) string { return d.ILike(expr, "$2") }
	exact := func(expr string) string { return d.ILike(expr, "$3") }

	// Rename the derived context so the outer ``ctx`` parameter
	// isn't shadowed — the closures below read ``gCtx`` explicitly,
	// matching the pattern in store.go.
	g, gCtx := errgroup.WithContext(ctx)

	// Search agents. agents.agent_name is the human-readable label;
	// hostname and user_name are added so a query for the device or
	// the operator surfaces the agent even when agent_name doesn't
	// embed them (the sensor's per-host agents do embed user@host,
	// but seeded / test / cloud agents often don't).
	g.Go(func() error {
		rows, err := s.reader().QueryContext(gCtx, `
			SELECT
				CAST(a.agent_id AS TEXT),
				a.agent_name,
				a.agent_type,
				COALESCE(a.client_type, '') AS client_type,
				COALESCE(a.rollup_state, '') AS state,
				a.last_seen_at,
				`+d.JSONText("latest.context", "telemetry")+` AS telemetry,
				CASE
					WHEN `+exact("a.agent_name")+` THEN 0
					WHEN `+exact("COALESCE(a.hostname, '')")+` THEN 1
					WHEN `+exact("COALESCE(a.user_name, '')")+` THEN 2
					WHEN `+prefix("a.agent_name")+` THEN 3
					WHEN `+prefix("COALESCE(a.hostname, '')")+` THEN 4
					WHEN `+prefix("COALESCE(a.user_name, '')")+` THEN 5
					WHEN `+sub("a.agent_name")+` THEN 6
					WHEN `+sub("COALESCE(a.hostname, '')")+` THEN 7
					WHEN `+sub("COALESCE(a.user_name, '')")+` THEN 8
					ELSE 99
				END AS rank
			`+agentFrom+`
			WHERE `+sub("a.agent_name")+`
			   OR `+sub("COALESCE(a.hostname, '')")+`
			   OR `+sub("COALESCE(a.user_name, '')")+`
			ORDER BY rank ASC, a.last_seen_at DESC
			LIMIT 5
		`, pattern, prefixPat, exactPat)
		if err != nil {
			return fmt.Errorf("search agents: %w", err)
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var a SearchResultAgent
			var lastSeen time.Time
			var rank int
			if err := rows.Scan(
				&a.AgentID, &a.AgentName, &a.AgentType,
				&a.ClientType, &a.State, &lastSeen, &a.Telemetry, &rank,
			); err != nil {
				return fmt.Errorf("scan agent: %w", err)
			}
			a.LastSeen = searchTime(lastSeen)
			results.Agents = append(results.Agents, a)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate agents: %w", err)
		}
		return nil
	})

	// Search sessions — keep the existing breadth across core
	// columns and context JSON. Ranking promotes session_id /
	// flavor / host / model exact hits ahead of the JSON substring
	// pool, so a UUID paste or a flavor literal lands first.
	// Rows matched only via context JSON fall through to the ``ELSE
	// 99`` sentinel and sort below all core-column matches — they
	// still appear in the page, just under the more relevant hits.
	g.Go(func() error {
		rows, err := s.reader().QueryContext(gCtx, `
			SELECT session_id, flavor, host, state, started_at,
			       ended_at, model, tokens_used, token_limit, context,
			       client_type
			FROM (
				SELECT
					CAST(session_id AS TEXT) AS session_id, flavor,
					COALESCE(host, '') AS host,
					state, started_at, ended_at,
					COALESCE(model, '') AS model,
					tokens_used, token_limit, context,
					COALESCE(client_type, '') AS client_type,
					CASE
						WHEN `+exact("CAST(session_id AS TEXT)")+` THEN 0
						WHEN `+exact("flavor")+` THEN 1
						WHEN `+exact("COALESCE(host, '')")+` THEN 2
						WHEN `+exact("COALESCE(model, '')")+` THEN 3
						WHEN `+prefix("CAST(session_id AS TEXT)")+` THEN 4
						WHEN `+prefix("flavor")+` THEN 5
						WHEN `+prefix("COALESCE(host, '')")+` THEN 6
						WHEN `+prefix("COALESCE(model, '')")+` THEN 7
						ELSE 99
					END AS rank
				FROM sessions
				WHERE `+sub("CAST(session_id AS TEXT)")+`
				   OR `+sub("flavor")+`
				   OR `+sub("COALESCE(host, '')")+`
				   OR `+sub("COALESCE(model, '')")+`
				   OR `+sub("COALESCE("+d.JSONText("context", "hostname")+", '')")+`
				   OR `+sub("COALESCE("+d.JSONText("context", "os")+", '')")+`
				   OR `+sub("COALESCE("+d.JSONText("context", "git_branch")+", '')")+`
				   OR `+sub("COALESCE("+d.JSONText("context", "python_version")+", '')")+`
				   OR `+sub("COALESCE("+d.JSONText("context", "frameworks")+", '')")+`
			) ranked
			ORDER BY rank ASC, started_at DESC
			LIMIT 5
		`, pattern, prefixPat, exactPat)
		if err != nil {
			return fmt.Errorf("search sessions: %w", err)
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var sr SearchResultSession
			var startedAt time.Time
			var endedAt *time.Time
			var contextRaw []byte
			if err := rows.Scan(
				&sr.SessionID, &sr.Flavor, &sr.Host, &sr.State, &startedAt,
				&endedAt, &sr.Model, &sr.TokensUsed, &sr.TokenLimit, &contextRaw,
				&sr.ClientType,
			); err != nil {
				return fmt.Errorf("scan session: %w", err)
			}
			sr.StartedAt = searchTime(startedAt)
			if endedAt != nil {
				ended := searchTime(*endedAt)
				sr.EndedAt = &ended
			}
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
		rows, err := s.reader().QueryContext(gCtx, `
			SELECT id, session_id, event_type, tool_name, model, occurred_at
			FROM (
				SELECT
					CAST(id AS TEXT) AS id, CAST(session_id AS TEXT) AS session_id, event_type,
					COALESCE(tool_name, '') AS tool_name,
					COALESCE(model, '') AS model,
					occurred_at,
					CASE
						WHEN `+exact("event_type")+` THEN 0
						WHEN `+exact("COALESCE(tool_name, '')")+` THEN 1
						WHEN `+exact("COALESCE(model, '')")+` THEN 2
						WHEN `+d.InArray("event_type", "$4")+` THEN 3
						WHEN `+prefix("event_type")+` THEN 4
						WHEN `+prefix("COALESCE(tool_name, '')")+` THEN 5
						WHEN `+prefix("COALESCE(model, '')")+` THEN 6
						WHEN `+sub("event_type")+` THEN 7
						WHEN `+sub("COALESCE(tool_name, '')")+` THEN 8
						WHEN `+sub("COALESCE(model, '')")+` THEN 9
						ELSE 99
					END AS rank
				FROM events
				WHERE `+sub("event_type")+`
				   OR `+sub("COALESCE(tool_name, '')")+`
				   OR `+sub("COALESCE(model, '')")+`
				   OR `+d.InArray("event_type", "$4")+`
			) ranked
			ORDER BY rank ASC, occurred_at DESC
			LIMIT 5
		`, pattern, prefixPat, exactPat, d.ArrayArg(curated))
		if err != nil {
			return fmt.Errorf("search events: %w", err)
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var e SearchResultEvent
			var occurredAt time.Time
			if err := rows.Scan(&e.EventID, &e.SessionID, &e.EventType, &e.ToolName, &e.Model, &occurredAt); err != nil {
				return fmt.Errorf("scan event: %w", err)
			}
			e.OccurredAt = searchTime(occurredAt)
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
