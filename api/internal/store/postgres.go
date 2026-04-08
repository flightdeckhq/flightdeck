// Package store provides Postgres queries for the query API.
// All queries use pgx directly -- no ORM.
package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Querier is the interface for fleet data access.
// Implemented by Store (Postgres) and mocks in tests.
type Querier interface {
	GetFleet(ctx context.Context, limit, offset int) ([]FlavorSummary, int, error)
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	GetSessionEvents(ctx context.Context, sessionID string) ([]Event, error)
	GetEffectivePolicy(ctx context.Context, flavor, sessionID string) (*Policy, error)
	GetPolicies(ctx context.Context) ([]Policy, error)
	GetPolicyByID(ctx context.Context, id string) (*Policy, error)
	UpsertPolicy(ctx context.Context, p Policy) (*Policy, error)
	UpdatePolicy(ctx context.Context, id string, p Policy) (*Policy, error)
	DeletePolicy(ctx context.Context, id string) error
	CreateDirective(ctx context.Context, d Directive) (*Directive, error)
	GetActiveSessionIDsByFlavor(ctx context.Context, flavor string) ([]string, error)
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

	// Active policy thresholds (nullable).
	// Populated by GetSession via effective policy lookup.
	// Null if no policy applies at any scope.
	PolicyTokenLimit *int64  `json:"policy_token_limit"`
	WarnAtPct        *int    `json:"warn_at_pct"`
	DegradeAtPct     *int    `json:"degrade_at_pct"`
	DegradeTo        *string `json:"degrade_to"`
	BlockAtPct       *int    `json:"block_at_pct"`

	// HasPendingDirective is true when an undelivered shutdown directive exists.
	HasPendingDirective bool `json:"has_pending_directive"`
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

// GetFleet returns sessions grouped by flavor, excluding lost sessions.
// Limit/offset apply to the sessions query. Returns (flavors, total_session_count, error).
func (s *Store) GetFleet(ctx context.Context, limit, offset int) ([]FlavorSummary, int, error) {
	// Get total count for pagination metadata
	var totalCount int
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM sessions WHERE state != 'lost'`).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("get fleet count: %w", err)
	}

	rows, err := s.pool.Query(ctx, `
		SELECT session_id::text, flavor, agent_type, host, framework, model,
		       state, started_at, last_seen_at, ended_at, tokens_used, token_limit
		FROM sessions
		WHERE state != 'lost'
		ORDER BY flavor, started_at DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("get fleet: %w", err)
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
			return nil, 0, fmt.Errorf("scan session: %w", err)
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
	return result, totalCount, nil
}

// GetSession returns a single session by ID, including effective policy thresholds.
// Policy lookup cascades: session scope > flavor scope > org scope.
func (s *Store) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	var sess Session
	err := s.pool.QueryRow(ctx, `
		SELECT
			s.session_id::text, s.flavor, s.agent_type, s.host, s.framework, s.model,
			s.state, s.started_at, s.last_seen_at, s.ended_at, s.tokens_used, s.token_limit,
			COALESCE(ps.token_limit, pf.token_limit, po.token_limit) AS policy_token_limit,
			COALESCE(ps.warn_at_pct, pf.warn_at_pct, po.warn_at_pct) AS warn_at_pct,
			COALESCE(ps.degrade_at_pct, pf.degrade_at_pct, po.degrade_at_pct) AS degrade_at_pct,
			COALESCE(ps.degrade_to, pf.degrade_to, po.degrade_to) AS degrade_to,
			COALESCE(ps.block_at_pct, pf.block_at_pct, po.block_at_pct) AS block_at_pct
		FROM sessions s
		LEFT JOIN token_policies ps
			ON ps.scope = 'session' AND ps.scope_value = s.session_id::text
		LEFT JOIN token_policies pf
			ON pf.scope = 'flavor' AND pf.scope_value = s.flavor
		LEFT JOIN token_policies po
			ON po.scope = 'org' AND po.scope_value = ''
		WHERE s.session_id = $1::uuid
	`, sessionID).Scan(
		&sess.SessionID, &sess.Flavor, &sess.AgentType,
		&sess.Host, &sess.Framework, &sess.Model,
		&sess.State, &sess.StartedAt, &sess.LastSeenAt,
		&sess.EndedAt, &sess.TokensUsed, &sess.TokenLimit,
		&sess.PolicyTokenLimit, &sess.WarnAtPct, &sess.DegradeAtPct,
		&sess.DegradeTo, &sess.BlockAtPct,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session %s: %w", sessionID, err)
	}

	// Check for pending shutdown directive.
	// Log but do not fail the request on error -- default to false
	// so the kill switch button remains usable.
	if pdErr := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM directives
			WHERE (session_id = $1::uuid OR flavor = $2)
			AND delivered_at IS NULL
			AND action IN ('shutdown', 'shutdown_flavor')
		)
	`, sessionID, sess.Flavor).Scan(&sess.HasPendingDirective); pdErr != nil {
		slog.Warn("has_pending_directive query error", "session_id", sessionID, "err", pdErr)
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
			FROM token_policies WHERE scope = $1 AND scope_value = $2
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
		FROM token_policies ORDER BY created_at DESC
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
		FROM token_policies WHERE id = $1::uuid
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
		INSERT INTO token_policies (scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct)
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

// UpdatePolicy updates an existing policy by ID. Returns the updated policy.
// Returns pgx.ErrNoRows if the ID does not exist.
func (s *Store) UpdatePolicy(ctx context.Context, id string, p Policy) (*Policy, error) {
	var result Policy
	err := s.pool.QueryRow(ctx, `
		UPDATE token_policies
		SET scope = $2, scope_value = $3, token_limit = $4,
		    warn_at_pct = $5, degrade_at_pct = $6, degrade_to = $7,
		    block_at_pct = $8, updated_at = NOW()
		WHERE id = $1::uuid
		RETURNING id::text, scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct, created_at, updated_at
	`, id, p.Scope, p.ScopeValue, p.TokenLimit, p.WarnAtPct, p.DegradeAtPct, p.DegradeTo, p.BlockAtPct).Scan(
		&result.ID, &result.Scope, &result.ScopeValue, &result.TokenLimit, &result.WarnAtPct, &result.DegradeAtPct, &result.DegradeTo, &result.BlockAtPct, &result.CreatedAt, &result.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("update policy %s: %w", id, pgx.ErrNoRows)
	}
	if err != nil {
		return nil, fmt.Errorf("update policy %s: %w", id, err)
	}
	return &result, nil
}

// DeletePolicy removes a policy by ID. Returns an error if not found.
func (s *Store) DeletePolicy(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, "DELETE FROM token_policies WHERE id = $1::uuid", id)
	if err != nil {
		return fmt.Errorf("delete policy %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// Directive represents a row in the directives table.
type Directive struct {
	ID            string     `json:"id"`
	SessionID     *string    `json:"session_id"`
	Flavor        *string    `json:"flavor"`
	Action        string     `json:"action"`
	Reason        *string    `json:"reason"`
	DegradeTo     *string    `json:"degrade_to"`
	GracePeriodMs int        `json:"grace_period_ms"`
	IssuedBy      string     `json:"issued_by"`
	IssuedAt      time.Time  `json:"issued_at"`
	DeliveredAt   *time.Time `json:"delivered_at"`
}

// GetActiveSessionIDsByFlavor returns session IDs for active/idle sessions of a flavor.
func (s *Store) GetActiveSessionIDsByFlavor(ctx context.Context, flavor string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT session_id::text FROM sessions
		WHERE flavor = $1 AND state IN ('active', 'idle')
	`, flavor)
	if err != nil {
		return nil, fmt.Errorf("get active sessions for %s: %w", flavor, err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan session id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// CreateDirective inserts a new directive and returns the full record.
func (s *Store) CreateDirective(ctx context.Context, d Directive) (*Directive, error) {
	var result Directive
	err := s.pool.QueryRow(ctx, `
		INSERT INTO directives (session_id, flavor, action, reason, grace_period_ms, issued_by)
		VALUES ($1, $2, $3, $4, $5, 'dashboard')
		RETURNING id::text, session_id::text, flavor, action, reason, degrade_to,
		          grace_period_ms, issued_by, issued_at, delivered_at
	`, d.SessionID, d.Flavor, d.Action, d.Reason, d.GracePeriodMs).Scan(
		&result.ID, &result.SessionID, &result.Flavor, &result.Action, &result.Reason,
		&result.DegradeTo, &result.GracePeriodMs, &result.IssuedBy, &result.IssuedAt,
		&result.DeliveredAt,
	)
	if err != nil {
		return nil, fmt.Errorf("create directive: %w", err)
	}
	return &result, nil
}
