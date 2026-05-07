// Package store provides Postgres queries for the query API.
// All queries use pgx directly -- no ORM.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NotifyChannel is the Postgres LISTEN/NOTIFY channel that carries
// real-time fleet updates from the writer (workers) and the directive
// register path (this package) to the dashboard WebSocket hub.
//
// Producers (this package's RegisterDirectives, workers/writer.NotifyFleetChange)
// and the consumer (api/internal/ws.Hub.listenOnce) MUST agree on this
// channel name. The literal is duplicated in workers/internal/writer/notify.go
// only because workers and api are separate Go modules.
const NotifyChannel = "flightdeck_fleet"

// NotifyDirectiveRegistered is the sentinel payload broadcast on
// NotifyChannel after a successful directive registration. The hub
// special-cases this literal (it has no JSON envelope) and re-broadcasts
// a directives_changed message to WebSocket clients. Keep producer and
// consumer in lock-step by referencing this constant on both sides.
const NotifyDirectiveRegistered = "directive_registered"

// Querier is the interface for fleet data access.
// Implemented by Store (Postgres) and mocks in tests.
type Querier interface {
	GetAgentFleet(ctx context.Context, limit, offset int, agentType string) ([]AgentSummary, int, error)
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	// GetSessionEvents returns events for a session in chronological
	// (ASC) order. When limit <= 0 the full history is returned; when
	// limit > 0 the caller gets at most the N newest events (the query
	// runs ``ORDER BY occurred_at DESC LIMIT N`` and the result is
	// re-sorted ASC before returning so the response shape stays
	// chronological).
	GetSessionEvents(ctx context.Context, sessionID string, limit int) ([]Event, error)
	GetEvent(ctx context.Context, eventID string) (*Event, error)
	GetSessionAttachments(ctx context.Context, sessionID string) ([]time.Time, error)
	GetEventContent(ctx context.Context, eventID string) (*EventContent, error)
	GetEffectivePolicy(ctx context.Context, flavor, sessionID string) (*Policy, error)
	GetPolicies(ctx context.Context) ([]Policy, error)
	GetPolicyByID(ctx context.Context, id string) (*Policy, error)
	UpsertPolicy(ctx context.Context, p Policy) (*Policy, error)
	UpdatePolicy(ctx context.Context, id string, p Policy) (*Policy, error)
	DeletePolicy(ctx context.Context, id string) error
	CreateDirective(ctx context.Context, d Directive) (*Directive, error)
	GetActiveSessionIDsByFlavor(ctx context.Context, flavor string) ([]string, error)
	SyncDirectives(ctx context.Context, flavor string, fingerprints []string) ([]string, error)
	RegisterDirectives(ctx context.Context, directives []CustomDirective) error
	GetCustomDirectives(ctx context.Context, flavor string) ([]CustomDirective, error)
	CustomDirectiveExists(ctx context.Context, fingerprint, flavor string) (bool, error)
	DeleteCustomDirectivesByNamePrefix(ctx context.Context, namePrefix string) (int64, error)
	GetEvents(ctx context.Context, params EventsParams) (*EventsResponse, error)
	GetSessions(ctx context.Context, params SessionsParams) (*SessionsResponse, error)
	QueryAnalytics(ctx context.Context, params AnalyticsParams) (*AnalyticsResponse, error)
	Search(ctx context.Context, query string) (*SearchResults, error)
	GetContextFacets(ctx context.Context) (map[string][]ContextFacetValue, error)
	ListAccessTokens(ctx context.Context) ([]AccessTokenRow, error)
	CreateAccessToken(ctx context.Context, name string) (*CreatedAccessTokenResponse, error)
	DeleteAccessToken(ctx context.Context, id string) error
	RenameAccessToken(ctx context.Context, id, newName string) (*AccessTokenRow, error)
	// ReconcileAgents recomputes the denormalised rollup columns on
	// the agents table from sessions ground truth, then deletes
	// orphan rows whose ``total_sessions`` post-reconcile is 0 AND
	// whose ``last_seen_at`` is older than ``orphanThreshold`` ago.
	// Pass orphanThreshold <= 0 to skip the delete step (counters-
	// only). See agents_reconcile.go for the per-agent contract,
	// concurrency notes, and orphan-delete predicate rationale.
	ReconcileAgents(ctx context.Context, orphanThreshold time.Duration) (*ReconcileResult, error)
	// ListAgents powers GET /v1/agents. See store/agents.go for the
	// full filter/sort/search contract.
	ListAgents(ctx context.Context, params AgentListParams) (*AgentListResponse, error)
	// GetAgentByID powers GET /v1/agents/{id}. Returns (nil, nil)
	// for a missing row so the handler can distinguish 404 from a
	// real DB error.
	GetAgentByID(ctx context.Context, agentID string) (*AgentSummary, error)

	// MCP Protection Policy methods (D128). Implemented in
	// mcp_policy_store.go; the SQL all lives in that file per
	// Rule 35.
	EnsureGlobalMCPPolicy(ctx context.Context) error
	GetGlobalMCPPolicy(ctx context.Context) (*MCPPolicy, error)
	GetMCPPolicy(ctx context.Context, flavor string) (*MCPPolicy, error)
	CreateMCPPolicy(ctx context.Context, flavor string, mut MCPPolicyMutation, resolvedEntries []MCPPolicyEntry, actorTokenID *string) (*MCPPolicy, error)
	UpdateMCPPolicy(ctx context.Context, scope, scopeValue string, mut MCPPolicyMutation, resolvedEntries []MCPPolicyEntry, actorTokenID *string, auditPayloadExtras map[string]any) (*MCPPolicy, error)
	DeleteMCPPolicy(ctx context.Context, flavor string, actorTokenID *string) error
	ResolveMCPPolicy(ctx context.Context, flavor, fingerprint string) (*MCPPolicyResolveResult, error)
	ListMCPPolicyAuditLog(ctx context.Context, scope, scopeValue, eventType string, from, to *time.Time, limit, offset int) ([]MCPPolicyAuditLog, error)
	GetMCPPolicyMetrics(ctx context.Context, scope, scopeValue, period string) (*MCPPolicyMetrics, error)
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
	// D115 identity columns (nullable for sessions that predate the
	// migration OR for lazy-created rows whose authoritative
	// session_start never arrived; UpsertSession's COALESCE
	// enrichment promotes these from NULL to real values on the
	// first session_start).
	AgentID    *string    `json:"agent_id,omitempty"`
	AgentName  *string    `json:"agent_name,omitempty"`
	ClientType *string    `json:"client_type,omitempty"`
	Host       *string    `json:"host"`
	Framework  *string    `json:"framework"`
	Model      *string    `json:"model"`
	State      string     `json:"state"`
	StartedAt  time.Time  `json:"started_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	TokensUsed int        `json:"tokens_used"`
	TokenLimit *int       `json:"token_limit,omitempty"`

	// Runtime context collected by the sensor at init() time and
	// stored once in sessions.context (JSONB) on the session_start
	// event. Carries hostname, OS, git, orchestration, frameworks,
	// etc. -- see sensor/flightdeck_sensor/core/context.py.
	Context map[string]any `json:"context,omitempty"`

	// TokenName is the human-readable name of the access_tokens row
	// that authenticated the session_start event (D095). Nullable:
	// tok_dev-authenticated sessions and pre-Phase-5 rows carry NULL.
	// Preserved across token revocation (sessions.token_id clears via
	// ON DELETE SET NULL but sessions.token_name is a static snapshot
	// so the dashboard can attribute historical sessions even after
	// the token row is gone). Mirrors the SessionListItem.TokenName
	// returned by GetSessions.
	TokenName *string `json:"token_name"`

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

	// CaptureEnabled is true when at least one event in this session
	// has has_content=true (i.e. prompt content was captured to
	// event_content). Computed via EXISTS subquery so no schema
	// change is required.
	CaptureEnabled bool `json:"capture_enabled"`

	// D126 sub-agent observability columns. Both nullable, both
	// populated only on sub-agent sessions (Claude Code Task
	// subagent, CrewAI agent execution, LangGraph agent-bearing
	// node). Root sessions and direct-SDK sessions carry NULL on
	// both. The dashboard's swimlane relationship pill, Sub-agents
	// tab, Investigate ROLE / PARENT columns, and Investigate
	// TOPOLOGY facets read these directly.
	ParentSessionID *string `json:"parent_session_id,omitempty"`
	AgentRole       *string `json:"agent_role,omitempty"`
}

// ContextFacetValue is a single (value, count) entry inside a context
// facet group. The fleet response groups facets by key (e.g.
// "git_branch") and lists each distinct value with the number of
// active/idle/stale sessions that have it.
type ContextFacetValue struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// Event represents an event row for API responses.
//
// Payload carries per-event-type metadata that does not fit the
// canonical schema columns -- in particular directive_name,
// directive_action, directive_status, result, error, duration_ms
// for directive_result events. Empty for events with no extra
// metadata.
type Event struct {
	ID                  string         `json:"id"`
	SessionID           string         `json:"session_id"`
	Flavor              string         `json:"flavor"`
	EventType           string         `json:"event_type"`
	Model               *string        `json:"model,omitempty"`
	TokensInput         *int           `json:"tokens_input,omitempty"`
	TokensOutput        *int           `json:"tokens_output,omitempty"`
	TokensTotal         *int           `json:"tokens_total,omitempty"`
	TokensCacheRead     int64          `json:"tokens_cache_read"`     // D100
	TokensCacheCreation int64          `json:"tokens_cache_creation"` // D100
	LatencyMs           *int           `json:"latency_ms,omitempty"`
	ToolName            *string        `json:"tool_name,omitempty"`
	HasContent          bool           `json:"has_content"`
	Payload             map[string]any `json:"payload,omitempty"`
	OccurredAt          time.Time      `json:"occurred_at"`
}

// AgentSummary is one row in the v0.4.0 Phase 1 agent-level fleet
// response. Each row represents a persistent fleet entity (an
// ``agents`` row) with aggregated state computed across its sessions.
type AgentSummary struct {
	AgentID        string    `json:"agent_id"`
	AgentName      string    `json:"agent_name"`
	AgentType      string    `json:"agent_type"`
	ClientType     string    `json:"client_type"`
	UserName       string    `json:"user"`
	Hostname       string    `json:"hostname"`
	FirstSeenAt    time.Time `json:"first_seen_at"`
	LastSeenAt     time.Time `json:"last_seen_at"`
	TotalSessions  int       `json:"total_sessions"`
	TotalTokens    int64     `json:"total_tokens"`
	// State rollup: "active" when any session under this agent is
	// currently active; otherwise the most-recent session's state.
	// Empty string when the agent has no sessions yet (freshly
	// upserted agent row awaiting its first session linkage).
	State string `json:"state"`
	// AgentRole is the framework-supplied sub-agent role string
	// (CrewAI Agent.role, LangGraph node name, Claude Code Task
	// agent_type) when this agent represents a sub-agent identity;
	// nil for root agents. Read from any one of the agent's sessions
	// — by D126 derivation every session under an agent_id shares
	// the same 6-tuple input, so agent_role is uniform across them.
	AgentRole *string `json:"agent_role,omitempty"`
	// Topology classifies this agent's place in the sub-agent graph
	// (D126):
	//   "lone"   — none of this agent's sessions carry a
	//              parent_session_id and no other agent's sessions
	//              reference one of ours as a parent
	//   "child"  — at least one session has parent_session_id IS NOT
	//              NULL (i.e. this agent runs as a sub-agent under
	//              someone else's parent session). Wins over "parent"
	//              when both apply: a sub-agent role's defining
	//              property is that its sessions are spawned by a
	//              parent, secondary nesting is incidental.
	//   "parent" — this agent's sessions are referenced as a
	//              parent_session_id by at least one other session,
	//              and the agent itself is not a child.
	Topology string `json:"topology"`
}

// GetAgentFleet returns agents with rollup state, paginated. Accepts
// optional agent_type filter (D114 vocabulary). Returns
// (agents, total_count, error).
func (s *Store) GetAgentFleet(
	ctx context.Context,
	limit, offset int,
	agentType string,
) ([]AgentSummary, int, error) {
	var args []any
	filter := ""
	if agentType != "" {
		filter = " WHERE agent_type = $1"
		args = append(args, agentType)
	}

	var totalCount int
	countArgs := args
	if err := s.pool.QueryRow(
		ctx,
		`SELECT COUNT(*) FROM agents`+filter,
		countArgs...,
	).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("get agent fleet count: %w", err)
	}

	// State rollup via LATERAL subquery against sessions for each
	// agent row: "active" if any active session exists; otherwise
	// the most-recent session's state by started_at. An agent with
	// no sessions yet reports state = '' (empty string) which the
	// dashboard renders as a muted placeholder.
	limitPlaceholder := fmt.Sprintf("$%d", len(args)+1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args)+2)
	args = append(args, limit, offset)

	query := `
		SELECT
			a.agent_id::text, a.agent_name, a.agent_type, a.client_type,
			a.user_name, a.hostname, a.first_seen_at, a.last_seen_at,
			a.total_sessions, a.total_tokens,
			COALESCE(rollup.state, '') AS state,
			d126.agent_role,
			d126.topology
		FROM agents a
		LEFT JOIN LATERAL (
			SELECT CASE
				WHEN EXISTS (
					SELECT 1 FROM sessions s
					WHERE s.agent_id = a.agent_id AND s.state = 'active'
				) THEN 'active'
				ELSE (
					SELECT s.state
					FROM sessions s
					WHERE s.agent_id = a.agent_id
					ORDER BY s.started_at DESC
					LIMIT 1
				)
			END AS state
		) rollup ON TRUE
		LEFT JOIN LATERAL (` + d126AgentRollupSQL + `) d126 ON TRUE` + filter + `
		-- ORDER BY: primary last_seen_at DESC matches user expectation
		-- ("most recently active first"). Secondary client_type ASC
		-- breaks last_seen_at ties deterministically -- critical for
		-- bulk-seeded fleets where many rows share a timestamp; without
		-- it page 1 could silently hide an entire client type. Tertiary
		-- agent_id ASC guarantees page-stable ordering so the same row
		-- does not appear on both page N and page N+1 when two agents
		-- share both timestamp AND client_type.
		ORDER BY a.last_seen_at DESC, a.client_type ASC, a.agent_id ASC
		LIMIT ` + limitPlaceholder + ` OFFSET ` + offsetPlaceholder
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("get agent fleet: %w", err)
	}
	defer rows.Close()

	// Start with a non-nil empty slice so an empty fleet encodes as
	// ``[]`` in JSON rather than ``null``. A null ``agents`` field
	// crashes the dashboard's store seed (``fleet.agents.map(...)``)
	// on empty deployments -- the frontend Array type is a hard
	// contract, not a nullable one. Matches the pattern in
	// ``sessions.go::GetSessions``.
	result := make([]AgentSummary, 0)
	for rows.Next() {
		var a AgentSummary
		var rollupState *string
		var topology *string
		if err := rows.Scan(
			&a.AgentID, &a.AgentName, &a.AgentType, &a.ClientType,
			&a.UserName, &a.Hostname, &a.FirstSeenAt, &a.LastSeenAt,
			&a.TotalSessions, &a.TotalTokens, &rollupState,
			&a.AgentRole, &topology,
		); err != nil {
			return nil, 0, fmt.Errorf("scan agent: %w", err)
		}
		if rollupState != nil {
			a.State = *rollupState
		}
		if topology != nil {
			a.Topology = *topology
		} else {
			a.Topology = "lone"
		}
		result = append(result, a)
	}
	return result, totalCount, nil
}

// d126AgentRollupSQL is the LATERAL subquery that computes the D126
// (sub-agent observability) per-agent rollup fields: agent_role and
// topology. Shared by GetAgentFleet, ListAgents, and GetAgentByID so
// the three projections stay byte-identical on the new columns.
//
//   agent_role — read from any one session under this agent_id whose
//                agent_role is non-null. By D126 identity derivation
//                every session under one agent_id shares the same
//                6-tuple including agent_role, so any-row LIMIT 1 is
//                authoritative.
//
//   topology   — "child" wins over "parent" when both apply because a
//                sub-agent role's defining property is being spawned
//                by a parent; secondary nesting is incidental. The
//                EXISTS subqueries hit the partial index
//                ``sessions_parent_session_id_idx`` directly.
const d126AgentRollupSQL = `
	SELECT
		(
			SELECT s.agent_role
			FROM sessions s
			WHERE s.agent_id = a.agent_id
			  AND s.agent_role IS NOT NULL
			LIMIT 1
		) AS agent_role,
		CASE
			WHEN EXISTS (
				SELECT 1 FROM sessions s
				WHERE s.agent_id = a.agent_id
				  AND s.parent_session_id IS NOT NULL
			) THEN 'child'
			WHEN EXISTS (
				SELECT 1
				FROM sessions ch
				JOIN sessions p
				  ON ch.parent_session_id = p.session_id
				WHERE p.agent_id = a.agent_id
			) THEN 'parent'
			ELSE 'lone'
		END AS topology
`

// GetSession returns a single session by ID, including effective policy thresholds.
// Policy lookup cascades: session scope > flavor scope > org scope.
func (s *Store) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	var sess Session
	var contextRaw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT
			s.session_id::text, s.flavor, s.agent_type,
			s.agent_id::text, s.agent_name, s.client_type,
			s.host, s.framework, s.model,
			s.state, s.started_at, s.last_seen_at, s.ended_at, s.tokens_used, s.token_limit,
			s.context, s.token_name,
			COALESCE(ps.token_limit, pf.token_limit, po.token_limit) AS policy_token_limit,
			COALESCE(ps.warn_at_pct, pf.warn_at_pct, po.warn_at_pct) AS warn_at_pct,
			COALESCE(ps.degrade_at_pct, pf.degrade_at_pct, po.degrade_at_pct) AS degrade_at_pct,
			COALESCE(ps.degrade_to, pf.degrade_to, po.degrade_to) AS degrade_to,
			COALESCE(ps.block_at_pct, pf.block_at_pct, po.block_at_pct) AS block_at_pct,
			EXISTS(
				SELECT 1 FROM events e
				WHERE e.session_id = s.session_id
				AND e.has_content = true
				LIMIT 1
			) AS capture_enabled,
			s.parent_session_id::text,
			s.agent_role
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
		&sess.AgentID, &sess.AgentName, &sess.ClientType,
		&sess.Host, &sess.Framework, &sess.Model,
		&sess.State, &sess.StartedAt, &sess.LastSeenAt,
		&sess.EndedAt, &sess.TokensUsed, &sess.TokenLimit,
		&contextRaw, &sess.TokenName,
		&sess.PolicyTokenLimit, &sess.WarnAtPct, &sess.DegradeAtPct,
		&sess.DegradeTo, &sess.BlockAtPct,
		&sess.CaptureEnabled,
		&sess.ParentSessionID, &sess.AgentRole,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session %s: %w", sessionID, err)
	}
	if len(contextRaw) > 0 {
		var v map[string]any
		if jsonErr := json.Unmarshal(contextRaw, &v); jsonErr == nil && len(v) > 0 {
			sess.Context = v
		}
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

// GetSessionEvents returns events for a session in chronological (ASC)
// order. When limit <= 0 the full history is returned (legacy behaviour
// used by Fleet-side callers that still expect the whole timeline).
// When limit > 0 the query runs ``ORDER BY occurred_at DESC LIMIT N``
// so the composite ``events(session_id, occurred_at)`` index is used
// optimally for the newest-first slice; the slice is reversed in-place
// before returning so the response shape the handler documents
// (chronological ASC) holds regardless of whether a limit was applied.
//
// The payload JSONB column is decoded into Event.Payload so callers
// (the dashboard) can read directive_name / directive_status / result
// without a separate /v1/events/:id/content fetch. NULL or empty
// payload columns yield a nil map on the Event struct, which omits
// the field from the JSON response.
func (s *Store) GetSessionEvents(ctx context.Context, sessionID string, limit int) ([]Event, error) {
	var sql string
	args := []any{sessionID}
	if limit > 0 {
		sql = `
			SELECT id::text, session_id::text, flavor, event_type, model,
			       tokens_input, tokens_output, tokens_total,
			       tokens_cache_read, tokens_cache_creation,
			       latency_ms, tool_name, has_content, payload, occurred_at
			FROM events
			WHERE session_id = $1::uuid
			ORDER BY occurred_at DESC
			LIMIT $2
		`
		args = append(args, limit)
	} else {
		sql = `
			SELECT id::text, session_id::text, flavor, event_type, model,
			       tokens_input, tokens_output, tokens_total,
			       tokens_cache_read, tokens_cache_creation,
			       latency_ms, tool_name, has_content, payload, occurred_at
			FROM events
			WHERE session_id = $1::uuid
			ORDER BY occurred_at ASC
		`
	}

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("get events for %s: %w", sessionID, err)
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
		return nil, fmt.Errorf("session events scan: %w", err)
	}

	if limit > 0 {
		// Reverse DESC → ASC so downstream consumers see events in
		// chronological order regardless of the query direction.
		for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
			events[i], events[j] = events[j], events[i]
		}
	}
	return events, nil
}

// GetEvent returns a single event by primary key. Used by the
// WebSocket hub to fetch exactly the event named in a NOTIFY payload,
// avoiding the race where re-querying GetSessionEvents and taking the
// tail would return a later event when paired writes commit close
// together. Returns (nil, nil) when the event does not exist -- this
// is possible when the hub runs the query before the insert
// transaction has committed (uncommon but valid). Caller handles the
// nil return by skipping the broadcast.
func (s *Store) GetEvent(ctx context.Context, eventID string) (*Event, error) {
	var e Event
	var payloadRaw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, session_id::text, flavor, event_type, model,
		       tokens_input, tokens_output, tokens_total,
		       tokens_cache_read, tokens_cache_creation,
		       latency_ms, tool_name, has_content, payload, occurred_at
		FROM events
		WHERE id = $1::uuid
	`, eventID).Scan(
		&e.ID, &e.SessionID, &e.Flavor, &e.EventType, &e.Model,
		&e.TokensInput, &e.TokensOutput, &e.TokensTotal,
		&e.TokensCacheRead, &e.TokensCacheCreation,
		&e.LatencyMs, &e.ToolName, &e.HasContent, &payloadRaw, &e.OccurredAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get event %s: %w", eventID, err)
	}
	if len(payloadRaw) > 0 {
		var v map[string]any
		if jsonErr := json.Unmarshal(payloadRaw, &v); jsonErr == nil && len(v) > 0 {
			e.Payload = v
		}
	}
	return &e, nil
}

// GetSessionAttachments returns every recorded attachment timestamp
// for a session in chronological order. The initial session creation
// is not an attachment, so a session that has only ever run once
// returns an empty slice. Used by the dashboard session drawer to
// draw a run separator per attachment and by GET /v1/sessions/{id} to
// surface the full attachment history.
func (s *Store) GetSessionAttachments(ctx context.Context, sessionID string) ([]time.Time, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT attached_at
		FROM session_attachments
		WHERE session_id = $1::uuid
		ORDER BY attached_at ASC
	`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("get attachments for %s: %w", sessionID, err)
	}
	defer rows.Close()

	var out []time.Time
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("scan attachment: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("attachments scan: %w", err)
	}
	return out, nil
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
	ID            string           `json:"id"`
	SessionID     *string          `json:"session_id"`
	Flavor        *string          `json:"flavor"`
	Action        string           `json:"action"`
	Reason        *string          `json:"reason"`
	DegradeTo     *string          `json:"degrade_to"`
	GracePeriodMs int              `json:"grace_period_ms"`
	IssuedBy      string           `json:"issued_by"`
	IssuedAt      time.Time        `json:"issued_at"`
	DeliveredAt   *time.Time       `json:"delivered_at"`
	Payload       *json.RawMessage `json:"payload,omitempty" swaggertype:"object"`
}

// CustomDirective represents a row in the custom_directives table.
type CustomDirective struct {
	ID           string    `json:"id"`
	Fingerprint  string    `json:"fingerprint"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Flavor       string    `json:"flavor"`
	Parameters   any       `json:"parameters"`
	RegisteredAt time.Time `json:"registered_at"`
	LastSeenAt   time.Time `json:"last_seen_at"`
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
		return nil, fmt.Errorf("create directive: %w", err)
	}
	return &result, nil
}

// EventContent represents a row in the event_content table.
//
// Phase 4 polish: ``Input`` carries the embedding request's ``input``
// parameter (string or list of strings) for ``event_type=embeddings``
// events. Chat events leave Input null and populate Messages instead.
// The dashboard's drawer branches on event_type to render via the
// appropriate viewer (PromptViewer for chat, EmbeddingsContentViewer
// for embeddings). See migration
// 000016_event_content_input.up.sql.
type EventContent struct {
	EventID      string    `json:"event_id"`
	SessionID    string    `json:"session_id"`
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	SystemPrompt *string   `json:"system_prompt"`
	Messages     any       `json:"messages"`
	Tools        any       `json:"tools"`
	Response     any       `json:"response"`
	Input        any       `json:"input,omitempty"`
	CapturedAt   time.Time `json:"captured_at"`
}

// GetEventContent returns the prompt content for an event.
// Returns nil, nil when the event has no captured content.
func (s *Store) GetEventContent(ctx context.Context, eventID string) (*EventContent, error) {
	var ec EventContent
	var messagesRaw, toolsRaw, responseRaw, inputRaw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT event_id::text, session_id::text, provider, model, system_prompt,
		       messages, tools, response, input, captured_at
		FROM event_content
		WHERE event_id = $1::uuid
	`, eventID).Scan(
		&ec.EventID, &ec.SessionID, &ec.Provider, &ec.Model, &ec.SystemPrompt,
		&messagesRaw, &toolsRaw, &responseRaw, &inputRaw, &ec.CapturedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get event content %s: %w", eventID, err)
	}

	// Unmarshal JSONB columns into any for proper JSON serialization
	if messagesRaw != nil {
		var v any
		if jsonErr := json.Unmarshal(messagesRaw, &v); jsonErr == nil {
			ec.Messages = v
		}
	}
	if toolsRaw != nil {
		var v any
		if jsonErr := json.Unmarshal(toolsRaw, &v); jsonErr == nil {
			ec.Tools = v
		}
	}
	if responseRaw != nil {
		var v any
		if jsonErr := json.Unmarshal(responseRaw, &v); jsonErr == nil {
			ec.Response = v
		}
	}
	if inputRaw != nil {
		var v any
		if jsonErr := json.Unmarshal(inputRaw, &v); jsonErr == nil {
			ec.Input = v
		}
	}

	return &ec, nil
}

// SyncDirectives checks which fingerprints are NOT registered for the
// given flavor in custom_directives. It updates last_seen_at for found
// ones and returns the unknown fingerprints.
//
// Uniqueness is scoped to (fingerprint, flavor) per D090, so a
// fingerprint registered under a different flavor is still reported as
// unknown for this flavor and the caller (sensor) will re-register it.
//
// The lookup and the last_seen_at update run in a single transaction so a
// concurrent RegisterDirectives between them cannot cause unknowns to be
// reported despite a parallel registration, or known fingerprints to skip
// the timestamp bump.
func (s *Store) SyncDirectives(ctx context.Context, flavor string, fingerprints []string) ([]string, error) {
	if len(fingerprints) == 0 {
		return []string{}, nil
	}
	if flavor == "" {
		return nil, fmt.Errorf("sync directives: flavor is required")
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("sync directives begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Find which fingerprints exist for this flavor
	rows, err := tx.Query(ctx, `
		SELECT fingerprint FROM custom_directives
		WHERE flavor = $1 AND fingerprint = ANY($2)
	`, flavor, fingerprints)
	if err != nil {
		return nil, fmt.Errorf("sync directives lookup: %w", err)
	}

	found := make(map[string]bool)
	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan fingerprint: %w", err)
		}
		found[fp] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sync directives scan: %w", err)
	}

	// Update last_seen_at for found fingerprints (scoped to flavor)
	if len(found) > 0 {
		foundFPs := make([]string, 0, len(found))
		for fp := range found {
			foundFPs = append(foundFPs, fp)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE custom_directives SET last_seen_at = NOW()
			WHERE flavor = $1 AND fingerprint = ANY($2)
		`, flavor, foundFPs); err != nil {
			return nil, fmt.Errorf("sync directives update: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("sync directives commit: %w", err)
	}

	// Return unknown fingerprints
	unknown := make([]string, 0)
	for _, fp := range fingerprints {
		if !found[fp] {
			unknown = append(unknown, fp)
		}
	}
	return unknown, nil
}

// RegisterDirectives inserts custom directives, updating last_seen_at on conflict.
//
// All upserts run inside a single transaction. After commit a NOTIFY is sent
// on the flightdeck_fleet channel so the dashboard WebSocket hub broadcasts
// a fleet update and the Directives page refreshes in real time.
func (s *Store) RegisterDirectives(ctx context.Context, directives []CustomDirective) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("register directives begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, d := range directives {
		var paramsJSON []byte
		if d.Parameters != nil {
			marshaled, mErr := json.Marshal(d.Parameters)
			if mErr != nil {
				return fmt.Errorf("marshal parameters for %s: %w", d.Fingerprint, mErr)
			}
			paramsJSON = marshaled
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO custom_directives (fingerprint, name, description, flavor, parameters)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (fingerprint, flavor) DO UPDATE SET last_seen_at = NOW()
		`, d.Fingerprint, d.Name, d.Description, d.Flavor, paramsJSON); err != nil {
			return fmt.Errorf("register directive %s: %w", d.Fingerprint, err)
		}
	}

	// Notify the dashboard hub so the Directives page updates in real time.
	if _, err := tx.Exec(ctx, `SELECT pg_notify($1, $2)`,
		NotifyChannel, NotifyDirectiveRegistered); err != nil {
		return fmt.Errorf("register directives notify: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("register directives commit: %w", err)
	}
	return nil
}

// CustomDirectiveExists returns true if a directive with the given
// fingerprint is registered. If flavor is non-empty, the lookup is
// scoped to that flavor.
func (s *Store) CustomDirectiveExists(ctx context.Context, fingerprint, flavor string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM custom_directives
			WHERE fingerprint = $1
			  AND ($2 = '' OR flavor = $2)
		)
	`, fingerprint, flavor).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("custom directive exists %s: %w", fingerprint, err)
	}
	return exists, nil
}

// DeleteCustomDirectivesByNamePrefix deletes all rows from custom_directives
// whose name starts with the given prefix. Returns the number of rows
// deleted. Intended as a dev/test utility to keep the smoke test suite
// idempotent across runs on a shared Postgres volume -- the sensor
// registers directives by fingerprint and cross-flavor collisions can
// leave stale rows pinned to an older flavor on re-runs. Production
// callers should not rely on this.
func (s *Store) DeleteCustomDirectivesByNamePrefix(ctx context.Context, namePrefix string) (int64, error) {
	if namePrefix == "" {
		return 0, fmt.Errorf("name prefix is required")
	}
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM custom_directives WHERE name LIKE $1
	`, namePrefix+"%")
	if err != nil {
		return 0, fmt.Errorf("delete custom directives: %w", err)
	}
	return tag.RowsAffected(), nil
}

// GetCustomDirectives returns all custom directives, optionally filtered by flavor.
func (s *Store) GetCustomDirectives(ctx context.Context, flavor string) ([]CustomDirective, error) {
	var rows pgx.Rows
	var err error
	if flavor != "" {
		rows, err = s.pool.Query(ctx, `
			SELECT id::text, fingerprint, name, COALESCE(description, ''), flavor,
			       parameters, registered_at, last_seen_at
			FROM custom_directives WHERE flavor = $1
			ORDER BY registered_at DESC
		`, flavor)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT id::text, fingerprint, name, COALESCE(description, ''), flavor,
			       parameters, registered_at, last_seen_at
			FROM custom_directives
			ORDER BY registered_at DESC
		`)
	}
	if err != nil {
		return nil, fmt.Errorf("get custom directives: %w", err)
	}
	defer rows.Close()

	directives := make([]CustomDirective, 0)
	for rows.Next() {
		var d CustomDirective
		var paramsRaw []byte
		if err := rows.Scan(
			&d.ID, &d.Fingerprint, &d.Name, &d.Description, &d.Flavor,
			&paramsRaw, &d.RegisteredAt, &d.LastSeenAt,
		); err != nil {
			return nil, fmt.Errorf("scan custom directive: %w", err)
		}
		if paramsRaw != nil {
			var v any
			if jsonErr := json.Unmarshal(paramsRaw, &v); jsonErr == nil {
				d.Parameters = v
			}
		}
		directives = append(directives, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("custom directives scan: %w", err)
	}
	return directives, nil
}

// GetContextFacets aggregates the runtime context dicts from every
// session the fleet view surfaces into a (key -> [(value, count)])
// map. The result powers the dashboard CONTEXT sidebar facet panel.
//
// State filter: the only excluded rows are those with an empty
// context (no runtime data to contribute). Closed and lost sessions
// are INCLUDED -- the CONTEXT panel describes the composition of
// the fleet (what frameworks/OSes/git branches this deployment has
// ever run) rather than a snapshot of live agents. See
// DECISIONS.md D097. Previously the query restricted to
// ``state IN ('active', 'idle', 'stale')`` which caused the whole
// panel to vanish the moment every session closed -- a surprising
// UX that hid useful composition data from operators running
// post-hoc investigations.
//
// Array-typed JSONB values (e.g. ``frameworks: ["langchain/0.1.12",
// "crewai/0.42.0"]``) are unnested element-by-element so each
// framework becomes its own facet entry. The previous implementation
// used ``jsonb_each_text`` which stringifies arrays as a single
// value -- the dashboard then showed
// ``["langchain/0.1.12", "crewai/0.42.0"]`` as one bogus facet
// instead of two distinct framework versions.
//
// Within each key, values are ordered by count descending so the
// most common value sits at the top of its facet group.
func (s *Store) GetContextFacets(ctx context.Context) (map[string][]ContextFacetValue, error) {
	// CROSS JOIN LATERAL on a UNION ALL: scalar values take the
	// ``#>> '{}'`` branch (extract as text) and array values take the
	// ``jsonb_array_elements_text`` branch (one row per element). The
	// jsonb_typeof guards make the two branches mutually exclusive,
	// so a row's value contributes to exactly one branch and there
	// is no double-counting.
	rows, err := s.pool.Query(ctx, `
		WITH context_pairs AS (
			SELECT key, value
			FROM sessions, jsonb_each(context)
			WHERE context != '{}'::jsonb
		)
		SELECT key, val AS value, COUNT(*) AS count
		FROM context_pairs,
		     LATERAL (
		         SELECT jsonb_array_elements_text(value) AS val
		         WHERE jsonb_typeof(value) = 'array'
		         UNION ALL
		         SELECT value #>> '{}' AS val
		         WHERE jsonb_typeof(value) <> 'array'
		     ) expanded
		GROUP BY key, val
		ORDER BY key ASC, count DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("get context facets: %w", err)
	}
	defer rows.Close()

	facets := make(map[string][]ContextFacetValue)
	for rows.Next() {
		var key, value string
		var count int
		if err := rows.Scan(&key, &value, &count); err != nil {
			return nil, fmt.Errorf("scan context facet: %w", err)
		}
		facets[key] = append(facets[key], ContextFacetValue{Value: value, Count: count})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("context facets scan: %w", err)
	}
	return facets, nil
}
