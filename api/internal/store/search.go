package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"golang.org/x/sync/errgroup"
)

// SearchResultAgent is a search hit on the agents table.
type SearchResultAgent struct {
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

// sanitizeQuery wraps the query for ILIKE and escapes LIKE special characters.
// Order: escape backslash first, then % and _, to avoid double-escaping.
func sanitizeQuery(q string) string {
	escaped := strings.ReplaceAll(q, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "%", "\\%")
	escaped = strings.ReplaceAll(escaped, "_", "\\_")
	return "%" + escaped + "%"
}

// Search performs a cross-entity ILIKE search across agents, sessions, and events.
// All three queries run in parallel. Returns up to 5 results per group.
func (s *Store) Search(ctx context.Context, query string) (*SearchResults, error) {
	pattern := sanitizeQuery(query)
	var results SearchResults

	g, ctx := errgroup.WithContext(ctx)

	// Search agents. D115: agents is keyed by agent_id and the
	// searchable human-readable label is agent_name; the legacy
	// flavor column was dropped in migration 000015.
	g.Go(func() error {
		rows, err := s.pool.Query(ctx, `
			SELECT agent_name, agent_type, last_seen_at::text
			FROM agents
			WHERE agent_name ILIKE $1
			ORDER BY last_seen_at DESC
			LIMIT 5
		`, pattern)
		if err != nil {
			return fmt.Errorf("search agents: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var a SearchResultAgent
			if err := rows.Scan(&a.AgentName, &a.AgentType, &a.LastSeen); err != nil {
				return fmt.Errorf("scan agent: %w", err)
			}
			results.Agents = append(results.Agents, a)
		}
		return nil
	})

	// Search sessions -- matches across core columns and context JSONB
	g.Go(func() error {
		rows, err := s.pool.Query(ctx, `
			SELECT session_id::text, flavor, COALESCE(host, ''), state, started_at::text,
			       ended_at::text, COALESCE(model, ''), tokens_used, token_limit, context
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
			ORDER BY started_at DESC
			LIMIT 5
		`, pattern)
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
		return nil
	})

	// Search events
	g.Go(func() error {
		rows, err := s.pool.Query(ctx, `
			SELECT id::text, session_id::text, event_type, COALESCE(tool_name, ''), COALESCE(model, ''), occurred_at::text
			FROM events
			WHERE COALESCE(tool_name, '') ILIKE $1 OR COALESCE(model, '') ILIKE $1
			ORDER BY occurred_at DESC
			LIMIT 5
		`, pattern)
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
		return nil
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	// Ensure non-nil arrays for JSON serialization
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
