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
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/flightdeckhq/flightdeck/storage"
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
func sessionMarksClaudeCodeSQL(d storage.Dialect) string {
	return `(s.flavor = 'claude-code' OR EXISTS (
			SELECT 1
			FROM ` + d.JSONArrayElements(d.JSONArray("s.context", "frameworks"), "fw") + `
			WHERE ` + d.JSONElementText("fw") + ` LIKE 'claude-code%'))`
}

// agentDirectiveTargetsSQL returns the session ids of agent $1's live
// runs that can act on a directive, oldest first. A run takes a
// directive when its context.supports_directives says so, else when
// its client type is in $2 (directiveClientTypes), else, with no client
// type, unless it is marked Claude Code. With $4 (custom) it must also
// run custom handlers (client type in $3, customDirectiveClientTypes,
// with the same fallback) and run under a flavor that registered
// fingerprint $5. A non-empty $6 keeps the runs of that flavor.
func agentDirectiveTargetsSQL(d storage.Dialect) string {
	marksClaudeCode := sessionMarksClaudeCodeSQL(d)
	return `
	SELECT CAST(s.session_id AS TEXT)
	FROM sessions s
	WHERE s.agent_id = $1
	  AND s.state IN ('active', 'idle')
	  AND ($6 = '' OR s.flavor = $6)
	  AND CASE
	        WHEN ` + d.JSONTypeOf("s.context", "supports_directives") + ` = 'boolean'
	          THEN ` + d.JSONIsTrue("s.context", "supports_directives") + `
	        WHEN s.client_type IS NOT NULL THEN ` + d.InArray("s.client_type", "$2") + `
	        ELSE NOT ` + marksClaudeCode + `
	      END
	  AND (NOT $4 OR (
	        CASE
	          WHEN s.client_type IS NOT NULL THEN ` + d.InArray("s.client_type", "$3") + `
	          ELSE NOT ` + marksClaudeCode + `
	        END
	        AND s.flavor IN (
	          SELECT cd.flavor FROM custom_directives cd WHERE cd.fingerprint = $5)))
	ORDER BY s.started_at, s.session_id`
}

// GetDirectiveTargetsForAgent returns the session ids of the live runs
// of q.AgentID that a directive addressed to the agent reaches, oldest
// first. An empty result means no run of the agent can take it.
func (s *Store) GetDirectiveTargetsForAgent(ctx context.Context, q AgentDirectiveTargetQuery) ([]string, error) {
	if q.Custom && q.Fingerprint == "" {
		return nil, errors.New("directive targets: a custom directive needs its fingerprint")
	}
	rows, err := s.reader().QueryContext(ctx, agentDirectiveTargetsSQL(s.d),
		uuidArg(q.AgentID), s.d.ArrayArg(directiveClientTypes), s.d.ArrayArg(customDirectiveClientTypes),
		q.Custom, q.Fingerprint, q.Flavor)
	if err != nil {
		return nil, fmt.Errorf("directive targets for agent %s: %w", q.AgentID, err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan directive targets for agent %s: %w", q.AgentID, err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("create directives: begin: %w", err)
	}
	// A no-op once the transaction commits.
	defer func() { _ = tx.Rollback() }()

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
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("create directives: commit: %w", err)
	}
	return created, nil
}

// rowQuerier is the QueryRowContext method *sql.DB and *sql.Tx share,
// so one directive and a set of them insert through the same statement.
type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// insertDirective inserts one directive row and returns it as stored.
// The session id is normalised to the canonical lower-case form both
// backends store; the payload is bound as JSON text.
func insertDirective(ctx context.Context, q rowQuerier, d Directive) (*Directive, error) {
	var sessionID *string
	if d.SessionID != nil {
		id := uuidArg(*d.SessionID)
		sessionID = &id
	}
	var payload any
	if d.Payload != nil {
		payload = jsonArg(*d.Payload)
	}
	var result Directive
	var issuedAt storage.Time
	var deliveredAt storage.Time
	var payloadRaw []byte
	err := q.QueryRowContext(ctx, `
		INSERT INTO directives (session_id, flavor, action, reason, grace_period_ms, issued_by, payload)
		VALUES ($1, $2, $3, $4, $5, 'dashboard', $6)
		RETURNING CAST(id AS TEXT), CAST(session_id AS TEXT), flavor, action, reason, degrade_to,
		          grace_period_ms, issued_by, issued_at, delivered_at, payload
	`, sessionID, d.Flavor, d.Action, d.Reason, d.GracePeriodMs, payload).Scan(
		&result.ID, &result.SessionID, &result.Flavor, &result.Action, &result.Reason,
		&result.DegradeTo, &result.GracePeriodMs, &result.IssuedBy, &issuedAt,
		&deliveredAt, &payloadRaw,
	)
	if err != nil {
		return nil, err
	}
	result.IssuedAt = issuedAt.Time
	if deliveredAt.Valid {
		t := deliveredAt.Time
		result.DeliveredAt = &t
	}
	if payloadRaw != nil {
		raw := json.RawMessage(append([]byte(nil), payloadRaw...))
		result.Payload = &raw
	}
	return &result, nil
}
