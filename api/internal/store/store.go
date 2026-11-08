// Package store provides the query API's database access through the
// storage boundary: plain database/sql against storage.DB, so the same
// queries run on SQLite and Postgres. The SQL is the common subset of
// both engines; what differs comes from storage.Dialect or from the
// per-backend fragments in queries_postgres.go / queries_sqlite.go.
// No ORM.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// NotifyChannel is the Bus channel that carries real-time fleet updates
// from the writer (workers) and the directive register path (this
// package) to the dashboard WebSocket hub. On Postgres it is the
// LISTEN/NOTIFY channel of the same name; the storage module owns the
// literal so every service spells it the same.
const NotifyChannel = storage.ChannelFleet

// AccessTokenRevokedChannel carries the id of every deleted access_tokens
// row: published by DeleteAccessToken after its commit, and on Postgres
// also by migration 000028's trigger for a row deleted outside the API.
// The token validators in this module and in ingestion drop their cached
// validations for that id.
const AccessTokenRevokedChannel = storage.ChannelAccessTokenRevoked

// NotifyDirectiveRegistered is the sentinel payload published on
// NotifyChannel after a successful directive registration. The hub
// special-cases this literal (it has no JSON envelope) and re-broadcasts
// a directives_changed message to WebSocket clients. Keep producer and
// consumer in lock-step by referencing this constant on both sides.
const NotifyDirectiveRegistered = "directive_registered"

// ErrPolicyNotFound is returned by UpdatePolicy and DeletePolicy when no
// token policy has the given id; handlers answer 404.
var ErrPolicyNotFound = errors.New("policy not found")

// Querier is the interface for fleet data access.
// Implemented by Store and mocks in tests.
type Querier interface {
	GetAgentFleet(ctx context.Context, limit, offset int, agentType string) ([]AgentSummary, int, error)
	GetSession(ctx context.Context, sessionID string) (*Session, error)
	// GetSessionEvents returns events for a session in chronological
	// (ASC) order, id breaking timestamp ties. When limit <= 0 the full
	// history is returned; when limit > 0 the caller gets at most the N
	// newest events (the query runs ``ORDER BY occurred_at DESC, id DESC
	// LIMIT N`` and the result is re-sorted ASC before returning so the
	// response shape stays chronological).
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
	// DegradeTargets and IsDegradeTarget are the models a token
	// policy's degrade_to may name (pricing.go).
	DegradeTargets(ctx context.Context) ([]PricedModel, error)
	IsDegradeTarget(ctx context.Context, modelID string) (bool, error)
	CreateDirective(ctx context.Context, d Directive) (*Directive, error)
	// CreateDirectives inserts one directive per session in one
	// transaction; GetDirectiveTargetsForAgent picks the live runs of an
	// agent a directive addressed to it reaches (directives.go).
	CreateDirectives(ctx context.Context, tmpl Directive, sessionIDs []string) ([]Directive, error)
	GetDirectiveTargetsForAgent(ctx context.Context, q AgentDirectiveTargetQuery) ([]string, error)
	GetActiveSessionIDsByFlavor(ctx context.Context, flavor string) ([]string, error)
	SyncDirectives(ctx context.Context, flavor string, fingerprints []string) ([]string, error)
	RegisterDirectives(ctx context.Context, directives []CustomDirective) error
	GetCustomDirectives(ctx context.Context, flavor string) ([]CustomDirective, error)
	CustomDirectiveExists(ctx context.Context, fingerprint, flavor string) (bool, error)
	DeleteCustomDirectivesByNamePrefix(ctx context.Context, namePrefix string) (int64, error)
	GetEvents(ctx context.Context, params EventsParams) (*EventsResponse, error)
	// GetEventFacets returns per-dimension facet counts for the
	// /events event-grain sidebar over the same filter set GetEvents
	// applies. See store/events.go.
	GetEventFacets(ctx context.Context, params EventsParams) (*EventFacets, error)
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
	// GetAgentByID is the existence check behind GET
	// /v1/agents/{id}/summary (see AgentSummaryHandler). Returns
	// (nil, nil) for a missing row so the caller can distinguish
	// 404 from a real DB error.
	GetAgentByID(ctx context.Context, agentID string) (*AgentSummary, error)
	// GetAgentState returns an agent's rolled-up state, the same
	// agentStateRollupSQL value the agent endpoints return, or "" for
	// an unknown agent. The WebSocket hub sends it with every
	// broadcast so the dashboard never derives the agent's badge from
	// the subset of runs a page happens to hold.
	GetAgentState(ctx context.Context, agentID string) (string, error)

	// AgentSummary powers GET /v1/agents/{id}/summary. The handler
	// is responsible for confirming the agent exists (via
	// GetAgentByID) before calling this; AgentSummary itself
	// returns zero-valued totals / empty series for an unknown
	// agent rather than a sentinel.
	AgentSummary(ctx context.Context, params AgentSummaryParams) (*AgentSummaryResponse, error)

	// MCP Protection Policy methods. Implemented in
	// mcp_policy_store.go; the SQL all lives in that file per
	// Rule 35.
	EnsureGlobalMCPPolicy(ctx context.Context) error
	GetGlobalMCPPolicy(ctx context.Context) (*MCPPolicy, error)
	GetMCPPolicy(ctx context.Context, flavor string) (*MCPPolicy, error)
	CreateMCPPolicy(ctx context.Context, flavor string, mut MCPPolicyMutation, resolvedEntries []MCPPolicyEntry, actorTokenID *string) (*MCPPolicy, error)
	UpdateMCPPolicy(ctx context.Context, scope, scopeValue string, mut MCPPolicyMutation, resolvedEntries []MCPPolicyEntry, actorTokenID *string, auditPayloadExtras map[string]any) (*MCPPolicy, error)
	DeleteMCPPolicy(ctx context.Context, flavor string, actorTokenID *string) error
	ResolveMCPPolicy(ctx context.Context, flavor, canonicalURL, fingerprint string) (*MCPPolicyResolveResult, error)
	ListMCPPolicyAuditLog(ctx context.Context, scope, scopeValue, eventType string, from, to *time.Time, limit, offset int) ([]MCPPolicyAuditLog, error)
	GetMCPPolicyMetrics(ctx context.Context, scope, scopeValue, period string) (*MCPPolicyMetrics, error)
}

// WrapStore returns a Querier from any compatible implementation.
func WrapStore(q Querier) Querier { return q }

// Store provides the queries for the fleet dashboard on either backend.
//
// Reads run on db.Reader() (on SQLite a pool that never waits for the
// writer); writes and read-then-write transactions run on db, the
// writer. Read-only transactions that need one snapshot for a count
// and a page run on the reader too.
type Store struct {
	db  *storage.DB
	bus storage.Bus
	d   storage.Dialect
	q   queries
}

// New creates a Store on db, publishing its notifications (directive
// registrations, token revocations) on bus.
func New(db *storage.DB, bus storage.Bus) *Store {
	return &Store{db: db, bus: bus, d: db.Dialect, q: queriesFor(db.Backend)}
}

// DB returns the database the store runs on.
func (s *Store) DB() *storage.DB { return s.db }

// reader is the handle for statements that only read.
func (s *Store) reader() *sql.DB { return s.db.Reader() }

// readTx begins a read-only transaction on the reader, so a count and
// the page it paginates come from one snapshot. REPEATABLE READ gives
// Postgres the snapshot; SQLite's read transaction has one in WAL mode
// and ignores the isolation level.
func (s *Store) readTx(ctx context.Context) (*sql.Tx, error) {
	return s.reader().BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
}

// uuidArg normalises an id a caller supplied for a uuid comparison:
// Postgres parses any spelling, SQLite compares the text, so both get
// the canonical lower-case form.
func uuidArg(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}

// jsonArg binds JSON for a JSON column: the document as text (SQLite
// stores a []byte as a BLOB, which its json functions would read as
// binary JSON), or NULL for no document.
func jsonArg(raw []byte) any {
	if raw == nil {
		return nil
	}
	return string(raw)
}

// jsonStrings scans a JSON array of strings (from queries.jsonArrayAgg)
// into a sorted, never-nil slice.
type jsonStrings []string

// Scan implements sql.Scanner.
func (j *jsonStrings) Scan(src any) error {
	*j = []string{}
	var data []byte
	switch v := src.(type) {
	case nil:
		return nil
	case string:
		data = []byte(v)
	case []byte:
		data = v
	default:
		return fmt.Errorf("store: cannot scan %T into a string array", src)
	}
	if len(data) == 0 {
		return nil
	}
	var out []string
	if err := json.Unmarshal(data, &out); err != nil {
		return fmt.Errorf("store: string array: %w", err)
	}
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	*j = out
	return nil
}

// strings returns the slice, never nil.
func (j jsonStrings) strings() []string {
	if j == nil {
		return []string{}
	}
	return j
}

// distinctJSONArray is a scalar subquery that collects the distinct
// values of expr over fromWhere ("FROM ... WHERE ...") as a JSON array
// of strings, '[]' when there are none. It replaces Postgres'
// ARRAY(SELECT DISTINCT ...) with a shape both engines produce.
func (s *Store) distinctJSONArray(expr, fromWhere string) string {
	return "(SELECT " + s.q.jsonArrayAgg("v") + " FROM (SELECT DISTINCT " + expr + " AS v " + fromWhere + ") dv)"
}

// Session represents a session row for API responses.
type Session struct {
	SessionID string `json:"session_id"`
	Flavor    string `json:"flavor"`
	AgentType string `json:"agent_type"`
	// Agent identity columns (nullable for sessions that predate the
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
	// stored once in sessions.context (JSON) on the session_start
	// event. Carries hostname, OS, git, orchestration, frameworks,
	// etc. -- see sensor/flightdeck_sensor/core/context.py.
	Context map[string]any `json:"context,omitempty"`

	// TokenName is the human-readable name of the access_tokens row
	// that authenticated the session_start event. Nullable:
	// tok_dev-authenticated sessions and rows that predate token
	// attribution carry NULL.
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

	// CapturePrompts is the session's stored capture posture
	// (sessions.capture_prompts): true or false once a session_start
	// declared it, null while none has. GetSession reads it; the
	// Prompts tab tells a capture-off run (the disabled state) from a
	// capture-on run that stored no content, which CaptureEnabled
	// alone cannot: a framework may declare capture and send nothing.
	CapturePrompts *bool `json:"capture_prompts" extensions:"x-nullable"`

	// CloseReasons lists the distinct close_reason values across the
	// session's session_end events (closeReasonsSQL), always an array.
	// The Fleet swimlane reads ``orphan_timeout`` here as a run the
	// reaper closed, which ends at its last_seen_at.
	CloseReasons []string `json:"close_reasons"`

	// Sub-agent observability columns. Both nullable, both
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
//
// Framework, ClientType, and AgentType are session-level identity
// attributes joined from `sessions` on session_id -- the events
// table carries none of them. Framework and ClientType are nullable
// on `sessions` (framework for events predating attribution and for
// Claude Code plugin sessions; client_type carries a CHECK but no
// NOT NULL constraint); AgentType is NOT NULL there. All three are
// pointers so a NULL column -- or the all-NULL row a LEFT JOIN would
// yield for the FK-precluded case of a missing session -- scans
// cleanly.
type Event struct {
	ID                  string         `json:"id"`
	SessionID           string         `json:"session_id"`
	Flavor              string         `json:"flavor"`
	EventType           string         `json:"event_type"`
	Model               *string        `json:"model,omitempty"`
	TokensInput         *int           `json:"tokens_input,omitempty"`
	TokensOutput        *int           `json:"tokens_output,omitempty"`
	TokensTotal         *int           `json:"tokens_total,omitempty"`
	TokensCacheRead     int64          `json:"tokens_cache_read"`     // prompt-cache tokens read; 0 when the provider reports none
	TokensCacheCreation int64          `json:"tokens_cache_creation"` // prompt-cache tokens written; 0 when the provider reports none
	TokensReasoning     *int64         `json:"tokens_reasoning,omitempty"`
	ModelRequested      *string        `json:"model_requested,omitempty"`
	ModelServed         *string        `json:"model_served,omitempty"`
	Provider            *string        `json:"provider,omitempty"`
	BillingMode         *string        `json:"billing_mode,omitempty"`
	Platform            *string        `json:"platform,omitempty"`
	CostReported        *float64       `json:"cost_reported,omitempty"`
	CostSource          *string        `json:"cost_source,omitempty"`
	LatencyMs           *int           `json:"latency_ms,omitempty"`
	ToolName            *string        `json:"tool_name,omitempty"`
	HasContent          bool           `json:"has_content"`
	Payload             map[string]any `json:"payload,omitempty"`
	OccurredAt          time.Time      `json:"occurred_at"`
	Framework           *string        `json:"framework,omitempty"`
	ClientType          *string        `json:"client_type,omitempty"`
	AgentType           *string        `json:"agent_type,omitempty"`
}

// AgentSummary is one row in the agent-level fleet
// response. Each row represents a persistent fleet entity (an
// “agents“ row) with aggregated state computed across its sessions.
type AgentSummary struct {
	AgentID       string    `json:"agent_id"`
	AgentName     string    `json:"agent_name"`
	AgentType     string    `json:"agent_type"`
	ClientType    string    `json:"client_type"`
	UserName      string    `json:"user"`
	Hostname      string    `json:"hostname"`
	FirstSeenAt   time.Time `json:"first_seen_at"`
	LastSeenAt    time.Time `json:"last_seen_at"`
	TotalSessions int       `json:"total_sessions"`
	TotalTokens   int64     `json:"total_tokens"`
	// State rollup: "active" when any session under this agent is
	// currently active; otherwise the most-recent session's state.
	// Empty string when the agent has no sessions yet (freshly
	// upserted agent row awaiting its first session linkage).
	State string `json:"state"`
	// AgentRole is the framework-supplied sub-agent role string
	// (CrewAI Agent.role, LangGraph node name, Claude Code Task
	// agent_type) when this agent represents a sub-agent identity;
	// nil for root agents. Read from any one of the agent's sessions
	// — by the identity derivation every session under an agent_id shares
	// the same 6-tuple input, so agent_role is uniform across them.
	AgentRole *string `json:"agent_role,omitempty"`
	// Topology classifies this agent's place in the sub-agent graph:
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
	// Runtime-context slice from the agent's MOST RECENT session's
	// `sessions.context` JSON. An agent that ran across
	// multiple hosts / branches surfaces its latest session's values
	// here — facets are single-valued per agent. Each field is null
	// when the latest session's context is absent or the JSON key
	// is missing. Sourced via one correlated lookup of the latest
	// session per agent (agentLatestSessionJoin); the per-agent
	// overhead is bounded by the page size. `Hostname` and `UserName`
	// above remain the authoritative single-valued slices for those
	// two dims (sourced from agents-table columns); these are the
	// JSON-only slices the operator slices the roster by.
	OS            *string `json:"os,omitempty"`
	Arch          *string `json:"arch,omitempty"`
	GitBranch     *string `json:"git_branch,omitempty"`
	GitRepo       *string `json:"git_repo,omitempty"`
	Orchestration *string `json:"orchestration,omitempty"`
	PythonVersion *string `json:"python_version,omitempty"`
	ProcessName   *string `json:"process_name,omitempty"`
	// Telemetry is the latest session's `context.telemetry`: "otlp"
	// when its events were reported over OpenTelemetry, null for a
	// session a hook plugin or the sensor reports. The dashboard
	// labels the agent's source from it.
	Telemetry *string `json:"telemetry,omitempty"`
	// RecentSessions carries the agent's most-recent sessions
	// (newest first, by started_at). Populated by /v1/fleet so the
	// swimlane row renders event circles regardless of whether the
	// session falls inside the paginated /v1/sessions window. The
	// per-agent cap is RecentSessionsPerAgent. Empty for agents with
	// no sessions; ``omitempty`` keeps the wire shape lean when the
	// helper is not run (e.g. on /v1/agents which keeps the leaner
	// projection).
	RecentSessions []RecentSession `json:"recent_sessions,omitempty"`
}

// RecentSession is the lean projection embedded in
// “AgentSummary.RecentSessions“. Columns mirror what the dashboard
// store's “listItemToSession“ consumes for the swimlane row; the
// heavy correlated-subquery columns of “SessionListItem“
// (error_types, policy_event_types, mcp_server_names, ...) are
// intentionally absent so the per-agent lookup stays cheap on
// fleet pages with many agents.
type RecentSession struct {
	SessionID  string  `json:"session_id"`
	Flavor     string  `json:"flavor"`
	AgentType  string  `json:"agent_type"`
	AgentID    *string `json:"agent_id,omitempty"`
	AgentName  *string `json:"agent_name,omitempty"`
	ClientType *string `json:"client_type,omitempty"`
	Host       *string `json:"host"`
	Model      *string `json:"model"`
	// Framework is the bare-name framework attribution
	// (``sessions.framework`` — e.g. ``langchain``, ``crewai``),
	// nil for direct-SDK sessions that ran without a framework.
	// Backs the /agents page framework filter chips.
	Framework       *string    `json:"framework"`
	State           string     `json:"state"`
	StartedAt       time.Time  `json:"started_at"`
	EndedAt         *time.Time `json:"ended_at"`
	LastSeenAt      time.Time  `json:"last_seen_at"`
	TokensUsed      int        `json:"tokens_used"`
	TokenLimit      *int64     `json:"token_limit"`
	CaptureEnabled  bool       `json:"capture_enabled"`
	ParentSessionID *string    `json:"parent_session_id,omitempty"`
	// ParentAgentID is the agent_id of the agent that owns
	// ParentSessionID, projected server-side via a self-join on
	// sessions.parent_session_id. Lets the dashboard's family-
	// grouped /agents sort resolve a child to its parent without
	// having to find the parent's session in either
	// AgentSummary.recent_sessions (5-cap per agent) or the
	// /v1/sessions window (100-cap server-wide) — both of which
	// can roll past the spawn-context session for a busy parent.
	// Nil when ParentSessionID is nil OR the parent session has
	// been deleted (FK is ON DELETE SET NULL).
	ParentAgentID *string `json:"parent_agent_id,omitempty"`
	AgentRole     *string `json:"agent_role,omitempty"`
	// CloseReasons lists the distinct close_reason values across the
	// session's session_end events (closeReasonsSQL), always an array.
	// A run the reaper closed is older than the Fleet's 24 h sessions
	// page, so this rollup is where the dashboard learns it was reaped.
	CloseReasons []string `json:"close_reasons"`
}

// closeReasonsSQL is the distinct close_reason values of a session's
// session_end events, sorted, as a JSON array that is never NULL.
// sessionExpr is the session id expression of the enclosing query.
// Shared by GetSession and GetRecentSessionsByAgentIDs; SessionListItem's
// listing query builds the same array.
func (s *Store) closeReasonsSQL(sessionExpr string) string {
	reason := s.d.JSONText("e.payload", "close_reason")
	return s.distinctJSONArray(reason, `FROM events e
		WHERE e.session_id = `+sessionExpr+`
		AND e.event_type = 'session_end'
		AND `+reason+` IS NOT NULL`)
}

// captureEnabledSQL is true when any event of the session aliased by
// sessionExpr stored captured content.
func captureEnabledSQL(sessionExpr string) string {
	return `EXISTS(
		SELECT 1 FROM events e
		WHERE e.session_id = ` + sessionExpr + `
		AND e.has_content = TRUE
		LIMIT 1
	)`
}

// RecentSessionsPerAgent caps the per-agent rollup on the
// /v1/fleet response. Five rows is enough to cover the swimlane's
// visible event-circle stack for a typical agent without ballooning
// payload size on fleet pages with 50+ agents; tune by observation.
const RecentSessionsPerAgent = 5

// agentProjection is the SELECT list every agent-level query projects:
// the agents row aliased a, with the rolled-up state, the sub-agent
// rollup and the latest session's context fields. agentFrom is the
// matching FROM clause.
func (s *Store) agentProjection() string {
	ctx := func(key string) string { return s.d.JSONText("latest.context", key) }
	return `
		SELECT
			CAST(a.agent_id AS TEXT), a.agent_name, a.agent_type, a.client_type,
			a.user_name, a.hostname, a.first_seen_at, a.last_seen_at,
			a.total_sessions, a.total_tokens,
			COALESCE(a.rollup_state, '') AS state,
			` + agentRoleSQL + ` AS agent_role,
			` + agentTopologySQL + ` AS topology,
			` + ctx("os") + ` AS os, ` + ctx("arch") + ` AS arch,
			` + ctx("git_branch") + ` AS git_branch, ` + ctx("git_repo") + ` AS git_repo,
			` + ctx("orchestration") + ` AS orchestration,
			` + ctx("python_version") + ` AS python_version,
			` + ctx("process_name") + ` AS process_name,
			` + ctx("telemetry") + ` AS telemetry`
}

// agentFrom is the FROM clause of the agent-level queries: the agents
// table with its rolled-up state as a.rollup_state (so filters and
// sorts can name it), joined to the agent's latest session as latest.
const agentFrom = ` FROM (` + agentsWithStateSQL + `) a ` + agentLatestSessionJoin

// agentsWithStateSQL is the agents table extended with rollup_state,
// an agent's rolled-up state: "active" if any of its sessions is
// active, otherwise the state of the most-recently-started session, or
// NULL for an agent with no sessions. The correlated subqueries run
// once per agent row that reaches the outer query.
const agentsWithStateSQL = `SELECT a.*, ` + agentStateRollupSQL + ` AS rollup_state FROM agents a`

// agentStateRollupSQL derives the agent aliased a's state from its
// sessions. Shared by ListAgents, GetAgentByID, GetAgentState and the
// agents arm of Search so the state column reads identically on /agents
// and /v1/search.
const agentStateRollupSQL = `CASE
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
	END`

// agentLatestSessionJoin joins the agents row aliased a to its most
// recently started session as latest (no row for an agent without
// sessions). The lookup rides the composite index on
// sessions(agent_id, started_at DESC); it replaces a LATERAL join,
// which SQLite lacks, with a correlated subquery both engines accept in
// an ON clause.
const agentLatestSessionJoin = `LEFT JOIN sessions latest ON latest.session_id = (
		SELECT s.session_id FROM sessions s
		WHERE s.agent_id = a.agent_id
		ORDER BY s.started_at DESC
		LIMIT 1
	)`

// agentRoleSQL is the agent aliased a's sub-agent role: read from the
// earliest session under this agent_id whose agent_role is non-null.
// By the identity derivation every session under one agent_id shares
// the same 6-tuple including agent_role, so any such row is
// authoritative; the ORDER BY makes the pick the same on both engines
// should rows ever disagree.
const agentRoleSQL = `(
		SELECT s.agent_role
		FROM sessions s
		WHERE s.agent_id = a.agent_id
		  AND s.agent_role IS NOT NULL
		ORDER BY s.started_at, s.session_id
		LIMIT 1
	)`

// agentTopologySQL classifies the agent aliased a: "child" wins over
// "parent" when both apply because a sub-agent role's defining property
// is being spawned by a parent; secondary nesting is incidental. The
// EXISTS subqueries hit the partial index sessions_parent_session_id_idx.
const agentTopologySQL = `CASE
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
	END`

// scanAgentSummary reads one agentProjection row.
func scanAgentSummary(row interface{ Scan(dest ...any) error }) (AgentSummary, error) {
	var a AgentSummary
	var topology *string
	err := row.Scan(
		&a.AgentID, &a.AgentName, &a.AgentType, &a.ClientType,
		&a.UserName, &a.Hostname, &a.FirstSeenAt, &a.LastSeenAt,
		&a.TotalSessions, &a.TotalTokens, &a.State,
		&a.AgentRole, &topology,
		&a.OS, &a.Arch, &a.GitBranch, &a.GitRepo,
		&a.Orchestration, &a.PythonVersion, &a.ProcessName,
		&a.Telemetry,
	)
	if err != nil {
		return a, err
	}
	if topology != nil {
		a.Topology = *topology
	} else {
		a.Topology = "lone"
	}
	return a, nil
}

// GetAgentFleet returns agents with rollup state, paginated. Accepts
// optional agent_type filter (locked vocabulary). Returns
// (agents, total_count, error).
func (s *Store) GetAgentFleet(
	ctx context.Context,
	limit, offset int,
	agentType string,
) ([]AgentSummary, int, error) {
	var args []any
	filter := ""
	if agentType != "" {
		filter = " WHERE a.agent_type = $1"
		args = append(args, agentType)
	}

	var totalCount int
	countArgs := args
	if err := s.reader().QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM agents a`+filter,
		countArgs...,
	).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("get agent fleet count: %w", err)
	}

	limitPlaceholder := fmt.Sprintf("$%d", len(args)+1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args)+2)
	args = append(args, limit, offset)

	// ORDER BY: primary last_seen_at DESC matches user expectation
	// ("most recently active first"). Secondary client_type ASC
	// breaks last_seen_at ties deterministically -- critical for
	// bulk-seeded fleets where many rows share a timestamp; without
	// it page 1 could silently hide an entire client type. Tertiary
	// agent_id ASC guarantees page-stable ordering so the same row
	// does not appear on both page N and page N+1 when two agents
	// share both timestamp AND client_type.
	query := s.agentProjection() + agentFrom + filter + `
		ORDER BY a.last_seen_at DESC, a.client_type ASC, a.agent_id ASC
		LIMIT ` + limitPlaceholder + ` OFFSET ` + offsetPlaceholder
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("get agent fleet: %w", err)
	}
	defer func() { _ = rows.Close() }()

	// Start with a non-nil empty slice so an empty fleet encodes as
	// ``[]`` in JSON rather than ``null``. A null ``agents`` field
	// crashes the dashboard's store seed (``fleet.agents.map(...)``)
	// on empty deployments -- the frontend Array type is a hard
	// contract, not a nullable one. Matches the pattern in
	// ``sessions.go::GetSessions``.
	result := make([]AgentSummary, 0)
	for rows.Next() {
		a, err := scanAgentSummary(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("scan agent: %w", err)
		}
		result = append(result, a)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate agent fleet: %w", err)
	}

	// Attach the per-agent recent-sessions rollup so the swimlane
	// can render event circles even when the session falls outside
	// the paginated /v1/sessions window. One batched query keyed
	// off the page's agent_ids; result is merged in O(n) below.
	if len(result) > 0 {
		ids := make([]string, len(result))
		for i, a := range result {
			ids[i] = a.AgentID
		}
		recent, err := s.GetRecentSessionsByAgentIDs(
			ctx, ids, RecentSessionsPerAgent,
		)
		if err != nil {
			return nil, 0, fmt.Errorf("attach recent sessions: %w", err)
		}
		for i := range result {
			if rs, ok := recent[result[i].AgentID]; ok {
				result[i].RecentSessions = rs
			}
		}
	}
	return result, totalCount, nil
}

// GetRecentSessionsByAgentIDs returns the most recent “perAgent“
// sessions per supplied “agent_id“. Output is keyed by agent_id so
// callers can attach the slice to each “AgentSummary“ in O(1).
// Used by “GetAgentFleet“ to populate
// “AgentSummary.RecentSessions“; the swimlane consumes this slice
// directly so a sub-agent whose session was upserted hours ago (and
// thus falls outside the 100-row /v1/sessions page) still renders
// event circles when its row materialises.
//
// Window function: “ROW_NUMBER() OVER (PARTITION BY agent_id ORDER
// BY started_at DESC, session_id ASC)“. The session_id tie-breaker
// keeps the ordering deterministic when two sessions share a
// “started_at“ timestamp — without it, two adjacent reads could
// return different rows for the same agent (the planner is free to
// swap rows with equal sort keys).
//
// Empty “agentIDs“ or non-positive “perAgent“ short-circuits to
// an empty map without hitting the database.
func (s *Store) GetRecentSessionsByAgentIDs(
	ctx context.Context, agentIDs []string, perAgent int,
) (map[string][]RecentSession, error) {
	out := make(map[string][]RecentSession)
	if len(agentIDs) == 0 || perAgent <= 0 {
		return out, nil
	}
	ids := make([]string, len(agentIDs))
	for i, id := range agentIDs {
		ids[i] = uuidArg(id)
	}

	// LEFT JOIN sessions back on parent_session_id to project the
	// parent's agent_id directly. The join is on the UUID PK so it's
	// cheap; per agent the inner SELECT yields perAgent rows max,
	// so the total join fan-out is bounded by perAgent × len(agentIDs).
	// parent_s.agent_id is NULL when the session has no parent OR
	// when the parent session was deleted (FK ON DELETE SET NULL).
	query := `
		SELECT
			t.session_id, t.flavor, t.agent_type, t.agent_id,
			t.agent_name, t.client_type, t.host, t.model, t.framework,
			t.state,
			t.started_at, t.ended_at, t.last_seen_at, t.tokens_used,
			t.token_limit, t.capture_enabled,
			t.parent_session_id, t.parent_agent_id, t.agent_role,
			` + s.closeReasonsSQL("t.session_key") + ` AS close_reasons
		FROM (
			SELECT
				s.session_id AS session_key,
				CAST(s.session_id AS TEXT) AS session_id,
				s.flavor,
				s.agent_type,
				CAST(s.agent_id AS TEXT) AS agent_id,
				s.agent_name,
				s.client_type,
				s.host,
				s.model,
				s.framework,
				s.state,
				s.started_at,
				s.ended_at,
				s.last_seen_at,
				s.tokens_used,
				s.token_limit,
				` + captureEnabledSQL("s.session_id") + ` AS capture_enabled,
				CAST(s.parent_session_id AS TEXT) AS parent_session_id,
				CAST(parent_s.agent_id AS TEXT) AS parent_agent_id,
				s.agent_role,
				ROW_NUMBER() OVER (
					PARTITION BY s.agent_id
					ORDER BY s.started_at DESC, s.session_id ASC
				) AS rn
			FROM sessions s
			LEFT JOIN sessions parent_s
				ON parent_s.session_id = s.parent_session_id
			WHERE ` + s.d.InUUIDArray("s.agent_id", "$1") + `
		) t
		WHERE t.rn <= $2
		ORDER BY t.agent_id, t.started_at DESC, t.session_id ASC
	`
	rows, err := s.reader().QueryContext(ctx, query, s.d.ArrayArg(ids), perAgent)
	if err != nil {
		return nil, fmt.Errorf("recent sessions by agent ids: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var r RecentSession
		var closeReasons jsonStrings
		if err := rows.Scan(
			&r.SessionID, &r.Flavor, &r.AgentType, &r.AgentID,
			&r.AgentName, &r.ClientType, &r.Host, &r.Model,
			&r.Framework, &r.State,
			&r.StartedAt, &r.EndedAt, &r.LastSeenAt, &r.TokensUsed,
			&r.TokenLimit, &r.CaptureEnabled,
			&r.ParentSessionID, &r.ParentAgentID, &r.AgentRole,
			&closeReasons,
		); err != nil {
			return nil, fmt.Errorf("scan recent session: %w", err)
		}
		r.CloseReasons = closeReasons.strings()
		if r.AgentID != nil {
			out[*r.AgentID] = append(out[*r.AgentID], r)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("recent sessions rows: %w", err)
	}
	return out, nil
}

// GetSession returns a single session by ID, including effective policy thresholds.
// Policy lookup cascades: session scope > flavor scope > org scope.
func (s *Store) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	var sess Session
	var contextRaw []byte
	var closeReasons jsonStrings
	err := s.reader().QueryRowContext(ctx, `
		SELECT
			CAST(s.session_id AS TEXT), s.flavor, s.agent_type,
			CAST(s.agent_id AS TEXT), s.agent_name, s.client_type,
			s.host, s.framework, s.model,
			s.state, s.started_at, s.last_seen_at, s.ended_at, s.tokens_used, s.token_limit,
			s.context, s.token_name,
			COALESCE(ps.token_limit, pf.token_limit, po.token_limit) AS policy_token_limit,
			COALESCE(ps.warn_at_pct, pf.warn_at_pct, po.warn_at_pct) AS warn_at_pct,
			COALESCE(ps.degrade_at_pct, pf.degrade_at_pct, po.degrade_at_pct) AS degrade_at_pct,
			COALESCE(ps.degrade_to, pf.degrade_to, po.degrade_to) AS degrade_to,
			COALESCE(ps.block_at_pct, pf.block_at_pct, po.block_at_pct) AS block_at_pct,
			`+captureEnabledSQL("s.session_id")+` AS capture_enabled,
			s.capture_prompts,
			CAST(s.parent_session_id AS TEXT),
			s.agent_role,
			`+s.closeReasonsSQL("s.session_id")+` AS close_reasons
		FROM sessions s
		LEFT JOIN token_policies ps
			ON ps.scope = 'session' AND ps.scope_value = CAST(s.session_id AS TEXT)
		LEFT JOIN token_policies pf
			ON pf.scope = 'flavor' AND pf.scope_value = s.flavor
		LEFT JOIN token_policies po
			ON po.scope = 'org' AND po.scope_value = ''
		WHERE s.session_id = $1
	`, uuidArg(sessionID)).Scan(
		&sess.SessionID, &sess.Flavor, &sess.AgentType,
		&sess.AgentID, &sess.AgentName, &sess.ClientType,
		&sess.Host, &sess.Framework, &sess.Model,
		&sess.State, &sess.StartedAt, &sess.LastSeenAt,
		&sess.EndedAt, &sess.TokensUsed, &sess.TokenLimit,
		&contextRaw, &sess.TokenName,
		&sess.PolicyTokenLimit, &sess.WarnAtPct, &sess.DegradeAtPct,
		&sess.DegradeTo, &sess.BlockAtPct,
		&sess.CaptureEnabled, &sess.CapturePrompts,
		&sess.ParentSessionID, &sess.AgentRole,
		&closeReasons,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session %s: %w", sessionID, err)
	}
	sess.CloseReasons = closeReasons.strings()
	if len(contextRaw) > 0 {
		var v map[string]any
		if jsonErr := json.Unmarshal(contextRaw, &v); jsonErr == nil && len(v) > 0 {
			sess.Context = v
		}
	}

	// Check for pending shutdown directive.
	// Log but do not fail the request on error -- default to false
	// so the kill switch button remains usable.
	if pdErr := s.reader().QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM directives
			WHERE (session_id = $1 OR flavor = $2)
			AND delivered_at IS NULL
			AND action IN ('shutdown', 'shutdown_flavor')
		)
	`, uuidArg(sessionID), sess.Flavor).Scan(&sess.HasPendingDirective); pdErr != nil {
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

// policyColumns is the SELECT / RETURNING list every token_policies
// read projects, in the order scanPolicy reads it.
const policyColumns = `CAST(id AS TEXT), scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct, created_at, updated_at`

// scanPolicy reads one policyColumns row. The timestamps go through
// storage.Time: a RETURNING clause reports no column type on SQLite.
func scanPolicy(row interface{ Scan(dest ...any) error }) (Policy, error) {
	var p Policy
	var created, updated storage.Time
	err := row.Scan(&p.ID, &p.Scope, &p.ScopeValue, &p.TokenLimit, &p.WarnAtPct,
		&p.DegradeAtPct, &p.DegradeTo, &p.BlockAtPct, &created, &updated)
	p.CreatedAt, p.UpdatedAt = created.Time, updated.Time
	return p, err
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
		p, err := scanPolicy(s.reader().QueryRowContext(ctx, `
			SELECT `+policyColumns+`
			FROM token_policies WHERE scope = $1 AND scope_value = $2
		`, pair.scope, pair.value))
		if err == nil {
			return &p, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("get policy %s/%s: %w", pair.scope, pair.value, err)
		}
	}
	return nil, nil
}

// tokenCostColumns lists the events token and cost columns in the order
// Event's TokensReasoning .. CostSource fields scan them, each column
// qualified with prefix (an alias and a dot, or "" for none).
// cost_reported is NUMERIC and is read as a double for the JSON response.
func tokenCostColumns(prefix string) string {
	return prefix + "tokens_reasoning, " + prefix + "model_requested, " +
		prefix + "model_served, " + prefix + "provider, " +
		prefix + "billing_mode, " + prefix + "platform, " +
		"CAST(" + prefix + "cost_reported AS DOUBLE PRECISION), " + prefix + "cost_source"
}

// eventColumns is the SELECT list of an events row, qualified with
// prefix, in the order scanEvent reads it.
func eventColumns(prefix string) string {
	return `CAST(` + prefix + `id AS TEXT), CAST(` + prefix + `session_id AS TEXT), ` +
		prefix + `flavor, ` + prefix + `event_type, ` + prefix + `model,
		       ` + prefix + `tokens_input, ` + prefix + `tokens_output, ` + prefix + `tokens_total,
		       ` + prefix + `tokens_cache_read, ` + prefix + `tokens_cache_creation,
		       ` + tokenCostColumns(prefix) + `,
		       ` + prefix + `latency_ms, ` + prefix + `tool_name, ` + prefix + `has_content, ` +
		prefix + `payload, ` + prefix + `occurred_at`
}

// scanEvent reads one eventColumns row, plus extra trailing columns.
func scanEvent(row interface{ Scan(dest ...any) error }, extra ...any) (Event, error) {
	var e Event
	var payloadRaw []byte
	dest := []any{
		&e.ID, &e.SessionID, &e.Flavor, &e.EventType, &e.Model,
		&e.TokensInput, &e.TokensOutput, &e.TokensTotal,
		&e.TokensCacheRead, &e.TokensCacheCreation,
		&e.TokensReasoning, &e.ModelRequested, &e.ModelServed, &e.Provider,
		&e.BillingMode, &e.Platform, &e.CostReported, &e.CostSource,
		&e.LatencyMs, &e.ToolName, &e.HasContent, &payloadRaw, &e.OccurredAt,
	}
	dest = append(dest, extra...)
	if err := row.Scan(dest...); err != nil {
		return e, err
	}
	if len(payloadRaw) > 0 {
		var v map[string]any
		if jsonErr := json.Unmarshal(payloadRaw, &v); jsonErr == nil && len(v) > 0 {
			e.Payload = v
		}
	}
	return e, nil
}

// GetSessionEvents returns events for a session in chronological (ASC)
// order. When limit <= 0 the full history is returned (legacy behaviour
// used by Fleet-side callers that still expect the whole timeline).
// When limit > 0 the query runs “ORDER BY occurred_at DESC, id DESC
// LIMIT N“ so the composite “events(session_id, occurred_at)“ index
// is used optimally for the newest-first slice; the slice is reversed
// in-place before returning so the response shape the handler documents
// (chronological ASC) holds regardless of whether a limit was applied.
//
// id breaks occurred_at ties, as in GetEvents, so the capped slice ends
// on a well-defined row: the run drawer pages further back from its
// oldest event with GetEvents' (Before, BeforeID) keyset, which follows
// the same order, and so neither skips nor repeats the events that
// share that event's timestamp.
//
// The payload JSON column is decoded into Event.Payload so callers
// (the dashboard) can read directive_name / directive_status / result
// without a separate /v1/events/:id/content fetch. NULL or empty
// payload columns yield a nil map on the Event struct, which omits
// the field from the JSON response.
func (s *Store) GetSessionEvents(ctx context.Context, sessionID string, limit int) ([]Event, error) {
	var query string
	args := []any{uuidArg(sessionID)}
	if limit > 0 {
		query = `
			SELECT ` + eventColumns("") + `
			FROM events
			WHERE session_id = $1
			ORDER BY occurred_at DESC, id DESC
			LIMIT $2
		`
		args = append(args, limit)
	} else {
		query = `
			SELECT ` + eventColumns("") + `
			FROM events
			WHERE session_id = $1
			ORDER BY occurred_at ASC, id ASC
		`
	}

	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get events for %s: %w", sessionID, err)
	}
	defer func() { _ = rows.Close() }()

	var events []Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
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
// WebSocket hub to fetch exactly the event named in a fleet
// notification, avoiding the race where re-querying GetSessionEvents
// and taking the tail would return a later event when paired writes
// commit close together. Returns (nil, nil) when the event does not
// exist -- this is possible when the hub runs the query before the
// insert transaction has committed (uncommon but valid). Caller handles
// the nil return by skipping the broadcast.
func (s *Store) GetEvent(ctx context.Context, eventID string) (*Event, error) {
	e, err := scanEvent(s.reader().QueryRowContext(ctx, `
		SELECT `+eventColumns("")+`
		FROM events
		WHERE id = $1
	`, uuidArg(eventID)))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get event %s: %w", eventID, err)
	}
	return &e, nil
}

// GetSessionAttachments returns every recorded attachment timestamp
// for a session in chronological order. The initial session creation
// is not an attachment, so a session that has only ever run once
// returns an empty slice. GET /v1/sessions/{id} returns the full
// attachment history, which the dashboard uses to mark each
// re-attachment's session_start (the session drawer's ATTACH badge,
// the swimlane's amber circle).
func (s *Store) GetSessionAttachments(ctx context.Context, sessionID string) ([]time.Time, error) {
	rows, err := s.reader().QueryContext(ctx, `
		SELECT attached_at
		FROM session_attachments
		WHERE session_id = $1
		ORDER BY attached_at ASC
	`, uuidArg(sessionID))
	if err != nil {
		return nil, fmt.Errorf("get attachments for %s: %w", sessionID, err)
	}
	defer func() { _ = rows.Close() }()

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
	rows, err := s.reader().QueryContext(ctx, `
		SELECT `+policyColumns+`
		FROM token_policies ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("get policies: %w", err)
	}
	defer func() { _ = rows.Close() }()

	policies := []Policy{} // Return empty array, not null
	for rows.Next() {
		p, err := scanPolicy(rows)
		if err != nil {
			return nil, fmt.Errorf("scan policy: %w", err)
		}
		policies = append(policies, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("policies scan: %w", err)
	}
	return policies, nil
}

// GetPolicyByID returns a single policy by ID. Returns nil if not found.
func (s *Store) GetPolicyByID(ctx context.Context, id string) (*Policy, error) {
	p, err := scanPolicy(s.reader().QueryRowContext(ctx, `
		SELECT `+policyColumns+`
		FROM token_policies WHERE id = $1
	`, uuidArg(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get policy %s: %w", id, err)
	}
	return &p, nil
}

// UpsertPolicy creates or updates a policy. Returns the resulting policy with all fields.
func (s *Store) UpsertPolicy(ctx context.Context, p Policy) (*Policy, error) {
	result, err := scanPolicy(s.db.QueryRowContext(ctx, `
		INSERT INTO token_policies (scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (scope, scope_value)
		DO UPDATE SET token_limit = EXCLUDED.token_limit,
		              warn_at_pct = EXCLUDED.warn_at_pct,
		              degrade_at_pct = EXCLUDED.degrade_at_pct,
		              degrade_to = EXCLUDED.degrade_to,
		              block_at_pct = EXCLUDED.block_at_pct,
		              updated_at = `+s.d.Now()+`
		RETURNING `+policyColumns+`
	`, p.Scope, p.ScopeValue, p.TokenLimit, p.WarnAtPct, p.DegradeAtPct, p.DegradeTo, p.BlockAtPct))
	if err != nil {
		return nil, fmt.Errorf("upsert policy: %w", err)
	}
	return &result, nil
}

// UpdatePolicy updates an existing policy by ID. Returns the updated policy.
// Returns ErrPolicyNotFound if the ID does not exist.
func (s *Store) UpdatePolicy(ctx context.Context, id string, p Policy) (*Policy, error) {
	result, err := scanPolicy(s.db.QueryRowContext(ctx, `
		UPDATE token_policies
		SET scope = $2, scope_value = $3, token_limit = $4,
		    warn_at_pct = $5, degrade_at_pct = $6, degrade_to = $7,
		    block_at_pct = $8, updated_at = `+s.d.Now()+`
		WHERE id = $1
		RETURNING `+policyColumns+`
	`, uuidArg(id), p.Scope, p.ScopeValue, p.TokenLimit, p.WarnAtPct, p.DegradeAtPct, p.DegradeTo, p.BlockAtPct))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("update policy %s: %w", id, ErrPolicyNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("update policy %s: %w", id, err)
	}
	return &result, nil
}

// DeletePolicy removes a policy by ID. Returns ErrPolicyNotFound if not found.
func (s *Store) DeletePolicy(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM token_policies WHERE id = $1", uuidArg(id))
	if err != nil {
		return fmt.Errorf("delete policy %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrPolicyNotFound
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
	rows, err := s.reader().QueryContext(ctx, `
		SELECT CAST(session_id AS TEXT) FROM sessions
		WHERE flavor = $1 AND state IN ('active', 'idle')
	`, flavor)
	if err != nil {
		return nil, fmt.Errorf("get active sessions for %s: %w", flavor, err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan session id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("active sessions scan: %w", err)
	}
	return ids, nil
}

// CreateDirective inserts a new directive and returns the full record.
// CreateDirectives (directives.go) inserts a set in one transaction.
func (s *Store) CreateDirective(ctx context.Context, d Directive) (*Directive, error) {
	result, err := insertDirective(ctx, s.db, d)
	if err != nil {
		return nil, fmt.Errorf("create directive: %w", err)
	}
	return result, nil
}

// EventContent represents a row in the event_content table.
//
// “Input“ carries the embedding request's “input“
// parameter (string or list of strings) for “event_type=embeddings“
// events. Chat events leave Input null and populate Messages instead.
// The dashboard's drawer branches on event_type to render via the
// appropriate viewer (PromptViewer for chat, EmbeddingsContentViewer
// for embeddings). See migration
// 000016_event_content_input.up.sql.
type EventContent struct {
	EventID      string  `json:"event_id"`
	SessionID    string  `json:"session_id"`
	Provider     string  `json:"provider"`
	Model        string  `json:"model"`
	SystemPrompt *string `json:"system_prompt"`
	Messages     any     `json:"messages"`
	Tools        any     `json:"tools"`
	Response     any     `json:"response"`
	Input        any     `json:"input,omitempty"`
	// tool_input + tool_output carry the
	// captured arguments and result for mcp_tool_call / mcp_prompt_get
	// / LLM-side tool_call events. The dashboard branches on event_type
	// to render the appropriate viewer; without these fields landing
	// in the response the operator-paid-for capture is silently lost
	// at the read boundary.
	ToolInput  any       `json:"tool_input,omitempty"`
	ToolOutput any       `json:"tool_output,omitempty"`
	CapturedAt time.Time `json:"captured_at"`
}

// decodeJSON unmarshals a JSON column into any; nil for NULL or a
// document that does not parse.
func decodeJSON(raw []byte) any {
	if raw == nil {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

// GetEventContent returns the prompt content for an event.
// Returns nil, nil when the event has no captured content.
func (s *Store) GetEventContent(ctx context.Context, eventID string) (*EventContent, error) {
	var ec EventContent
	var messagesRaw, toolsRaw, responseRaw, inputRaw, toolInputRaw, toolOutputRaw []byte
	err := s.reader().QueryRowContext(ctx, `
		SELECT CAST(event_id AS TEXT), CAST(session_id AS TEXT), provider, model, system_prompt,
		       messages, tools, response, input, tool_input, tool_output,
		       captured_at
		FROM event_content
		WHERE event_id = $1
	`, uuidArg(eventID)).Scan(
		&ec.EventID, &ec.SessionID, &ec.Provider, &ec.Model, &ec.SystemPrompt,
		&messagesRaw, &toolsRaw, &responseRaw, &inputRaw,
		&toolInputRaw, &toolOutputRaw,
		&ec.CapturedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get event content %s: %w", eventID, err)
	}

	ec.Messages = decodeJSON(messagesRaw)
	ec.Tools = decodeJSON(toolsRaw)
	ec.Response = decodeJSON(responseRaw)
	ec.Input = decodeJSON(inputRaw)
	ec.ToolInput = decodeJSON(toolInputRaw)
	ec.ToolOutput = decodeJSON(toolOutputRaw)
	return &ec, nil
}

// SyncDirectives checks which fingerprints are NOT registered for the
// given flavor in custom_directives. It updates last_seen_at for found
// ones and returns the unknown fingerprints.
//
// Uniqueness is scoped to (fingerprint, flavor), so a
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

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("sync directives begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Find which fingerprints exist for this flavor
	rows, err := tx.QueryContext(ctx, `
		SELECT fingerprint FROM custom_directives
		WHERE flavor = $1 AND `+s.d.InArray("fingerprint", "$2")+`
	`, flavor, s.d.ArrayArg(fingerprints))
	if err != nil {
		return nil, fmt.Errorf("sync directives lookup: %w", err)
	}

	found := make(map[string]bool)
	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan fingerprint: %w", err)
		}
		found[fp] = true
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("sync directives scan: %w", err)
	}
	// The rows are closed before the next statement on the
	// transaction: on SQLite the writer is one connection.
	_ = rows.Close()

	// Update last_seen_at for found fingerprints (scoped to flavor)
	if len(found) > 0 {
		foundFPs := make([]string, 0, len(found))
		for fp := range found {
			foundFPs = append(foundFPs, fp)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE custom_directives SET last_seen_at = `+s.d.Now()+`
			WHERE flavor = $1 AND `+s.d.InArray("fingerprint", "$2")+`
		`, flavor, s.d.ArrayArg(foundFPs)); err != nil {
			return nil, fmt.Errorf("sync directives update: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
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
// All upserts run inside a single transaction. After commit a
// notification is published on the fleet channel so the dashboard
// WebSocket hub broadcasts a fleet update and the Directives page
// refreshes in real time.
func (s *Store) RegisterDirectives(ctx context.Context, directives []CustomDirective) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("register directives begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, d := range directives {
		var paramsJSON []byte
		if d.Parameters != nil {
			marshaled, mErr := json.Marshal(d.Parameters)
			if mErr != nil {
				return fmt.Errorf("marshal parameters for %s: %w", d.Fingerprint, mErr)
			}
			paramsJSON = marshaled
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO custom_directives (fingerprint, name, description, flavor, parameters)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (fingerprint, flavor) DO UPDATE SET last_seen_at = `+s.d.Now()+`
		`, d.Fingerprint, d.Name, d.Description, d.Flavor, jsonArg(paramsJSON)); err != nil {
			return fmt.Errorf("register directive %s: %w", d.Fingerprint, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("register directives commit: %w", err)
	}

	// Notify the dashboard hub so the Directives page updates in real
	// time. The rows are committed; a failed publish only delays the
	// page's refresh to its next fetch.
	if err := s.bus.Publish(ctx, NotifyChannel, NotifyDirectiveRegistered); err != nil {
		slog.Warn("directive registration notification not published", "err", err)
	}
	return nil
}

// CustomDirectiveExists returns true if a directive with the given
// fingerprint is registered. If flavor is non-empty, the lookup is
// scoped to that flavor.
func (s *Store) CustomDirectiveExists(ctx context.Context, fingerprint, flavor string) (bool, error) {
	var exists bool
	err := s.reader().QueryRowContext(ctx, `
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
// idempotent across runs on a shared database -- the sensor
// registers directives by fingerprint and cross-flavor collisions can
// leave stale rows pinned to an older flavor on re-runs. Production
// callers should not rely on this.
func (s *Store) DeleteCustomDirectivesByNamePrefix(ctx context.Context, namePrefix string) (int64, error) {
	if namePrefix == "" {
		return 0, fmt.Errorf("name prefix is required")
	}
	res, err := s.db.ExecContext(ctx, `
		DELETE FROM custom_directives WHERE name LIKE $1 ESCAPE '\'
	`, likeEscape(namePrefix)+"%")
	if err != nil {
		return 0, fmt.Errorf("delete custom directives: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("delete custom directives: %w", err)
	}
	return n, nil
}

// GetCustomDirectives returns all custom directives, optionally filtered by flavor.
func (s *Store) GetCustomDirectives(ctx context.Context, flavor string) ([]CustomDirective, error) {
	query := `
		SELECT CAST(id AS TEXT), fingerprint, name, COALESCE(description, ''), flavor,
		       parameters, registered_at, last_seen_at
		FROM custom_directives`
	var args []any
	if flavor != "" {
		query += ` WHERE flavor = $1`
		args = append(args, flavor)
	}
	query += ` ORDER BY registered_at DESC`
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get custom directives: %w", err)
	}
	defer func() { _ = rows.Close() }()

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
		d.Parameters = decodeJSON(paramsRaw)
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
// ever run) rather than a snapshot of live agents. An earlier
// version of the query restricted to
// “state IN ('active', 'idle', 'stale')“ which caused the whole
// panel to vanish the moment every session closed -- a surprising
// UX that hid useful composition data from operators running
// post-hoc investigations.
//
// Array-typed JSON values (e.g. “frameworks: ["langchain/0.1.12",
// "crewai/0.42.0"]“) are unnested element-by-element so each
// framework becomes its own facet entry; a stringified array as one
// value would show as one bogus facet instead of two distinct
// framework versions.
//
// Within each key, values are ordered by count descending so the
// most common value sits at the top of its facet group.
func (s *Store) GetContextFacets(ctx context.Context) (map[string][]ContextFacetValue, error) {
	rows, err := s.reader().QueryContext(ctx, s.q.contextFacets())
	if err != nil {
		return nil, fmt.Errorf("get context facets: %w", err)
	}
	defer func() { _ = rows.Close() }()

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
