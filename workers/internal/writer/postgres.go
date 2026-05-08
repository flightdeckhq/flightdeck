// Package writer provides direct pgx operations for upserting fleet state.
// No ORM -- all queries are parameterized SQL via pgx.
package writer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	staleThreshold = "2 minutes"
	// lostThreshold was 10 minutes; raised to 30 minutes in D105 to
	// cover typical interactive user think-time on the Claude Code
	// plugin without hiding legitimately-active sessions from the
	// fleet view. Revival on any event (D105) closes the correctness
	// gap; this threshold narrows the "appears lost" window.
	lostThreshold = "30 minutes"
)

// Writer performs all Postgres writes for the worker pipeline.
type Writer struct {
	pool *pgxpool.Pool
}

// New creates a Writer.
func New(pool *pgxpool.Pool) *Writer {
	return &Writer{pool: pool}
}

// AgentIdentity bundles the columns that identify an agent in the
// v0.4.0+ schema. agent_id is derived deterministically by the sensor
// and plugin from the other five fields (see D115); the derivation is
// verified at the ingestion boundary, so the worker trusts the tuple
// it receives here.
type AgentIdentity struct {
	AgentID    string
	AgentType  string
	ClientType string
	AgentName  string
	UserName   string
	Hostname   string
}

// UpsertAgent inserts the agents row when it does not exist and
// advances last_seen_at when it does. Does NOT increment
// total_sessions -- that rollup is tied to sessions.INSERT and lives
// in ReviveOrCreateSession so an agent that sees 20 events from one
// session does not bump its session counter 20 times. total_tokens
// is bumped separately via IncrementAgentTokens on post_call events.
func (w *Writer) UpsertAgent(ctx context.Context, id AgentIdentity) error {
	_, err := w.pool.Exec(ctx, `
		INSERT INTO agents (
			agent_id, agent_type, client_type, agent_name,
			user_name, hostname, first_seen_at, last_seen_at
		)
		VALUES (
			$1::uuid, $2, $3, $4, $5, $6, NOW(), NOW()
		)
		ON CONFLICT (agent_id) DO UPDATE
		SET last_seen_at = NOW()
	`, id.AgentID, id.AgentType, id.ClientType, id.AgentName,
		id.UserName, id.Hostname)
	if err != nil {
		return fmt.Errorf("upsert agent %s: %w", id.AgentID, err)
	}
	return nil
}

// IncrementAgentTokens bumps total_tokens by the event's
// tokens_total contribution. Called from post_call handling. delta
// may be zero (non-LLM events) or negative in edge cases; the column
// is BIGINT so arithmetic is safe.
func (w *Writer) IncrementAgentTokens(ctx context.Context, agentID string, delta int64) error {
	if delta == 0 {
		return nil
	}
	_, err := w.pool.Exec(ctx, `
		UPDATE agents
		SET total_tokens = total_tokens + $2,
		    last_seen_at = NOW()
		WHERE agent_id = $1::uuid
	`, agentID, delta)
	if err != nil {
		return fmt.Errorf("increment agent tokens %s: %w", agentID, err)
	}
	return nil
}

// UpsertSession inserts a new session or updates its state fields.
//
// The optional contextJSON argument carries the runtime context dict
// collected by the sensor at init() time (see sensor/core/context.py).
// Pass nil for events that don't carry context (only session_start
// does). When non-nil, it is stored in sessions.context (JSONB).
//
// ON CONFLICT enrichment semantics (D094 write-once + D106 sentinel
// upgrade):
//
//   - identity columns (host, framework, model) -- COALESCE, keep the
//     existing value when the incoming side is NULL.
//   - context, token_id, token_name -- COALESCE. Originally these were
//     write-once-on-insert with D094 explicitly forbidding overwrites.
//     D106 loosened this to COALESCE so that a lazily-created row
//     (ReviveOrCreateSession) with NULL context/token columns gets
//     enriched by a later session_start arrival. Real values remain
//     write-once: once sessions.context is non-null, COALESCE returns
//     the stored value and the incoming EXCLUDED is ignored.
//   - flavor, agent_type -- CASE upgrade from the sentinel "unknown".
//     "unknown" is the value D106 writes when a non-session_start
//     event lacks flavor/agent_type data. A legitimate session_start
//     never writes "unknown", so the CASE is a no-op for every row
//     that was created via an authoritative path. "Unknown is a
//     sentinel, not a value" -- upgrading it on enrichment is not
//     overwriting data.
func (w *Writer) UpsertSession(
	ctx context.Context,
	sessionID, flavor, agentType, host, framework, model, state string,
	agentID, clientType, agentName string,
	contextJSON []byte,
	tokenID, tokenName string,
	parentSessionID, agentRole string,
) (created bool, err error) {
	// session_start is the authoritative context source; an empty
	// context dict from the sensor ("I tried, there was nothing to
	// collect") still writes `{}` so the row looks populated. Only
	// ReviveOrCreateSession writes NULL context -- the sentinel
	// "nobody has tried yet, please enrich me" state that the
	// COALESCE branch below converts back into real data on the
	// session_start arrival. See D106 for the {} vs NULL split.
	if contextJSON == nil {
		contextJSON = []byte("{}")
	}
	// INSERT ... RETURNING (xmax = 0) distinguishes a fresh insert
	// from an ON CONFLICT update, so the caller can bump the agents
	// total_sessions rollup exactly once per new session row without
	// tracking it in a second query.
	var wasInsert bool
	err = w.pool.QueryRow(ctx, `
		INSERT INTO sessions (
			session_id, flavor, agent_type, host, framework, model, state,
			started_at, last_seen_at, context, token_id, token_name,
			agent_id, client_type, agent_name,
			parent_session_id, agent_role
		)
		VALUES (
			$1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7,
			NOW(), NOW(), $8,
			NULLIF($9, '')::uuid, NULLIF($10, ''),
			$11::uuid, $12, $13,
			NULLIF($14, '')::uuid, NULLIF($15, '')
		)
		ON CONFLICT (session_id) DO UPDATE
		SET state = EXCLUDED.state,
		    last_seen_at = NOW(),
		    host = COALESCE(EXCLUDED.host, sessions.host),
		    framework = COALESCE(EXCLUDED.framework, sessions.framework),
		    model = COALESCE(EXCLUDED.model, sessions.model),
		    -- D106: COALESCE the write-once columns so a lazily-created
		    -- row with NULL context / token columns picks up the real
		    -- values when session_start later arrives. Real values are
		    -- preserved (COALESCE returns the stored side first).
		    context = COALESCE(sessions.context, EXCLUDED.context),
		    token_id = COALESCE(sessions.token_id, EXCLUDED.token_id),
		    token_name = COALESCE(sessions.token_name, EXCLUDED.token_name),
		    -- D106 sentinel upgrade: "unknown" on flavor / agent_type
		    -- means "we lazy-created without authoritative data".
		    -- Replace it when a real session_start brings the truth.
		    flavor = CASE WHEN sessions.flavor = 'unknown'
		                  THEN EXCLUDED.flavor
		                  ELSE sessions.flavor END,
		    agent_type = CASE WHEN sessions.agent_type = 'unknown'
		                      THEN EXCLUDED.agent_type
		                      ELSE sessions.agent_type END,
		    -- D115: identity is write-once once non-null. A lazy-create
		    -- writes NULL for agent_id / client_type / agent_name; the
		    -- first authoritative session_start fills them in. Real
		    -- values (non-null) are preserved by COALESCE.
		    agent_id = COALESCE(sessions.agent_id, EXCLUDED.agent_id),
		    client_type = COALESCE(sessions.client_type, EXCLUDED.client_type),
		    agent_name = COALESCE(sessions.agent_name, EXCLUDED.agent_name),
		    -- D126: sub-agent columns. Write-once on insert; preserved
		    -- on conflict so a child's session_start can't accidentally
		    -- rewrite the parent row's null parent_session_id /
		    -- agent_role. The lazy-create-parent-stub branch
		    -- (UpsertParentStub) writes NULL for both, and a later real
		    -- parent session_start preserves NULL via COALESCE because
		    -- the parent itself isn't a sub-agent.
		    parent_session_id = COALESCE(
		        sessions.parent_session_id, EXCLUDED.parent_session_id),
		    agent_role = COALESCE(sessions.agent_role, EXCLUDED.agent_role)
		RETURNING (xmax = 0)
	`, sessionID, flavor, agentType, host, framework, model, state,
		contextJSON, tokenID, tokenName,
		agentID, clientType, agentName,
		parentSessionID, agentRole,
	).Scan(&wasInsert)
	if err != nil {
		return false, fmt.Errorf("upsert session %s: %w", sessionID, err)
	}
	return wasInsert, nil
}

// UpgradeSessionContext fills in the sessions.context column on a row
// whose context is either NULL (D106 lazy-create) or the empty JSON
// object ``{}``. Once the column holds real data, the COALESCE branch
// short-circuits to the stored value and the incoming payload is
// ignored -- write-once semantics for real context are preserved across
// every event type.
//
// Motivation: a Claude Code plugin session whose session_start POST
// fails (stack was down at claude start, transient DNS outage, ...)
// leaves the per-session dedup marker on disk, so session_start is
// never retried. Every subsequent event then flows through
// handleSessionGuard's D106 lazy-create which writes flavor="unknown"
// and context=NULL. Without this helper the RUNTIME panel stays empty
// forever. Attaching context to every event and running this upgrade
// lets the first event that actually reaches the server populate the
// column.
//
// NULLIF(context, '{}'::jsonb) makes the upgrade compatible with the
// two "no real context yet" sentinels in play: NULL (ReviveOrCreateSession
// writes explicit NULL; DEFAULT '{}'::jsonb on inserts that omit the
// column) and '{}'::jsonb (UpsertSession writes '{}' when the sensor
// ran collectContext and got nothing back). The helper treats both
// sentinels as "enrich me".
//
// Called from handleSessionGuard after the guard resolves the row to
// any non-closed state (active, idle, stale->active, lost->active,
// or lazy-created). Closed rows are skipped one level up -- a user
// explicitly ended the session and we do not rewrite their context
// retroactively.
func (w *Writer) UpgradeSessionContext(ctx context.Context, sessionID string, contextJSON []byte) error {
	if len(contextJSON) == 0 {
		return nil
	}
	_, err := w.pool.Exec(ctx, `
		UPDATE sessions
		SET context = COALESCE(NULLIF(context, '{}'::jsonb), $2::jsonb)
		WHERE session_id = $1::uuid
	`, sessionID, contextJSON)
	if err != nil {
		return fmt.Errorf("upgrade session context %s: %w", sessionID, err)
	}
	return nil
}

// AppendMCPServerToContext UPSERTs a single MCP server fingerprint
// dict into ``sessions.context.mcp_servers`` (D140 step 6.6 A2).
// Idempotent dedup by (name, server_url) tuple — re-emitted
// ``mcp_server_attached`` events from a framework reconnecting to
// the same server become no-ops at the row level. Drives live
// dashboard SessionDrawer panel population: the worker fires this
// on every ``mcp_server_attached`` event, the dashboard re-fetches
// via WebSocket, the panel renders the new server within ~2-3 s.
//
// The dedup key intentionally uses the (name, server_url) tuple
// rather than the wire fingerprint hex so the stored dict shape
// stays exactly as ``sessions.context.mcp_servers`` was on
// session_start (no schema bump). Per D127 the (canonical_url,
// name) pair uniquely determines the fingerprint hex, so tuple
// dedup is information-equivalent to fingerprint dedup.
//
// The serverDict argument is a pre-marshaled JSON object whose
// keys match the existing context dict shape: ``{name, transport,
// protocol_version, version, capabilities, instructions,
// server_url}``. The processor maps the wire-event payload's
// ``server_name``/``server_url_canonical`` to ``name``/
// ``server_url`` before calling.
//
// SQL strategy: read the array, JSON-test for an existing entry
// matching (name, server_url), append only when no match. Single
// statement via jsonb operators so the dedup + append happens
// atomically without a SELECT-then-UPDATE race window.
//
// Returns nil on success, error on DB failure or JSON
// marshalling. The caller (event processor) logs and continues —
// a failed UPSERT must not block other events processing.
func (w *Writer) AppendMCPServerToContext(
	ctx context.Context,
	sessionID string,
	serverName string,
	serverURL string,
	serverDict []byte,
) error {
	if len(serverDict) == 0 {
		return errors.New("AppendMCPServerToContext: serverDict is empty")
	}
	_, err := w.pool.Exec(ctx, `
		UPDATE sessions
		SET context = jsonb_set(
			COALESCE(context, '{}'::jsonb),
			'{mcp_servers}',
			COALESCE(context->'mcp_servers', '[]'::jsonb) || $2::jsonb
		)
		WHERE session_id = $1::uuid
		  AND NOT EXISTS (
			SELECT 1
			  FROM jsonb_array_elements(
				COALESCE(context->'mcp_servers', '[]'::jsonb)
			  ) AS s
			 WHERE s->>'name' = $3
			   AND COALESCE(s->>'server_url', '') = COALESCE($4, '')
		  )
	`, sessionID, serverDict, serverName, serverURL)
	if err != nil {
		return fmt.Errorf(
			"append mcp server to context %s: %w", sessionID, err,
		)
	}
	return nil
}

// InsertEvent inserts a new event record (metadata only) and returns the generated event ID.
//
// The optional payload argument is a JSON-encoded blob written into the
// events.payload JSONB column. It carries per-event-type metadata that
// does not fit the canonical schema columns -- in particular the
// directive_name / directive_action / directive_status / result fields
// emitted by the sensor for directive_result events. Pass nil for
// events that have no extra metadata; the payload column stays NULL.
func (w *Writer) InsertEvent(
	ctx context.Context,
	sensorEventID string,
	sessionID, flavor, eventType, model string,
	tokensInput, tokensOutput, tokensTotal *int,
	tokensCacheRead, tokensCacheCreation *int64,
	latencyMs *int,
	toolName *string,
	hasContent bool,
	occurredAt time.Time,
	payload []byte,
) (string, error) {
	// Cache columns are NOT NULL DEFAULT 0; coalesce nil pointers to 0 rather
	// than relying on a NULL insert, which the column definition rejects.
	cacheRead := int64(0)
	if tokensCacheRead != nil {
		cacheRead = *tokensCacheRead
	}
	cacheCreation := int64(0)
	if tokensCacheCreation != nil {
		cacheCreation = *tokensCacheCreation
	}
	// Phase 7 Step 2 (D149): sensor mints the event UUID and ships
	// it in payload.id (string form). NULLIF + COALESCE: empty
	// string → NULL → DB-side gen_random_uuid() default kicks in
	// (legacy callers without sensor-supplied id keep working). ON
	// CONFLICT (id, occurred_at) DO NOTHING gives idempotent retry
	// semantics — a sensor flush retried after a transient
	// ingestion failure lands cleanly even if the first attempt's
	// commit raced.
	var eventID string
	err := w.pool.QueryRow(ctx, `
		INSERT INTO events (id, session_id, flavor, event_type, model, tokens_input, tokens_output, tokens_total, tokens_cache_read, tokens_cache_creation, latency_ms, tool_name, has_content, occurred_at, payload)
		VALUES (COALESCE(NULLIF($1, '')::uuid, gen_random_uuid()), $2::uuid, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		ON CONFLICT (id, occurred_at) DO NOTHING
		RETURNING id::text
	`, sensorEventID, sessionID, flavor, eventType, model, tokensInput, tokensOutput, tokensTotal, cacheRead, cacheCreation, latencyMs, toolName, hasContent, occurredAt, payload).Scan(&eventID)
	if err != nil {
		// pgx returns ErrNoRows when ON CONFLICT DO NOTHING suppresses
		// the insert (no row to RETURN). Surface the sensor-supplied
		// id back to the caller so downstream NOTIFY + content writes
		// reference the canonical row that already exists.
		if errors.Is(err, pgx.ErrNoRows) && sensorEventID != "" {
			return sensorEventID, nil
		}
		return "", fmt.Errorf("insert event: %w", err)
	}
	return eventID, nil
}

// InsertEventContent inserts prompt capture content into event_content.
// Called only when event.HasContent is true.
//
// Phase 4 polish: ``Input`` carries the embedding request's ``input``
// parameter (string or list of strings) for ``event_type=embeddings``
// events. Chat events leave Input null and populate Messages instead.
// The dashboard branches on event_type to render the appropriate
// viewer (PromptViewer for chat, EmbeddingsContentViewer for
// embeddings). See migration 000016_event_content_input.up.sql.
func (w *Writer) InsertEventContent(ctx context.Context, eventID, sessionID string, content json.RawMessage) error {
	// Parse the content JSON to extract fields
	var c struct {
		Provider     string          `json:"provider"`
		Model        string          `json:"model"`
		SystemPrompt *string         `json:"system"`
		Messages     json.RawMessage `json:"messages"`
		Tools        json.RawMessage `json:"tools"`
		Response     json.RawMessage `json:"response"`
		Input        json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(content, &c); err != nil {
		return fmt.Errorf("parse event content: %w", err)
	}
	// Default Messages to "[]"::jsonb when absent so the column's
	// (post-000016) NULL allowance never produces a literal SQL NULL
	// for chat rows that omit messages -- only embedding rows
	// legitimately leave it empty.
	if len(c.Messages) == 0 {
		c.Messages = json.RawMessage("[]")
	}
	_, err := w.pool.Exec(ctx, `
		INSERT INTO event_content (event_id, session_id, provider, model, system_prompt, messages, tools, response, input)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (event_id) DO NOTHING
	`, eventID, sessionID, c.Provider, c.Model, c.SystemPrompt, c.Messages, c.Tools, c.Response, c.Input)
	if err != nil {
		return fmt.Errorf("insert event content: %w", err)
	}
	return nil
}

// UpdateSessionModel updates the session's model field. Idempotent and
// backward-compatible: when *model* is empty, the existing value is
// preserved (NULLIF maps "" to NULL, and COALESCE keeps the prior value).
// Sessions with no post_call event keep model = NULL.
func (w *Writer) UpdateSessionModel(ctx context.Context, sessionID, model string) error {
	if model == "" {
		return nil
	}
	_, err := w.pool.Exec(ctx, `
		UPDATE sessions
		SET model = COALESCE(NULLIF($2, ''), model)
		WHERE session_id = $1::uuid
	`, sessionID, model)
	if err != nil {
		return fmt.Errorf("update model for %s: %w", sessionID, err)
	}
	return nil
}

// UpdateTokensUsed atomically increments tokens_used on a session.
func (w *Writer) UpdateTokensUsed(ctx context.Context, sessionID string, delta int) error {
	_, err := w.pool.Exec(ctx, `
		UPDATE sessions
		SET tokens_used = tokens_used + $1,
		    last_seen_at = NOW()
		WHERE session_id = $2::uuid
	`, delta, sessionID)
	if err != nil {
		return fmt.Errorf("update tokens_used for %s: %w", sessionID, err)
	}
	return nil
}

// UpdateLastSeen touches last_seen_at on a session (heartbeat path).
func (w *Writer) UpdateLastSeen(ctx context.Context, sessionID string) error {
	_, err := w.pool.Exec(ctx, `
		UPDATE sessions SET last_seen_at = NOW() WHERE session_id = $1::uuid
	`, sessionID)
	if err != nil {
		return fmt.Errorf("update last_seen for %s: %w", sessionID, err)
	}
	return nil
}

// ReviveIfRevivable flips a stale or lost session back to active and
// advances last_seen_at. D105 generalises D094's session_start
// attach-on-terminal semantics to every event type: every
// non-session_start handler runs this before its normal side effects,
// so sessions that go stale/lost during interactive idle windows
// resume on the next event instead of freezing forever.
//
// Four places know how to revive or create a session. They mirror
// each other rather than share a helper; any change to the revival
// contract (columns touched, state predicate) must be applied to
// all four:
//
//  1. Ingestion: ``session.Store.Attach`` (D094) runs synchronously on
//     ``session_start`` so the HTTP response can report ``attached=true``.
//     Scope: closed, lost -> active; records a session_attachments row.
//  2. Worker, ``UpsertSession`` ON CONFLICT branch (D094 worker side,
//     extended by D106). Scope: any prior state -> whatever the
//     session_start event asks for (always ``active``), with identity-
//     column refresh and D106 enrichment of the ``unknown`` sentinel
//     and NULL context/token columns that a lazy-create left behind.
//  3. Worker, ``ReviveIfRevivable`` (this function, D105). Scope:
//     stale, lost -> active. No identity refresh, no attachment row.
//  4. Worker, ``ReviveOrCreateSession`` (D106). Scope: delegates to
//     ReviveIfRevivable when the row exists, INSERTs a new row with
//     best-effort identity + ``unknown`` sentinels when it does not.
//     Called by every non-session_start handler so an event for an
//     unknown session_id lazily manifests the row instead of
//     FK-violating at InsertEvent.
//
// Scope of this helper:
//   - state IN ('stale', 'lost') -> UPDATE, returns (true, nil).
//   - state IN ('active', 'idle', 'closed') -> no-op, returns (false, nil).
//     closed stays terminal (user explicitly ended the session) and is
//     enforced at the handler layer, not here.
//   - session row does not exist -> no-op, returns (false, nil).
func (w *Writer) ReviveIfRevivable(ctx context.Context, sessionID string) (bool, error) {
	tag, err := w.pool.Exec(ctx, `
		UPDATE sessions
		SET state = 'active',
		    last_seen_at = NOW()
		WHERE session_id = $1::uuid
		  AND state IN ('stale', 'lost')
	`, sessionID)
	if err != nil {
		return false, fmt.Errorf("revive session %s: %w", sessionID, err)
	}
	return tag.RowsAffected() > 0, nil
}

// ReviveOrCreateSession is the D106 lazy-create path. Called by every
// non-session_start handler before its normal side effects.
//
// Semantics:
//
//   - Row exists in any state -> delegates to ReviveIfRevivable so a
//     stale/lost row flips back to active. Returns (created=false, nil).
//     The caller's subsequent UPDATE (token counting, last_seen) runs
//     against the existing row.
//   - Row does not exist -> upserts the agents row (needed for the
//     sessions.flavor FK), then INSERTs a new sessions row with
//     state='active', started_at=last_seen_at=occurredAt, and
//     best-effort identity fields. Where the event does not carry
//     flavor or agent_type, the "unknown" sentinel is written so
//     UpsertSession's ON CONFLICT branch can upgrade it when the
//     authoritative session_start eventually arrives. context and
//     token columns are NULL (sentinel for "enrich me"). Returns
//     (created=true, nil).
//
// Fail-open posture: on any Postgres error during the existence
// check, falls through to the INSERT (ON CONFLICT DO NOTHING) so a
// transient read failure does not block creation. The caller's
// InsertEvent still protects against a row-missing-after-failure
// case via the FK.
//
// Why this helper is separate from UpsertSession: UpsertSession is
// tied to session_start and refreshes identity columns from the
// session_start payload. ReviveOrCreateSession runs on any event
// type, does not overwrite identity, and specifically writes the
// "unknown" sentinel that UpsertSession's CASE guard later upgrades.
// Consolidating would need a four-axis config surface -- see the
// cross-reference comment on ReviveIfRevivable for the full list.
func (w *Writer) ReviveOrCreateSession(
	ctx context.Context,
	sessionID, flavor, agentType, host, framework, model string,
	identity AgentIdentity,
	occurredAt time.Time,
) (created bool, err error) {
	var state string
	sErr := w.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid",
		sessionID,
	).Scan(&state)
	if sErr == nil {
		// Row exists. Delegate to the D105 revive path -- it's a
		// no-op for active/idle/closed and flips stale/lost.
		if _, rerr := w.ReviveIfRevivable(ctx, sessionID); rerr != nil {
			return false, fmt.Errorf("revive-or-create %s: %w", sessionID, rerr)
		}
		return false, nil
	}
	// Any error (ErrNoRows or otherwise) falls through to INSERT.
	// ON CONFLICT DO NOTHING covers the race where a parallel event
	// created the row between our SELECT and our INSERT.

	// Default sentinels for missing flavor/agent_type so UpsertSession's
	// CASE branch can later upgrade the row when the authoritative
	// session_start arrives. Identity fields (agent_id, client_type,
	// agent_name) are trusted from the ingestion-validated payload.
	if flavor == "" {
		flavor = "unknown"
	}
	if agentType == "" {
		agentType = "unknown"
	}

	// D115: upsert the agents row first so the sessions FK lands
	// cleanly. Even a lazy-create path knows the authoritative agent
	// identity because the ingestion handler validated it on the
	// way in.
	if aErr := w.UpsertAgent(ctx, identity); aErr != nil {
		return false, fmt.Errorf("revive-or-create %s: upsert agent: %w", sessionID, aErr)
	}

	// context is written as explicit NULL (overriding the column's
	// DEFAULT '{}'::jsonb) so UpsertSession's COALESCE branch on the
	// next session_start can distinguish "nobody has populated this
	// yet" from "sensor ran collectContext and got an empty dict".
	// token_id / token_name are omitted from the column list; both
	// are nullable without a DEFAULT, so omission gives us NULL.
	// started_at and last_seen_at pin to the event's occurred_at so
	// the lazy row backdates to when the activity actually began,
	// not when the server got around to recording it.
	tag, iErr := w.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, flavor, agent_type, host, framework, model, state,
			started_at, last_seen_at, context,
			agent_id, client_type, agent_name
		)
		VALUES (
			$1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
			'active', $7, $7, NULL,
			$8::uuid, $9, $10
		)
		ON CONFLICT (session_id) DO NOTHING
	`, sessionID, flavor, agentType, host, framework, model, occurredAt,
		identity.AgentID, identity.ClientType, identity.AgentName)
	if iErr != nil {
		return false, fmt.Errorf("revive-or-create %s: insert: %w", sessionID, iErr)
	}
	if tag.RowsAffected() > 0 {
		// Fresh session row landed. Bump the agents rollup exactly
		// once per new session, matching the UpsertSession path.
		if bErr := w.BumpAgentSessionCount(ctx, identity.AgentID); bErr != nil {
			// Rollup failure is non-fatal: the session row exists and
			// the agent row exists, so dashboards still render; a
			// missed increment at worst shows one fewer session in the
			// total_sessions column until reconciliation runs.
			// Log-only rather than unwind the insert.
			_ = bErr
		}
		return true, nil
	}
	return false, nil
}

// SessionExists reports whether a session row with the given session_id
// is present in the sessions table. Used by HandleSessionStart's
// parent-stub branch (D126 § 3) to decide whether the parent of an
// incoming sub-agent session_start is already in the DB or needs a
// stub INSERT before the child's UpsertSession runs.
//
// Returns (false, nil) when the row is absent — the canonical "not
// found" signal used by the parent-stub guard. Database errors other
// than no-rows propagate so callers can treat them as transient.
func (w *Writer) SessionExists(ctx context.Context, sessionID string) (bool, error) {
	var n int
	err := w.pool.QueryRow(ctx, `
		SELECT 1 FROM sessions WHERE session_id = $1::uuid
	`, sessionID).Scan(&n)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("session exists %s: %w", sessionID, err)
	}
	return true, nil
}

// UpsertParentStub is the D126 § 3 forward-reference soft-link
// extension to D106's lazy-create primitive. Triggered when a
// sub-agent ``session_start`` arrives with a ``parent_session_id``
// that doesn't yet exist in ``sessions`` — without a row at the
// parent end, the child's INSERT fails the new
// ``parent_session_id`` FK at schema-enforcement time. The stub
// row carries the same ``"unknown"`` sentinels as
// ``ReviveOrCreateSession`` plus a placeholder ``started_at``
// matching the child's so the timeline ordering is sensible while
// the real parent's authoritative data hasn't arrived yet.
//
// When the real parent's ``session_start`` arrives later,
// ``UpsertSession`` runs through its existing
// write-once-but-upgrade-from-``"unknown"`` ON CONFLICT branch and
// fills in the stub's flavor / agent_type / agent_id /
// client_type / agent_name from the EXCLUDED row. Identity fields
// in the stub are NULL on insert; COALESCE in UpsertSession's
// conflict branch upgrades them once. Same primitive as D106's
// create-on-unknown, different trigger (FK-satisfaction vs
// unknown-session-id event); kept as a separate helper so
// callers don't need to express the parent-stub-specific shape
// (started_at = child.started_at, no agents row required because
// the real parent will UpsertAgent on its own arrival) through
// the four-axis revive/create config surface that's the reason
// the trio is uncoalesced. ``ON CONFLICT DO NOTHING`` covers the
// race where two children of the same yet-unseen parent arrive
// concurrently and both try to create the stub.
//
// Returns (true, nil) when the stub was actually created (FK is
// now satisfied for the child INSERT to follow); (false, nil) if
// the row already exists by the time the INSERT fires (the race
// covered by ON CONFLICT DO NOTHING). Database errors propagate.
func (w *Writer) UpsertParentStub(
	ctx context.Context,
	parentSessionID string,
	childStartedAt time.Time,
) (created bool, err error) {
	tag, iErr := w.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, flavor, agent_type, state,
			started_at, last_seen_at, context
		)
		VALUES (
			$1::uuid, 'unknown', 'unknown', 'active',
			$2, $2, NULL
		)
		ON CONFLICT (session_id) DO NOTHING
	`, parentSessionID, childStartedAt)
	if iErr != nil {
		return false, fmt.Errorf("upsert parent stub %s: %w", parentSessionID, iErr)
	}
	return tag.RowsAffected() > 0, nil
}

// BumpAgentSessionCount increments agents.total_sessions by 1. Called
// only when UpsertSession / ReviveOrCreateSession observed a fresh
// INSERT into sessions, so the counter stays accurate under repeated
// events for the same session_id.
func (w *Writer) BumpAgentSessionCount(ctx context.Context, agentID string) error {
	_, err := w.pool.Exec(ctx, `
		UPDATE agents
		SET total_sessions = total_sessions + 1,
		    last_seen_at = NOW()
		WHERE agent_id = $1::uuid
	`, agentID)
	if err != nil {
		return fmt.Errorf("bump agent session count %s: %w", agentID, err)
	}
	return nil
}

// CloseSession sets state=closed and ended_at on a session.
func (w *Writer) CloseSession(ctx context.Context, sessionID string) error {
	_, err := w.pool.Exec(ctx, `
		UPDATE sessions
		SET state = 'closed', ended_at = NOW(), last_seen_at = NOW()
		WHERE session_id = $1::uuid
	`, sessionID)
	if err != nil {
		return fmt.Errorf("close session %s: %w", sessionID, err)
	}
	return nil
}

// ReconcileStaleSessions sets stale after 2 min silence, lost after 10 min.
func (w *Writer) ReconcileStaleSessions(ctx context.Context) error {
	// Mark stale: active sessions with no signal for > 2 minutes
	_, err := w.pool.Exec(ctx, `
		UPDATE sessions
		SET state = 'stale'
		WHERE state IN ('active', 'idle')
		  AND last_seen_at < NOW() - INTERVAL '` + staleThreshold + `'
	`)
	if err != nil {
		return fmt.Errorf("mark stale: %w", err)
	}

	// Mark lost: stale sessions with no close for > 10 minutes
	_, err = w.pool.Exec(ctx, `
		UPDATE sessions
		SET state = 'lost'
		WHERE state = 'stale'
		  AND last_seen_at < NOW() - INTERVAL '` + lostThreshold + `'
	`)
	if err != nil {
		return fmt.Errorf("mark lost: %w", err)
	}

	return nil
}
