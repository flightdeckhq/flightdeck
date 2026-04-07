// Package store provides Postgres queries for the query API.
// All queries use pgx directly -- no ORM.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store provides read queries for the fleet dashboard.
type Store struct {
	pool *pgxpool.Pool
}

// New creates a Store.
func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Session represents a session row for API responses.
type Session struct {
	SessionID  string     `json:"session_id"`
	Flavor     string     `json:"flavor"`
	AgentType  string     `json:"agent_type"`
	Host       *string    `json:"host"`
	Framework  *string    `json:"framework"`
	Model      *string    `json:"model"`
	State      string     `json:"state"`
	StartedAt  time.Time  `json:"started_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	TokensUsed int        `json:"tokens_used"`
	TokenLimit *int       `json:"token_limit,omitempty"`
}

// Event represents an event row for API responses.
type Event struct {
	ID           string     `json:"id"`
	SessionID    string     `json:"session_id"`
	Flavor       string     `json:"flavor"`
	EventType    string     `json:"event_type"`
	Model        *string    `json:"model,omitempty"`
	TokensInput  *int       `json:"tokens_input,omitempty"`
	TokensOutput *int       `json:"tokens_output,omitempty"`
	TokensTotal  *int       `json:"tokens_total,omitempty"`
	LatencyMs    *int       `json:"latency_ms,omitempty"`
	ToolName     *string    `json:"tool_name,omitempty"`
	HasContent   bool       `json:"has_content"`
	OccurredAt   time.Time  `json:"occurred_at"`
}

// FlavorSummary groups sessions by flavor for the fleet view.
type FlavorSummary struct {
	Flavor         string    `json:"flavor"`
	AgentType      string    `json:"agent_type"`
	SessionCount   int       `json:"session_count"`
	ActiveCount    int       `json:"active_count"`
	TokensUsedTotal int     `json:"tokens_used_total"`
	Sessions       []Session `json:"sessions"`
}

// GetFleet returns all sessions grouped by flavor, excluding lost sessions.
func (s *Store) GetFleet(ctx context.Context) ([]FlavorSummary, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT session_id::text, flavor, agent_type, host, framework, model,
		       state, started_at, last_seen_at, ended_at, tokens_used, token_limit
		FROM sessions
		WHERE state != 'lost'
		ORDER BY flavor, started_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("get fleet: %w", err)
	}
	defer rows.Close()

	flavorMap := make(map[string]*FlavorSummary)
	var order []string

	for rows.Next() {
		var sess Session
		if err := rows.Scan(
			&sess.SessionID, &sess.Flavor, &sess.AgentType,
			&sess.Host, &sess.Framework, &sess.Model,
			&sess.State, &sess.StartedAt, &sess.LastSeenAt,
			&sess.EndedAt, &sess.TokensUsed, &sess.TokenLimit,
		); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}

		fs, ok := flavorMap[sess.Flavor]
		if !ok {
			fs = &FlavorSummary{
				Flavor:    sess.Flavor,
				AgentType: sess.AgentType,
			}
			flavorMap[sess.Flavor] = fs
			order = append(order, sess.Flavor)
		}

		fs.Sessions = append(fs.Sessions, sess)
		fs.SessionCount++
		fs.TokensUsedTotal += sess.TokensUsed
		if sess.State == "active" {
			fs.ActiveCount++
		}
	}

	result := make([]FlavorSummary, 0, len(order))
	for _, f := range order {
		result = append(result, *flavorMap[f])
	}
	return result, nil
}

// GetSession returns a single session by ID.
func (s *Store) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	var sess Session
	err := s.pool.QueryRow(ctx, `
		SELECT session_id::text, flavor, agent_type, host, framework, model,
		       state, started_at, last_seen_at, ended_at, tokens_used, token_limit
		FROM sessions
		WHERE session_id = $1::uuid
	`, sessionID).Scan(
		&sess.SessionID, &sess.Flavor, &sess.AgentType,
		&sess.Host, &sess.Framework, &sess.Model,
		&sess.State, &sess.StartedAt, &sess.LastSeenAt,
		&sess.EndedAt, &sess.TokensUsed, &sess.TokenLimit,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session %s: %w", sessionID, err)
	}
	return &sess, nil
}

// GetSessionEvents returns all events for a session in chronological order.
func (s *Store) GetSessionEvents(ctx context.Context, sessionID string) ([]Event, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, session_id::text, flavor, event_type, model,
		       tokens_input, tokens_output, tokens_total, latency_ms,
		       tool_name, has_content, occurred_at
		FROM events
		WHERE session_id = $1::uuid
		ORDER BY occurred_at ASC
	`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("get events for %s: %w", sessionID, err)
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(
			&e.ID, &e.SessionID, &e.Flavor, &e.EventType, &e.Model,
			&e.TokensInput, &e.TokensOutput, &e.TokensTotal, &e.LatencyMs,
			&e.ToolName, &e.HasContent, &e.OccurredAt,
		); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		events = append(events, e)
	}
	return events, nil
}
