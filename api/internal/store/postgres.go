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

// Querier is the interface for fleet data access.
// Implemented by Store (Postgres) and mocks in tests.
type Querier interface {
	GetFleet(ctx context.Context) ([]FlavorSummary, error)
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	GetSessionEvents(ctx context.Context, sessionID string) ([]Event, error)
	GetEffectivePolicy(ctx context.Context, flavor, sessionID string) (*Policy, error)
	GetPolicies(ctx context.Context) ([]Policy, error)
	GetPolicyByID(ctx context.Context, id string) (*Policy, error)
	UpsertPolicy(ctx context.Context, p Policy) (*Policy, error)
	DeletePolicy(ctx context.Context, id string) error
}

// WrapStore returns a Querier from any compatible implementation.
func WrapStore(q Querier) Querier { return q }

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

// Policy represents a token budget policy.
type Policy struct {
	ID           string    `json:"id"`
	Scope        string    `json:"scope"`
	ScopeValue   string    `json:"scope_value"`
	TokenLimit   *int64    `json:"token_limit,omitempty"`
	WarnAtPct    *int      `json:"warn_at_pct,omitempty"`
	DegradeAtPct *int      `json:"degrade_at_pct,omitempty"`
	DegradeTo    *string   `json:"degrade_to,omitempty"`
	BlockAtPct   *int      `json:"block_at_pct,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// GetEffectivePolicy returns the most specific policy for a given flavor/session.
// Cascading lookup: session > flavor > org. Returns nil if no policy found.
func (s *Store) GetEffectivePolicy(ctx context.Context, flavor, sessionID string) (*Policy, error) {
	for _, pair := range []struct{ scope, value string }{
		{"session", sessionID},
		{"flavor", flavor},
		{"org", ""},
	} {
		if pair.value == "" && pair.scope != "org" {
			continue
		}
		var p Policy
		err := s.pool.QueryRow(ctx, `
			SELECT id::text, scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct, created_at, updated_at
			FROM policies WHERE scope = $1 AND scope_value = $2
		`, pair.scope, pair.value).Scan(
			&p.ID, &p.Scope, &p.ScopeValue, &p.TokenLimit, &p.WarnAtPct, &p.DegradeAtPct, &p.DegradeTo, &p.BlockAtPct, &p.CreatedAt, &p.UpdatedAt,
		)
		if err == nil {
			return &p, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("get policy %s/%s: %w", pair.scope, pair.value, err)
		}
	}
	return nil, nil
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

// GetPolicies returns all policies ordered by creation date (newest first).
func (s *Store) GetPolicies(ctx context.Context) ([]Policy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct, created_at, updated_at
		FROM policies ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("get policies: %w", err)
	}
	defer rows.Close()

	var policies []Policy
	for rows.Next() {
		var p Policy
		if err := rows.Scan(
			&p.ID, &p.Scope, &p.ScopeValue, &p.TokenLimit, &p.WarnAtPct, &p.DegradeAtPct, &p.DegradeTo, &p.BlockAtPct, &p.CreatedAt, &p.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan policy: %w", err)
		}
		policies = append(policies, p)
	}
	if policies == nil {
		policies = []Policy{} // Return empty array, not null
	}
	return policies, nil
}

// GetPolicyByID returns a single policy by ID. Returns nil if not found.
func (s *Store) GetPolicyByID(ctx context.Context, id string) (*Policy, error) {
	var p Policy
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct, created_at, updated_at
		FROM policies WHERE id = $1::uuid
	`, id).Scan(
		&p.ID, &p.Scope, &p.ScopeValue, &p.TokenLimit, &p.WarnAtPct, &p.DegradeAtPct, &p.DegradeTo, &p.BlockAtPct, &p.CreatedAt, &p.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get policy %s: %w", id, err)
	}
	return &p, nil
}

// UpsertPolicy creates or updates a policy. Returns the resulting policy with all fields.
func (s *Store) UpsertPolicy(ctx context.Context, p Policy) (*Policy, error) {
	var result Policy
	err := s.pool.QueryRow(ctx, `
		INSERT INTO policies (scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (scope, scope_value)
		DO UPDATE SET token_limit = EXCLUDED.token_limit,
		              warn_at_pct = EXCLUDED.warn_at_pct,
		              degrade_at_pct = EXCLUDED.degrade_at_pct,
		              degrade_to = EXCLUDED.degrade_to,
		              block_at_pct = EXCLUDED.block_at_pct,
		              updated_at = NOW()
		RETURNING id::text, scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct, created_at, updated_at
	`, p.Scope, p.ScopeValue, p.TokenLimit, p.WarnAtPct, p.DegradeAtPct, p.DegradeTo, p.BlockAtPct).Scan(
		&result.ID, &result.Scope, &result.ScopeValue, &result.TokenLimit, &result.WarnAtPct, &result.DegradeAtPct, &result.DegradeTo, &result.BlockAtPct, &result.CreatedAt, &result.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("upsert policy: %w", err)
	}
	return &result, nil
}

// DeletePolicy removes a policy by ID. Returns an error if not found.
func (s *Store) DeletePolicy(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, "DELETE FROM policies WHERE id = $1::uuid", id)
	if err != nil {
		return fmt.Errorf("delete policy %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}
