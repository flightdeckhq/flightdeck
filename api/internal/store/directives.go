// Package store -- directives.go
//
// Directive targeting for a request addressed to an agent, and the
// inserts behind POST /v1/directives (ARCHITECTURE.md, `directives`).
// A directive addressed to an agent reaches each of its live runs that
// can act on it; the rule mirrors the dashboard's
// sessionSupportsDirectives and sessionRunsCustomDirectives
// (dashboard/src/lib/directives.ts), so the API and the Fleet controls
// agree on which runs a stop or a custom directive reaches.
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// directiveClientTypes are the client types whose supports_directives
// default in the client type registry (contracts/client_types.json) is
// true: a session of one of them that does not set
// context.supports_directives can act on a directive. A parity test
// pins this list to the registry.
var directiveClientTypes = []string{"flightdeck_sensor", "claude_agent_sdk"}

// customDirectiveClientTypes are the client types the registry marks
// runs_custom_directives: their sessions run custom directive handlers.
// The others that take directives (the Claude Code plugin with
// enforcement on, the Agent SDK interceptor) answer a custom directive
// with an error. A parity test pins this list to the registry.
var customDirectiveClientTypes = []string{"flightdeck_sensor"}

// AgentDirectiveTargetQuery selects the live (active or idle) runs of
// one agent that a directive addressed to the agent reaches.
type AgentDirectiveTargetQuery struct {
	AgentID string
	// Custom selects the runs a custom directive reaches: besides
	// taking directives, a run must run custom handlers and run under a
	// flavor that registered Fingerprint.
	Custom      bool
	Fingerprint string
	// Flavor, when not empty, keeps only the runs of that flavor.
	Flavor string
}

// sessionMarksClaudeCodeSQL is true for a sessions row (aliased s)
// whose flavor or context.frameworks marks a Claude Code session: the
// dashboard's isClaudeCodeSession for a row with no client_type, so an
// old plugin row is never treated as a run that acts on directives.
const sessionMarksClaudeCodeSQL = `(s.flavor = 'claude-code' OR EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text(CASE
			WHEN jsonb_typeof(s.context->'frameworks') = 'array' THEN s.context->'frameworks'
			ELSE '[]'::jsonb END) AS fw(name)
		WHERE fw.name LIKE 'claude-code%'))`

// agentDirectiveTargetsSQL returns the session ids of agent $1's live
// runs that can act on a directive, oldest first. A run takes a
// directive when its context.supports_directives says so, else when
// its client type is in $2 (directiveClientTypes), else, with no client
// type, unless it is marked Claude Code. With $4 (custom) it must also
// run custom handlers (client type in $3, customDirectiveClientTypes,
// with the same fallback) and run under a flavor that registered
// fingerprint $5. A non-empty $6 keeps the runs of that flavor.
const agentDirectiveTargetsSQL = `
	SELECT s.session_id::text
	FROM sessions s
	WHERE s.agent_id = $1::uuid
	  AND s.state IN ('active', 'idle')
	  AND ($6::text = '' OR s.flavor = $6::text)
	  AND CASE
	        WHEN jsonb_typeof(s.context->'supports_directives') = 'boolean'
	          THEN (s.context->>'supports_directives')::boolean
	        WHEN s.client_type IS NOT NULL THEN s.client_type = ANY($2::text[])
	        ELSE NOT ` + sessionMarksClaudeCodeSQL + `
	      END
	  AND (NOT $4::boolean OR (
	        CASE
	          WHEN s.client_type IS NOT NULL THEN s.client_type = ANY($3::text[])
	          ELSE NOT ` + sessionMarksClaudeCodeSQL + `
	        END
	        AND s.flavor IN (
	          SELECT cd.flavor FROM custom_directives cd WHERE cd.fingerprint = $5::text)))
	ORDER BY s.started_at, s.session_id`

// GetDirectiveTargetsForAgent returns the session ids of the live runs
// of q.AgentID that a directive addressed to the agent reaches, oldest
// first. An empty result means no run of the agent can take it.
func (s *Store) GetDirectiveTargetsForAgent(ctx context.Context, q AgentDirectiveTargetQuery) ([]string, error) {
	if q.Custom && q.Fingerprint == "" {
		return nil, errors.New("directive targets: a custom directive needs its fingerprint")
	}
	rows, err := s.pool.Query(ctx, agentDirectiveTargetsSQL,
		q.AgentID, directiveClientTypes, customDirectiveClientTypes,
		q.Custom, q.Fingerprint, q.Flavor)
	if err != nil {
		return nil, fmt.Errorf("directive targets for agent %s: %w", q.AgentID, err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("scan directive targets for agent %s: %w", q.AgentID, err)
	}
	return ids, nil
}

// CreateDirectives inserts one directive per session, every field but
// session_id copied from tmpl, in one transaction, and returns the rows
// in sessionIDs order. When any insert fails, none is kept.
func (s *Store) CreateDirectives(ctx context.Context, tmpl Directive, sessionIDs []string) ([]Directive, error) {
	if len(sessionIDs) == 0 {
		return nil, errors.New("create directives: no sessions")
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("create directives: begin: %w", err)
	}
	// A no-op once the transaction commits.
	defer func() { _ = tx.Rollback(ctx) }()

	created := make([]Directive, 0, len(sessionIDs))
	for _, sid := range sessionIDs {
		d := tmpl
		d.SessionID = &sid
		row, err := insertDirective(ctx, tx, d)
		if err != nil {
			return nil, fmt.Errorf("create directive for session %s: %w", sid, err)
		}
		created = append(created, *row)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("create directives: commit: %w", err)
	}
	return created, nil
}

// rowQuerier is the QueryRow method the pool and a transaction share,
// so one directive and a set of them insert through the same statement.
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// insertDirective inserts one directive row and returns it as stored.
func insertDirective(ctx context.Context, q rowQuerier, d Directive) (*Directive, error) {
	var result Directive
	err := q.QueryRow(ctx, `
		INSERT INTO directives (session_id, flavor, action, reason, grace_period_ms, issued_by, payload)
		VALUES ($1, $2, $3, $4, $5, 'dashboard', $6)
		RETURNING id::text, session_id::text, flavor, action, reason, degrade_to,
		          grace_period_ms, issued_by, issued_at, delivered_at, payload
	`, d.SessionID, d.Flavor, d.Action, d.Reason, d.GracePeriodMs, d.Payload).Scan(
		&result.ID, &result.SessionID, &result.Flavor, &result.Action, &result.Reason,
		&result.DegradeTo, &result.GracePeriodMs, &result.IssuedBy, &result.IssuedAt,
		&result.DeliveredAt, &result.Payload,
	)
	if err != nil {
		return nil, err
	}
	return &result, nil
}
