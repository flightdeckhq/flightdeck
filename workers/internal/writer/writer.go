// Package writer writes the fleet state the worker derives from events:
// agents, sessions, events and their captured content. It runs on the
// storage boundary, so one code path serves SQLite and Postgres: the
// statements in the common subset of both dialects are shared, with
// the dialect's current-time expression filled in once, and the ones
// that differ (JSON operators, row locks, data-modifying CTEs, Postgres'
// xmax) have a query set per backend in queries_postgres.go and
// queries_sqlite.go. No ORM -- all queries are parameterized SQL.
//
// Every id the writer stores is canonical lower-case UUID text: the
// SQLite schema's CHECK accepts nothing else, and Postgres stores the
// same bytes, so a lookup by id behaves the same on both.
//
// On SQLite the database has one writer connection. Inside a
// transaction every statement runs on the transaction, and a read that
// needs no transaction runs on the read pool (db.Reader()); a statement
// issued on the writer while the same goroutine holds a transaction
// would wait for that connection forever.
package writer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
)

const (
	staleThreshold = 2 * time.Minute
	// lostThreshold was 10 minutes; raised to 30 minutes to cover
	// typical interactive user think-time on the Claude Code plugin
	// without hiding legitimately-active sessions from the fleet view.
	// Revival on any event closes the correctness gap; this threshold
	// narrows the "appears lost" window.
	lostThreshold = 30 * time.Minute
)

// Writer performs all database writes for the worker pipeline.
type Writer struct {
	db  *storage.DB
	bus storage.Bus
	q   queries
}

// New creates a Writer on db that announces committed changes on bus.
func New(db *storage.DB, bus storage.Bus) *Writer {
	return &Writer{db: db, bus: bus, q: newQueries(db)}
}

// eventIDPattern is a canonical UUID: only such an id can name a stored
// event (the column is a uuid), so EventExists answers false for any
// other string instead of failing the lookup.
var eventIDPattern = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
)

// EventExists reports whether an event with this client-supplied id is
// already stored. A client that mints its own event id sends the same id
// for every copy of one event (the sensor when it retries a POST, the
// Claude Code plugin for every re-send of one model call), so a second
// copy is a duplicate.
func (w *Writer) EventExists(ctx context.Context, id string) (bool, error) {
	if !eventIDPattern.MatchString(id) {
		return false, nil
	}
	var exists bool
	err := w.db.Reader().QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM events WHERE id = $1)`, canonicalUUID(id),
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check event exists: %w", err)
	}
	return exists, nil
}

// LatestCallBillingMode returns the billing mode of the session's most
// recent post_call, preferring one of model, or "" when the session has
// no post_call with a billing mode. A failed stream's llm_error carries
// none of its own and is billed as the session's calls are.
func (w *Writer) LatestCallBillingMode(ctx context.Context, sessionID, model string) (string, error) {
	var mode string
	err := w.db.Reader().QueryRowContext(ctx, `
		SELECT billing_mode FROM events
		WHERE session_id = $1
		  AND event_type = 'post_call'
		  AND billing_mode IS NOT NULL
		ORDER BY (model = $2) DESC NULLS LAST, occurred_at DESC
		LIMIT 1
	`, canonicalUUID(sessionID), model).Scan(&mode)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("latest call billing mode for %s: %w", sessionID, err)
	}
	return mode, nil
}

// querier is what the event and event-content inserts run on: the
// database for a standalone write, or a transaction when an event and
// its content must land together. *sql.DB and *sql.Tx both satisfy it.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// ErrEventContent marks an event's captured content as impossible to
// store: it does not parse, or the database rejects the row as invalid
// data (storage.IsDataError). InsertEventWithContent returns it with
// nothing written, so the caller can store the event without its
// content instead of retrying a write that will fail the same way every
// time.
var ErrEventContent = errors.New("event content")

// AgentIdentity bundles the columns that identify an agent in the
// v0.4.0+ schema. agent_id is derived deterministically by the sensor
// and plugin from the other five fields; the derivation is
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
// total_sessions -- that rollup is tied to a session row becoming
// attributed to the agent (see BumpAgentSessionCount), so an agent that
// sees 20 events from one session does not bump its session counter 20
// times. total_tokens is bumped separately via IncrementAgentTokens on
// post_call events.
func (w *Writer) UpsertAgent(ctx context.Context, id AgentIdentity) error {
	_, err := w.db.ExecContext(ctx, w.q.upsertAgent,
		canonicalUUID(id.AgentID), id.AgentType, id.ClientType, id.AgentName,
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
	_, err := w.db.ExecContext(ctx, w.q.incrementAgentTokens, canonicalUUID(agentID), delta)
	if err != nil {
		return fmt.Errorf("increment agent tokens %s: %w", agentID, err)
	}
	return nil
}

// UpsertSession inserts a new session or updates its state fields, and
// reports whether this call attributed the row to agentID: it inserted
// the row, or it filled the NULL agent_id of a row no agent owned yet (a
// parent stub that a sub-agent's session_start wrote first). The caller
// adds one to that agent's total_sessions when attributed is true, so
// each session counts toward its agent exactly once, whichever of the
// parent's and the child's session_start the worker processes first. A
// redelivered or concurrent session_start for a row an agent already
// owns reports false.
//
// The call runs as two statements that share the INSERT and SET of the
// backend's upsert and differ only in the ON CONFLICT DO UPDATE's WHERE
// clause:
//
//   - the claim inserts the row, or updates an existing row whose
//     agent_id is NULL. A returned row means this call attributed the
//     session.
//   - the refresh runs when the claim returned nothing (the row exists
//     and an agent owns it) and updates that row.
//
// On Postgres the two run as separate statements: Postgres evaluates
// the WHERE clause on the conflicting row after locking its latest
// version, including a row inserted after the statement's snapshot was
// taken, so the ownership check and the write are atomic: of two
// session_starts (or this start and a parent stub, or the guard's
// AttributeSession) racing on one row, exactly one attributes it. A
// snapshot read of the prior row would not do: a stub committed after
// the statement's snapshot is invisible to it, yet the ON CONFLICT path
// still updates that stub, so the fill would go uncounted. The refresh
// inserts only when the row was deleted after the claim saw it, and
// reports that insert through xmax so this call attributes the new row.
// On SQLite the two run in one transaction on the single writer
// connection, which holds the write lock from BEGIN, so nothing can
// change the row between them and the refresh never inserts.
//
// The optional contextJSON argument carries the runtime context dict
// collected by the sensor at init() time (see sensor/core/context.py).
// Pass nil for events that don't carry context (only session_start
// does). When non-nil, it is stored in sessions.context (JSON).
//
// ON CONFLICT enrichment semantics: identity and context columns are
// write-once, the lazy-create sentinels are upgradable, and the state
// follows the publication order of the session's events.
//
//   - identity columns (host, framework, model) -- COALESCE, keep the
//     existing value when the incoming side is NULL.
//   - context, token_id, token_name -- COALESCE, so a lazily-created
//     row (ReviveOrCreateSession) with NULL context/token columns gets
//     enriched by a later session_start arrival. Real values remain
//     write-once: once sessions.context is non-null, COALESCE returns
//     the stored value and the incoming EXCLUDED is ignored. When it
//     fills a sensor row whose framework a call already set, it adds
//     that label to context.frameworks if no entry has it.
//   - state -- EXCLUDED.state (active), which also revives a closed row
//     for a re-attachment (clearing ended_at and closed_seq), unless the
//     session_end that closed the row was published after this
//     session_start: the worker pool handles a session's events
//     concurrently, so an end can be processed before its own start,
//     and the row then stays closed. Re-attachment is normally settled
//     by the ingestion API before the event is published; the sequence
//     comparison covers the start that arrives while the previous
//     run's end is still queued. A closed row without closed_seq (the
//     reconciler's close, or an earlier release) is always revived.
//   - start_seq -- the greater of the stored value and this event's
//     stream sequence, so the row records the start of its latest run.
//   - started_at -- the database's clock when this start inserts the
//     row. An assembled OpenTelemetry session (this start's context
//     carries otel_trace_id) is published after the run it describes,
//     so it takes startedAt, capped at the clock, both on insert and on
//     a row its session has never started: a parent stub or a lazily
//     created row, whose started_at is a placeholder and whose capture
//     posture is still NULL (every session_start writes one). A row its
//     session already started (a re-attachment) keeps its started_at,
//     and so does every row a start without otel_trace_id reaches.
//   - flavor, agent_type -- CASE upgrade from the sentinel "unknown".
//     "unknown" is the value the lazy-create path writes when a
//     non-session_start event lacks flavor/agent_type data. A
//     legitimate session_start never writes "unknown", so the CASE is
//     a no-op for every row that was created via an authoritative
//     path. "Unknown is a sentinel, not a value" -- upgrading it on
//     enrichment is not overwriting data.
func (w *Writer) UpsertSession(
	ctx context.Context,
	sessionID, flavor, agentType, host, framework, model, state string,
	agentID, clientType, agentName string,
	contextJSON []byte,
	tokenID, tokenName string,
	parentSessionID, agentRole string,
	capturePrompts bool,
	startSeq uint64,
	startedAt time.Time,
) (attributed bool, err error) {
	// session_start is the authoritative context source; an empty
	// context dict from the sensor ("I tried, there was nothing to
	// collect") still writes `{}` so the row looks populated. Only
	// ReviveOrCreateSession writes NULL context -- the sentinel
	// "nobody has tried yet, please enrich me" state that the
	// COALESCE branch converts back into real data on the
	// session_start arrival.
	if contextJSON == nil {
		contextJSON = []byte("{}")
	}
	sessionID = canonicalUUID(sessionID)
	args := []any{
		sessionID, flavor, agentType, host, framework, model, state,
		string(contextJSON), canonicalUUID(tokenID), tokenName,
		canonicalUUID(agentID), clientType, agentName,
		canonicalUUID(parentSessionID), agentRole, capturePrompts,
		seqParam(startSeq), timeParam(startedAt),
	}
	if w.db.Backend == storage.SQLite {
		return w.upsertSessionSQLite(ctx, sessionID, args)
	}
	for range upsertSessionRounds {
		var claimed bool
		err = w.db.QueryRowContext(ctx, w.q.upsertSessionClaim, args...).Scan(&claimed)
		if err == nil {
			return true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return false, fmt.Errorf("upsert session %s: %w", sessionID, err)
		}
		// An agent owns the row, so this start refreshes it. The refresh
		// inserts only when the row was deleted after the claim saw it,
		// and that new row is this call's to attribute.
		var inserted bool
		err = w.db.QueryRowContext(ctx, w.q.upsertSessionRefresh, args...).Scan(&inserted)
		if err == nil {
			return inserted, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return false, fmt.Errorf("upsert session %s: %w", sessionID, err)
		}
		// The row has no agent again: it was deleted after the claim saw
		// it and a parent stub took its place. Claim it.
	}
	return false, fmt.Errorf("upsert session %s: the row changed owner between the claim and the refresh %d times",
		sessionID, upsertSessionRounds)
}

// upsertSessionRounds bounds how often UpsertSession repeats its claim
// and refresh on Postgres when the row changes owner between the two
// statements. Each repeat needs the row deleted and a parent stub
// inserted in its place within one round trip, so even a second round is
// a near impossibility; the third is a margin before the call returns an
// error and the consumer redelivers the event.
const upsertSessionRounds = 3

// upsertSessionSQLite runs the claim and the refresh in one transaction
// on the single writer connection. The transaction begins IMMEDIATE and
// so holds the write lock from its first statement: no other writer can
// insert, delete or attribute the row between the claim and the
// refresh, so the refresh always finds the owned row the claim saw and
// never inserts.
func (w *Writer) upsertSessionSQLite(ctx context.Context, sessionID string, args []any) (attributed bool, err error) {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("upsert session %s: begin: %w", sessionID, err)
	}
	// A no-op once Commit has succeeded.
	defer func() { _ = tx.Rollback() }()
	var claimed bool
	err = tx.QueryRowContext(ctx, w.q.upsertSessionClaim, args...).Scan(&claimed)
	switch {
	case err == nil:
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("upsert session %s: commit: %w", sessionID, err)
		}
		return true, nil
	case !errors.Is(err, sql.ErrNoRows):
		return false, fmt.Errorf("upsert session %s: %w", sessionID, err)
	}
	var inserted bool
	if err := tx.QueryRowContext(ctx, w.q.upsertSessionRefresh, args...).Scan(&inserted); err != nil {
		return false, fmt.Errorf("upsert session %s: %w", sessionID, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("upsert session %s: commit: %w", sessionID, err)
	}
	return inserted, nil
}

// SessionCaptureEnabled reports whether the session was started with
// capture posture enabled. It is the server-authoritative gate for all
// prompt-content storage: content is persisted only when this returns
// true. A missing session row, a NULL posture (no authoritative
// session_start seen yet), or an explicit false all yield false so
// content is dropped fail-safe. See migration 000026 and SECURITY.md.
func (w *Writer) SessionCaptureEnabled(ctx context.Context, sessionID string) bool {
	var enabled bool
	err := w.db.Reader().QueryRowContext(ctx,
		`SELECT COALESCE(capture_prompts, false) FROM sessions WHERE session_id = $1`,
		canonicalUUID(sessionID),
	).Scan(&enabled)
	if err != nil {
		// No row yet (race with session_start) or query error: fail
		// safe -- do not store content.
		return false
	}
	return enabled
}

// SessionCapturePosture reads the session's stored capture posture.
// known is false when the row does not exist or its posture is NULL (a
// lazily created row or a parent stub, whose session_start has not been
// processed yet); enabled is the posture when known. Unlike
// SessionCaptureEnabled it returns a database error rather than folding
// it into "off", so the caller can retry the event instead of dropping
// its content on a transient failure.
func (w *Writer) SessionCapturePosture(ctx context.Context, sessionID string) (known, enabled bool, err error) {
	var posture *bool
	err = w.db.Reader().QueryRowContext(ctx,
		`SELECT capture_prompts FROM sessions WHERE session_id = $1`,
		canonicalUUID(sessionID),
	).Scan(&posture)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("read capture posture of %s: %w", sessionID, err)
	}
	if posture == nil {
		return false, false, nil
	}
	return true, *posture, nil
}

// UpgradeSessionContext fills in the sessions.context column on a row
// whose context is either NULL (lazy-create) or the empty JSON
// object “{}“. Once the column holds real data, the stored value is
// kept and the incoming payload is ignored -- write-once semantics for
// real context are preserved across every event type.
//
// Motivation: a Claude Code plugin session whose session_start POST
// fails (stack was down at claude start, transient DNS outage, ...)
// leaves the per-session dedup marker on disk, so session_start is
// never retried. Every subsequent event then flows through
// handleSessionGuard's lazy-create which writes flavor="unknown"
// and context=NULL. Without this helper the RUNTIME panel stays empty
// forever. Attaching context to every event and running this upgrade
// lets the first event that actually reaches the server populate the
// column.
//
// The two "no real context yet" sentinels in play are NULL
// (ReviveOrCreateSession writes explicit NULL; the column's DEFAULT on
// inserts that omit it) and the empty object (UpsertSession writes '{}'
// when the sensor ran collectContext and got nothing back). The helper
// treats both sentinels as "enrich me"; on SQLite the empty object is
// recognised whatever its whitespace.
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
	_, err := w.db.ExecContext(ctx, w.q.upgradeSessionContext, canonicalUUID(sessionID), string(contextJSON))
	if err != nil {
		return fmt.Errorf("upgrade session context %s: %w", sessionID, err)
	}
	return nil
}

// AppendMCPServerToContext UPSERTs a single MCP server fingerprint
// dict into “sessions.context.mcp_servers“.
// Idempotent dedup by (name, server_url) tuple — re-emitted
// “mcp_server_attached“ events from a framework reconnecting to
// the same server become no-ops at the row level. Drives live
// dashboard SessionDrawer panel population: the worker fires this
// on every “mcp_server_attached“ event, the dashboard re-fetches
// via WebSocket, the panel renders the new server within ~2-3 s.
//
// The dedup key intentionally uses the (name, server_url) tuple
// rather than the wire fingerprint hex so the stored dict shape
// stays exactly as “sessions.context.mcp_servers“ was on
// session_start (no schema bump). The (canonical_url,
// name) pair uniquely determines the fingerprint hex, so tuple
// dedup is information-equivalent to fingerprint dedup.
//
// The serverDict argument is a pre-marshaled JSON object whose
// keys match the existing context dict shape: “{name, transport,
// protocol_version, version, capabilities, instructions,
// server_url}“. The processor maps the wire-event payload's
// “server_name“/“server_url_canonical“ to “name“/
// “server_url“ before calling.
//
// SQL strategy: read the array, JSON-test for an existing entry
// matching (name, server_url), append only when no match. Single
// statement via the backend's JSON functions so the dedup + append
// happens atomically without a SELECT-then-UPDATE race window.
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
	_, err := w.db.ExecContext(ctx, w.q.appendMCPServer,
		canonicalUUID(sessionID), string(serverDict), serverName, serverURL)
	if err != nil {
		return fmt.Errorf(
			"append mcp server to context %s: %w", sessionID, err,
		)
	}
	return nil
}

// EventRow is one events row as the worker writes it. Pointer fields
// are NULL when nil; the string fields that map to nullable columns are
// NULL when empty.
type EventRow struct {
	// SensorEventID is the client-minted event UUID (payload.id); empty
	// lets the writer mint one.
	SensorEventID string
	SessionID     string
	Flavor        string
	EventType     string
	Model         string

	TokensInput         *int
	TokensOutput        *int
	TokensTotal         *int
	TokensCacheRead     *int64
	TokensCacheCreation *int64
	TokensReasoning     *int64

	// Token and cost columns (migration 000029).
	ModelRequested string
	ModelServed    string
	Provider       string
	BillingMode    string
	Platform       string
	CostReported   *float64
	CostSource     string

	LatencyMs  *int
	ToolName   *string
	HasContent bool
	OccurredAt time.Time

	// Payload is the JSON-encoded events.payload blob: per-event-type
	// metadata that has no column of its own (directive results, error
	// taxonomy, streaming stats, the token and cost fields that stay in
	// JSON). nil leaves the column NULL.
	Payload []byte
}

// InsertEvent inserts a new event record (metadata only) and returns the
// event ID.
func (w *Writer) InsertEvent(ctx context.Context, row EventRow) (string, error) {
	return insertEvent(ctx, w.db, row)
}

// InsertEventWithContent inserts an event and its captured content in
// one transaction, so a reader never sees an event that claims content
// (has_content) before the content row exists, and a failed content
// write never leaves such an event behind.
//
// Content that can never be stored (the blob does not parse, or the
// database rejects its row as invalid data) returns an error wrapping
// ErrEventContent and writes nothing. Every other error, including a
// transient failure of the content insert, is returned unwrapped with
// nothing written, so the caller's redelivery can retry the whole
// event.
func (w *Writer) InsertEventWithContent(ctx context.Context, row EventRow, content json.RawMessage) (string, error) {
	c, err := parseEventContent(content)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrEventContent, err)
	}
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin event transaction: %w", err)
	}
	// A no-op once Commit has succeeded.
	defer func() { _ = tx.Rollback() }()
	eventID, err := insertEvent(ctx, tx, row)
	if err != nil {
		return "", err
	}
	if err := insertEventContent(ctx, tx, eventID, row.SessionID, c); err != nil {
		if storage.IsDataError(err) {
			return "", fmt.Errorf("%w: %w", ErrEventContent, err)
		}
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit event transaction: %w", err)
	}
	return eventID, nil
}

func insertEvent(ctx context.Context, q querier, row EventRow) (string, error) {
	// Cache columns are NOT NULL DEFAULT 0; coalesce nil pointers to 0 rather
	// than relying on a NULL insert, which the column definition rejects.
	cacheRead := int64(0)
	if row.TokensCacheRead != nil {
		cacheRead = *row.TokensCacheRead
	}
	cacheCreation := int64(0)
	if row.TokensCacheCreation != nil {
		cacheCreation = *row.TokensCacheCreation
	}
	// The sensor mints the event UUID and ships it in payload.id
	// (string form); the writer mints one when the client sent none,
	// so both backends store the same canonical shape. ON CONFLICT
	// (id, occurred_at) DO NOTHING gives idempotent retry semantics —
	// a sensor flush retried after a transient ingestion failure lands
	// cleanly even if the first attempt's commit raced.
	id := canonicalUUID(row.SensorEventID)
	if id == "" {
		id = NewUUID()
	}
	var eventID string
	err := q.QueryRowContext(ctx, `
		INSERT INTO events (
			id, session_id, flavor, event_type, model,
			tokens_input, tokens_output, tokens_total,
			tokens_cache_read, tokens_cache_creation, tokens_reasoning,
			model_requested, model_served, provider, billing_mode, platform,
			cost_reported, cost_source,
			latency_ms, tool_name, has_content, occurred_at, payload
		)
		VALUES (
			$1, $2, $3, $4, NULLIF($5, ''),
			$6, $7, $8,
			$9, $10, $11,
			NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''),
			$17, NULLIF($18, ''),
			$19, $20, $21, $22, $23
		)
		ON CONFLICT (id, occurred_at) DO NOTHING
		RETURNING CAST(id AS TEXT)
	`,
		id, canonicalUUID(row.SessionID), row.Flavor, row.EventType, row.Model,
		row.TokensInput, row.TokensOutput, row.TokensTotal,
		cacheRead, cacheCreation, row.TokensReasoning,
		row.ModelRequested, row.ModelServed, row.Provider, row.BillingMode, row.Platform,
		row.CostReported, row.CostSource,
		row.LatencyMs, row.ToolName, row.HasContent, row.OccurredAt, jsonArg(row.Payload),
	).Scan(&eventID)
	if err != nil {
		// ON CONFLICT DO NOTHING suppresses the insert and returns no
		// row: the event is already stored under this id. Surface the id
		// back to the caller so downstream notify + content writes
		// reference the canonical row that already exists.
		if errors.Is(err, sql.ErrNoRows) {
			return id, nil
		}
		return "", fmt.Errorf("insert event: %w", err)
	}
	return eventID, nil
}

// InsertEventContent inserts prompt capture content into event_content.
// Called only when event.HasContent is true.
//
// “Input“ carries the embedding request's “input“
// parameter (string or list of strings) for “event_type=embeddings“
// events. Chat events leave Input null and populate Messages instead.
// The dashboard branches on event_type to render the appropriate
// viewer (PromptViewer for chat, EmbeddingsContentViewer for
// embeddings). See migration 000016_event_content_input.up.sql.
//
// Adds “ToolInput“ + “ToolOutput“
// keys for the tool-capture migration. mcp_tool_call /
// mcp_prompt_get / LLM-side tool_call route arguments + results
// through these dedicated columns instead of repurposing the
// LLM-prompt-style Messages/Response slots. See migration
// 000021_event_content_tool_capture.
func (w *Writer) InsertEventContent(ctx context.Context, eventID, sessionID string, content json.RawMessage) error {
	c, err := parseEventContent(content)
	if err != nil {
		return err
	}
	return insertEventContent(ctx, w.db, eventID, sessionID, c)
}

// eventContent is the parsed content blob, one field per event_content
// column.
type eventContent struct {
	Provider        string          `json:"provider"`
	Model           string          `json:"model"`
	SystemPrompt    *string         `json:"system"`
	Messages        json.RawMessage `json:"messages"`
	Tools           json.RawMessage `json:"tools"`
	Response        json.RawMessage `json:"response"`
	Input           json.RawMessage `json:"input"`
	ToolInput       json.RawMessage `json:"tool_input"`
	ToolOutput      json.RawMessage `json:"tool_output"`
	EmbeddingOutput json.RawMessage `json:"embedding_output"`
}

func parseEventContent(content json.RawMessage) (eventContent, error) {
	var c eventContent
	if err := json.Unmarshal(content, &c); err != nil {
		return c, fmt.Errorf("parse event content: %w", err)
	}
	// Default Messages to "[]" when absent so the column's
	// (post-000016) NULL allowance never produces a literal SQL NULL
	// for chat rows that omit messages -- only embedding rows
	// legitimately leave it empty.
	if len(c.Messages) == 0 {
		c.Messages = json.RawMessage("[]")
	}
	return c, nil
}

func insertEventContent(ctx context.Context, q querier, eventID, sessionID string, c eventContent) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO event_content (event_id, session_id, provider, model, system_prompt, messages, tools, response, input, tool_input, tool_output, embedding_output)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		ON CONFLICT (event_id) DO NOTHING
	`, canonicalUUID(eventID), canonicalUUID(sessionID), c.Provider, c.Model, c.SystemPrompt,
		jsonArg(c.Messages), jsonArg(c.Tools), jsonArg(c.Response), jsonArg(c.Input),
		jsonArg(c.ToolInput), jsonArg(c.ToolOutput), jsonArg(c.EmbeddingOutput))
	if err != nil {
		return fmt.Errorf("insert event content: %w", err)
	}
	return nil
}

// UpdateSessionFromCall records the model and framework of an event on
// HandlePostCall's path (a call, tool call, error or signal) on its
// session. Idempotent and backward-compatible: an empty *model* keeps the
// stored one (NULLIF maps "" to NULL, and COALESCE keeps the prior value),
// so sessions with no post_call keep model = NULL.
//
// *framework* fills sessions.framework only while it is NULL: the
// session_start carried none because the sensor detected the framework
// after init(), on a later event. A stored framework is never replaced.
// The bare label is also appended to context.frameworks, which the
// analytics framework dimension groups by, whenever it is the session's
// own label and no entry of the array has that label, versioned or
// bare. The session's own label is the column while NULL, or, on a
// sensor session (the only client that detects a framework late),
// the column's value. The check is on the array, not on the column: a
// call can fill the column of a lazily created row whose context is
// still NULL, and the session_start that then writes the context has no
// framework, so the next call appends it. A NULL or '{}' context is left
// to the session_start or UpgradeSessionContext. A session whose array
// lists its label (the plugin's claude-code/<v>, the Agent SDK's, one
// detected at init) is unchanged, and so is any other client's session
// with a framework, such as an OpenTelemetry Claude Code session, which
// carries its version as context.claude_code_version and no frameworks
// entry. Nothing is written when the call brings neither a model nor a
// framework to fill.
func (w *Writer) UpdateSessionFromCall(ctx context.Context, sessionID, model, framework string) error {
	if model == "" && framework == "" {
		return nil
	}
	_, err := w.db.ExecContext(ctx, w.q.updateSessionFromCall, canonicalUUID(sessionID), model, framework)
	if err != nil {
		return fmt.Errorf("update model and framework for %s: %w", sessionID, err)
	}
	return nil
}

// UpdateTokensUsed atomically increments tokens_used on a session.
func (w *Writer) UpdateTokensUsed(ctx context.Context, sessionID string, delta int) error {
	_, err := w.db.ExecContext(ctx, w.q.updateTokensUsed, delta, canonicalUUID(sessionID))
	if err != nil {
		return fmt.Errorf("update tokens_used for %s: %w", sessionID, err)
	}
	return nil
}

// AddTokensBeforeEnd rolls a call's tokens into a closed session when
// the call was published before the session_end that closed it: the
// sensor sends a run's last post_call and its session_end back to back,
// and the worker pool can apply the end first. seq is the call's stream
// sequence; closed_seq is the end's, so the comparison needs no clock.
// The session stays closed and last_seen_at does not move. An unknown
// sequence on either side matches nothing. Returns whether the row
// matched.
func (w *Writer) AddTokensBeforeEnd(ctx context.Context, sessionID string, seq uint64, delta int) (bool, error) {
	res, err := w.db.ExecContext(ctx, `
		UPDATE sessions
		SET tokens_used = tokens_used + $1
		WHERE session_id = $2
		  AND state = 'closed'
		  AND CAST($3 AS BIGINT) > 0
		  AND closed_seq > CAST($3 AS BIGINT)
	`, delta, canonicalUUID(sessionID), seqParam(seq))
	if err != nil {
		return false, fmt.Errorf("add tokens before end for %s: %w", sessionID, err)
	}
	return rowsAffected(res) == 1, nil
}

// UpdateLastSeen touches last_seen_at on a session (heartbeat path).
func (w *Writer) UpdateLastSeen(ctx context.Context, sessionID string) error {
	_, err := w.db.ExecContext(ctx, w.q.updateLastSeen, canonicalUUID(sessionID))
	if err != nil {
		return fmt.Errorf("update last_seen for %s: %w", sessionID, err)
	}
	return nil
}

// ReviveIfRevivable flips a stale or lost session back to active and
// advances last_seen_at. It generalises the session_start
// attach-on-terminal semantics to every event type: every
// non-session_start handler runs this before its normal side effects,
// so sessions that go stale/lost during interactive idle windows
// resume on the next event instead of freezing forever.
//
// Five places know how to revive or create a session. They mirror
// each other rather than share a helper; any change to the revival
// contract (columns touched, state predicate) must be applied to
// all five:
//
//  1. Ingestion: “session.Store.Attach“ runs synchronously on
//     “session_start“ so the HTTP response can report “attached=true“.
//     Scope: closed, lost -> active, clearing ended_at and closed_seq;
//     records a session_attachments row (the only writer of those).
//  2. Ingestion: “session.Store.RecordStart“ runs once the event is
//     published, when the row pre-existed. Stamps the start's stream
//     sequence and revives a closed row whose closed_seq is unknown or
//     below that sequence (the previous run's queued session_end closed
//     it between the check and the stamp), clearing ended_at and
//     closed_seq. Best effort: skips a row another writer holds and
//     retries on a short schedule (5, 10, 20 and 40 ms) before giving
//     up. No attachment row.
//  3. Worker, “UpsertSession“ ON CONFLICT branch. Scope: any prior
//     state -> whatever the session_start event asks for (always
//     “active“, clearing ended_at), except a closed row whose
//     session_end was published after this session_start, which stays
//     closed; with identity-column refresh and enrichment of the
//     “unknown“ sentinel and NULL context/token columns that a
//     lazy-create left behind. Records the start's stream sequence.
//  4. Worker, “ReviveIfRevivable“ (this function). Scope:
//     stale, lost -> active. No identity refresh, no attachment row.
//  5. Worker, “ReviveOrCreateSession“. Scope: delegates to
//     ReviveIfRevivable when the row exists, INSERTs a new row with
//     best-effort identity + “unknown“ sentinels when it does not, and
//     no start sequence: a straggler published after the run's end
//     must not read as the run's start. Called by every handler except
//     session_start and session_end so an event for an unknown
//     session_id lazily manifests the row instead of FK-violating at
//     InsertEvent.
//
// Scope of this helper:
//   - state IN ('stale', 'lost') -> UPDATE, returns (true, nil).
//   - state IN ('active', 'idle', 'closed') -> no-op, returns (false, nil).
//     closed stays terminal (user explicitly ended the session) and is
//     enforced at the handler layer, not here.
//   - session row does not exist -> no-op, returns (false, nil).
func (w *Writer) ReviveIfRevivable(ctx context.Context, sessionID string) (bool, error) {
	res, err := w.db.ExecContext(ctx, w.q.reviveIfRevivable, canonicalUUID(sessionID))
	if err != nil {
		return false, fmt.Errorf("revive session %s: %w", sessionID, err)
	}
	return rowsAffected(res) > 0, nil
}

// BumpParentLastSeen propagates a child event's freshness to the
// parent session: bumps parent.last_seen_at on every call, and revives
// `stale` / `lost` parents back to `active`. Closed parents are
// untouched — `closed` is terminal; reviving would contradict the
// explicit user end-of-session signal.
//
// A session with active descendants is logically active. Without this
// propagation the worker only updates each session row from its OWN
// events, so a parent session that handed off all real work to
// sub-agents (Claude Code Task, CrewAI handoff, LangGraph node) aged
// to `stale` after 2 minutes and `lost` after 30 minutes while its
// children clearly streamed events. The orphan-timeout reaper would
// then close the parent even though the children's traffic proved
// the session was alive.
//
// Returns (revived bool, err) — `revived` is true when the call
// transitioned the parent from stale/lost back to active. The caller
// (SessionProcessor.bumpParentIfPresent) bumps
// metrics.IncrSessionRevived(metrics.RevivalTriggerChildEvent) on
// revived=true so operators can chart the rate of parent-via-child
// revivals separately from any future revival path. A revival is also
// announced on flightdeck_fleet: the child's own notification names
// only the child, so without it a parent the dashboard showed going
// stale would stay stale there while its children worked. Concurrent
// children of one parent serialize on the row lock (Postgres) or the
// single writer (SQLite), so exactly one of them sees the stale or lost
// state and announces the revival.
//
// Scope: direct parent only. Transitive ancestor revival is deferred
// until a framework that exercises depth>2 trees ships (Claude Code
// Task subagents, CrewAI hand-off, LangGraph nodes are all
// parent-child today).
func (w *Writer) BumpParentLastSeen(
	ctx context.Context, parentSessionID string,
) (revived bool, err error) {
	if parentSessionID == "" {
		return false, nil
	}
	parentSessionID = canonicalUUID(parentSessionID)
	// The row's state before the write decides whether this was a
	// revival; it is read under the row lock the statement takes, so no
	// second SELECT is needed. An empty state means the row is closed
	// or missing.
	var prevState string
	if w.db.Backend == storage.SQLite {
		prevState, err = w.bumpParentSQLite(ctx, parentSessionID)
	} else {
		err = w.db.QueryRowContext(ctx, w.q.bumpParent, parentSessionID).Scan(&prevState)
		if errors.Is(err, sql.ErrNoRows) {
			err = nil
		}
	}
	if err != nil {
		return false, fmt.Errorf("bump parent last_seen %s: %w", parentSessionID, err)
	}
	switch prevState {
	case "stale", "lost":
		w.announce(ctx, "parent revival", stateChanges([]string{parentSessionID}))
		return true, nil
	case "":
		// Closed, or no row (a race with FK enforcement / the deletion
		// path). Both correctly no-op; closed parents must stay closed,
		// and the child event still lands.
		return false, nil
	default:
		// active / idle — bumped, not revived.
		return false, nil
	}
}

// ReviveOrCreateSession is the lazy-create path. Called by every
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
// Fail-open posture: on any database error during the existence
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
	parentSessionID, agentRole string,
) (created bool, err error) {
	sessionID = canonicalUUID(sessionID)
	var state string
	sErr := w.db.Reader().QueryRowContext(ctx,
		"SELECT state FROM sessions WHERE session_id = $1",
		sessionID,
	).Scan(&state)
	if sErr == nil {
		// Row exists. Delegate to the revive path -- it's a
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

	// Upsert the agents row first so the sessions FK lands
	// cleanly. Even a lazy-create path knows the authoritative agent
	// identity because the ingestion handler validated it on the
	// way in.
	if aErr := w.UpsertAgent(ctx, identity); aErr != nil {
		return false, fmt.Errorf("revive-or-create %s: upsert agent: %w", sessionID, aErr)
	}

	// context is written as explicit NULL (overriding the column's
	// DEFAULT '{}') so UpsertSession's COALESCE branch on the
	// next session_start can distinguish "nobody has populated this
	// yet" from "sensor ran collectContext and got an empty dict".
	// token_id / token_name are omitted from the column list; both
	// are nullable without a DEFAULT, so omission gives us NULL.
	// started_at and last_seen_at pin to the event's occurred_at so
	// the lazy row backdates to when the activity actually began,
	// not when the server got around to recording it.
	res, iErr := w.db.ExecContext(ctx, `
		INSERT INTO sessions (
			session_id, flavor, agent_type, host, framework, model, state,
			started_at, last_seen_at, context,
			agent_id, client_type, agent_name,
			parent_session_id, agent_role
		)
		VALUES (
			$1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
			'active', $7, $7, NULL,
			$8, $9, $10,
			$11, NULLIF($12, '')
		)
		ON CONFLICT (session_id) DO NOTHING
	`, sessionID, flavor, agentType, host, framework, model, occurredAt,
		canonicalUUID(identity.AgentID), identity.ClientType, identity.AgentName,
		nullIfEmpty(canonicalUUID(parentSessionID)), agentRole)
	if iErr != nil {
		return false, fmt.Errorf("revive-or-create %s: insert: %w", sessionID, iErr)
	}
	if rowsAffected(res) > 0 {
		// Fresh session row landed. Bump the agents rollup exactly
		// once per new session, matching the UpsertSession path.
		if bErr := w.BumpAgentSessionCount(ctx, identity.AgentID); bErr != nil {
			// Rollup failure is non-fatal: the session row exists and
			// the agent row exists, so dashboards still render; a
			// missed increment at worst shows one fewer session in the
			// total_sessions column until reconciliation runs.
			slog.Warn("bump agent session count failed (non-fatal)",
				"agent_id", logcap.ID(identity.AgentID), "err", logcap.Err(bErr))
		}
		return true, nil
	}
	return false, nil
}

// BackfillSubAgentLinkage upgrades a session row's
// parent_session_id + agent_role from NULL to the supplied values
// when an event payload carries them but the row was lazy-created
// (or upserted) before the parent linkage was visible. Idempotent —
// only writes when both columns are currently NULL on the row, so
// re-running on a session that already has linkage is a no-op.
//
// Why this exists: subagent sessions whose framework / plugin
// surface fails to fire a session_start (or whose session_start
// emission fails) get lazy-created from their first non-session_start
// event. The lazy-create path now also writes parent_session_id /
// agent_role when present, but sessions that were created before
// THIS code shipped — or sessions where the subagent's first event
// landed before the linkage info became available on the wire —
// would otherwise stay orphaned forever. Calling this from the
// per-event path covers both cases.
func (w *Writer) BackfillSubAgentLinkage(
	ctx context.Context,
	sessionID, parentSessionID, agentRole string,
) error {
	if parentSessionID == "" && agentRole == "" {
		return nil
	}
	_, err := w.db.ExecContext(ctx, `
		UPDATE sessions
		SET parent_session_id = COALESCE(parent_session_id, $2),
		    agent_role        = COALESCE(agent_role, NULLIF($3, ''))
		WHERE session_id = $1
		  AND (parent_session_id IS NULL OR agent_role IS NULL)
	`, canonicalUUID(sessionID), nullIfEmpty(canonicalUUID(parentSessionID)), agentRole)
	if err != nil {
		return fmt.Errorf("backfill sub-agent linkage %s: %w", sessionID, err)
	}
	return nil
}

// SessionExists reports whether a session row with the given session_id
// is present in the sessions table. Used by HandleSessionStart's
// parent-stub branch to decide whether the parent of an
// incoming sub-agent session_start is already in the DB or needs a
// stub INSERT before the child's UpsertSession runs.
//
// Returns (false, nil) when the row is absent — the canonical "not
// found" signal used by the parent-stub guard. Database errors other
// than no-rows propagate so callers can treat them as transient.
func (w *Writer) SessionExists(ctx context.Context, sessionID string) (bool, error) {
	var n int
	err := w.db.Reader().QueryRowContext(ctx, `
		SELECT 1 FROM sessions WHERE session_id = $1
	`, canonicalUUID(sessionID)).Scan(&n)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("session exists %s: %w", sessionID, err)
	}
	return true, nil
}

// UpsertParentStub is the forward-reference soft-link extension
// to the lazy-create primitive. Triggered when a
// sub-agent “session_start“ arrives with a “parent_session_id“
// that doesn't yet exist in “sessions“ — without a row at the
// parent end, the child's INSERT fails the new
// “parent_session_id“ FK at schema-enforcement time. The stub
// row carries the same “"unknown"“ sentinels as
// “ReviveOrCreateSession“ plus a placeholder “started_at“
// matching the child's so the timeline ordering is sensible while
// the real parent's authoritative data hasn't arrived yet.
//
// The stub belongs to no agent: its agent_id / client_type /
// agent_name are NULL and no agent's total_sessions counts it. When the
// real parent's “session_start“ arrives later, “UpsertSession“'s
// claim statement fills in the stub's identity, upgrades its
// “"unknown"“ flavor / agent_type, and reports the row attributed, so
// the parent's agent counts the session once. When the parent's
// session_start is never processed, the first other event of the parent
// session does the same through “AttributeSession“. Same primitive as the lazy
// create-on-unknown, different trigger (FK-satisfaction vs
// unknown-session-id event); kept as a separate helper so
// callers don't need to express the parent-stub-specific shape
// (started_at = child.started_at, no agents row required because
// the real parent will UpsertAgent on its own arrival) through
// the four-axis revive/create config surface that's the reason
// the revive / create sites are uncoalesced. “ON CONFLICT DO NOTHING“ covers the
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
	res, iErr := w.db.ExecContext(ctx, `
		INSERT INTO sessions (
			session_id, flavor, agent_type, state,
			started_at, last_seen_at, context
		)
		VALUES (
			$1, 'unknown', 'unknown', 'active',
			$2, $2, NULL
		)
		ON CONFLICT (session_id) DO NOTHING
	`, canonicalUUID(parentSessionID), childStartedAt)
	if iErr != nil {
		return false, fmt.Errorf("upsert parent stub %s: %w", parentSessionID, iErr)
	}
	return rowsAffected(res) > 0, nil
}

// AttributeSession gives a session row that no agent owns yet (a parent
// stub whose own session_start has not been processed) the identity of
// the agent an event of that session carries, and reports whether this
// call did, so the caller adds the session to that agent's
// total_sessions once. client_type and agent_name are filled only where
// still NULL. The agent row must exist (sessions.agent_id references
// agents), so callers upsert it first.
//
// The UPDATE re-checks “agent_id IS NULL“ on the row it locks, so of
// this call and a concurrent writer attributing the same row (another
// event's AttributeSession, or UpsertSession's claim for the session's
// session_start) exactly one changes it. The row must be visible to the
// statement, which holds for a caller that has already read it.
func (w *Writer) AttributeSession(
	ctx context.Context, sessionID string, id AgentIdentity,
) (attributed bool, err error) {
	res, err := w.db.ExecContext(ctx, `
		UPDATE sessions
		SET agent_id = $2,
		    client_type = COALESCE(client_type, NULLIF($3, '')),
		    agent_name = COALESCE(agent_name, NULLIF($4, ''))
		WHERE session_id = $1
		  AND agent_id IS NULL
	`, canonicalUUID(sessionID), canonicalUUID(id.AgentID), id.ClientType, id.AgentName)
	if err != nil {
		return false, fmt.Errorf("attribute session %s: %w", sessionID, err)
	}
	return rowsAffected(res) == 1, nil
}

// BumpAgentSessionCount increments agents.total_sessions by 1. Called
// once per session row that becomes attributed to the agent: when
// UpsertSession reports attributed (it inserted the row or claimed a
// parent stub), when ReviveOrCreateSession inserts the row, and when
// AttributeSession fills a stub's identity. Each of those reports true
// for exactly one caller per row, so the counter stays accurate under
// redelivered and concurrent events for the same session_id.
func (w *Writer) BumpAgentSessionCount(ctx context.Context, agentID string) error {
	_, err := w.db.ExecContext(ctx, w.q.bumpAgentSessionCount, canonicalUUID(agentID))
	if err != nil {
		return fmt.Errorf("bump agent session count %s: %w", agentID, err)
	}
	return nil
}

// SettleSessionEnd applies a session_end to its row: an open row whose
// current run began before the end was published (start_seq below the
// end's sequence, or either unknown) is closed and records the end's
// sequence; a row that is already closed keeps its close but takes a
// greater closed_seq, so a session_start queued between a run's end
// and the next run's end cannot revive a session whose later run has
// also ended. The predicate is part of the UPDATE so that a
// re-attaching session_start committed between a read and this write
// cannot be closed by the previous run's end. A closed row whose
// closed_seq is already at or past this end is left untouched, so a
// duplicate end at or below the stored closed_seq costs no write.
//
// The close dates ended_at by the database's clock, except on an
// assembled OpenTelemetry session (the row's context carries
// otel_trace_id), which is published after its run and takes endedAt,
// capped at the clock. A zero endedAt (a timestamp that did not parse)
// is the clock.
//
// Returns whether a row matched and whether it was closed by this call;
// no match means the row is missing, already closed by this or a later
// end, or opened by a later start, which the caller tells apart with a
// read. Whether this call closed the row is the row's state before the
// write, read under the row lock (Postgres) or inside the write
// transaction (SQLite), so it holds whatever date the close wrote: an
// event-dated ended_at can equal the one already stored (a
// re-attachment's end is dated at the original end), so comparing it
// with the clock or with the end's own time would not tell a close from
// a duplicate.
func (w *Writer) SettleSessionEnd(ctx context.Context, sessionID string, closedSeq uint64, endedAt time.Time) (applied, closedNow bool, err error) {
	sessionID = canonicalUUID(sessionID)
	if w.db.Backend == storage.SQLite {
		return w.settleSessionEndSQLite(ctx, sessionID, seqParam(closedSeq), timeParam(endedAt))
	}
	err = w.db.QueryRowContext(ctx, w.q.settleSessionEnd, sessionID, seqParam(closedSeq), timeParam(endedAt)).Scan(&closedNow)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("settle session end %s: %w", sessionID, err)
	}
	return true, closedNow, nil
}

// timeParam converts an event's timestamp for a timestamp parameter.
// The zero time (a timestamp that did not parse) is NULL, which the
// statements read as the database's clock.
func timeParam(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// seqParam converts a stream sequence for a bigint parameter. Zero means
// unknown throughout, and a value beyond the bigint range (which no
// stream will reach) is treated as unknown rather than wrapped.
func seqParam(seq uint64) int64 {
	if seq > math.MaxInt64 {
		return 0
	}
	return int64(seq)
}

// rowsAffected is the count a statement reports. Both drivers report
// it for UPDATE, INSERT and DELETE; the error return exists for drivers
// that cannot, so it is folded into zero rather than threaded through
// every caller.
func rowsAffected(res sql.Result) int64 {
	n, err := res.RowsAffected()
	if err != nil {
		return 0
	}
	return n
}

// ClearSequencesAbove forgets every stored stream sequence greater than
// lastSeq, the FLIGHTDECK stream's current last sequence. Sequences are
// only comparable within one incarnation of the stream: after an
// operator recreates it, numbering restarts at one and every stored
// value would outrank every new event, so the rows fall back to the
// plain state rules. Returns the number of rows touched.
func (w *Writer) ClearSequencesAbove(ctx context.Context, lastSeq uint64) (int64, error) {
	res, err := w.db.ExecContext(ctx, `
		UPDATE sessions
		SET start_seq = CASE WHEN start_seq > CAST($1 AS BIGINT) THEN NULL ELSE start_seq END,
		    closed_seq = CASE WHEN closed_seq > CAST($1 AS BIGINT) THEN NULL ELSE closed_seq END
		WHERE start_seq > CAST($1 AS BIGINT) OR closed_seq > CAST($1 AS BIGINT)
	`, seqParam(lastSeq))
	if err != nil {
		return 0, fmt.Errorf("clear sequences above %d: %w", lastSeq, err)
	}
	return rowsAffected(res), nil
}

// ReconcileStaleSessions sets stale after `staleThreshold` silence,
// lost after `lostThreshold`. lost → closed is a separate, configurable
// transition handled by ReapOrphanedLostSessions so operators can tune
// the orphan-timeout window without recompiling the worker.
//
// Every session it moves is announced on flightdeck_fleet once its
// UPDATE has committed, so an open dashboard shows the run go stale or
// lost without reloading; the dashboard never applies the thresholds
// itself. A session marked stale and then lost in the same pass is
// announced once. The stale marks are announced even when the lost
// step fails: they are committed either way.
func (w *Writer) ReconcileStaleSessions(ctx context.Context) error {
	// Mark stale: active sessions with no signal for > staleThreshold
	stale, err := w.moveSessions(ctx, w.q.markStale, -int64(staleThreshold.Seconds()))
	if err != nil {
		return fmt.Errorf("mark stale: %w", err)
	}

	// Mark lost: stale sessions with no signal for > lostThreshold
	lost, lostErr := w.moveSessions(ctx, w.q.markLost, -int64(lostThreshold.Seconds()))

	w.announce(ctx, "reconcile", stateChanges(stale, lost))
	if lostErr != nil {
		return fmt.Errorf("mark lost: %w", lostErr)
	}
	return nil
}

// moveSessions runs a state-transition UPDATE whose RETURNING clause
// yields the id of each session it moved. It returns once the statement
// has committed and its rows are drained, so announcing the ids
// afterwards can never reach the hub before the change is visible.
func (w *Writer) moveSessions(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := w.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return collectStrings(rows)
}

// collectStrings drains a one-column result set into a slice and
// closes it.
func collectStrings(rows *sql.Rows) ([]string, error) {
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// orphanCloseEventType is the event the reaper writes for each session
// it closes, and the event_type its notification names, so the hub
// broadcasts the close like any other session_end.
const orphanCloseEventType = "session_end"

// ReapOrphanedLostSessions closes lost sessions that have been silent
// longer than `threshold`, stamping close_reason="orphan_timeout" via
// a synthetic session_end event so the dashboard's close-reason facet
// reflects the reconciler's verdict alongside happy-path shutdowns.
//
// On Postgres one statement acquires row-level locks with FOR UPDATE
// SKIP LOCKED, so two reconciler instances racing on the same tick reap
// disjoint subsets rather than fighting for the same row; on SQLite,
// where one process holds the single writer, the same happens in one
// transaction. The synthetic event takes the schema's defaults for its
// id and time; downstream consumers (close-reason facet, session detail
// fetch) treat it identically to a plugin- or sensor-emitted
// session_end. Once the statement has committed, each closed session is
// announced on flightdeck_fleet with its synthetic event, so an open
// dashboard receives the close as a session_end. Returns the number of
// sessions reaped so the caller can bump metrics.IncrSessionClosed.
func (w *Writer) ReapOrphanedLostSessions(
	ctx context.Context,
	threshold time.Duration,
) (int, error) {
	var closes []fleetNotifyPayload
	var err error
	if w.db.Backend == storage.SQLite {
		closes, err = w.reapOrphansSQLite(ctx, -int64(threshold.Seconds()))
	} else {
		closes, err = w.reapOrphansPostgres(ctx, -int64(threshold.Seconds()))
	}
	if err != nil {
		return 0, fmt.Errorf("reap orphaned lost sessions (threshold=%s): %w", threshold, err)
	}
	w.announce(ctx, "reap", closes)
	return len(closes), nil
}

// reapOrphansPostgres runs the reaper's one statement and collects the
// closes it announces.
func (w *Writer) reapOrphansPostgres(ctx context.Context, cutoffSecs int64) ([]fleetNotifyPayload, error) {
	rows, err := w.db.QueryContext(ctx, w.q.reapOrphans, cutoffSecs, orphanCloseEventType)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var closes []fleetNotifyPayload
	for rows.Next() {
		p := fleetNotifyPayload{EventType: orphanCloseEventType}
		if err := rows.Scan(&p.SessionID, &p.EventID); err != nil {
			return nil, err
		}
		closes = append(closes, p)
	}
	return closes, rows.Err()
}

// queries is the writer's SQL for one backend. The statements shared
// by both dialects are rendered once with the dialect's current-time
// and interval expressions; the rest come from the backend's query set.
type queries struct {
	// nowExpr is the dialect's current-time expression, for the
	// statements the SQLite transaction forms build at run time.
	nowExpr string

	upsertAgent           string
	incrementAgentTokens  string
	updateTokensUsed      string
	updateLastSeen        string
	reviveIfRevivable     string
	bumpAgentSessionCount string
	markStale             string
	markLost              string

	// Per-backend statements (queries_postgres.go, queries_sqlite.go).
	upsertSessionClaim    string
	upsertSessionRefresh  string
	upgradeSessionContext string
	appendMCPServer       string
	updateSessionFromCall string
	// bumpParent and settleSessionEnd are the Postgres single-statement
	// forms; SQLite runs the transaction forms in queries_sqlite.go.
	bumpParent       string
	settleSessionEnd string
	// reapOrphans is the Postgres single-statement form.
	reapOrphans string
	// backfillSelect claims a batch of events to rewrite.
	backfillSelect string
}

// nowMarker and cutoffMarker stand, in the shared statements, for the
// dialect's current time and for the current time shifted by the
// bound number of seconds (negative: a cutoff in the past).
const (
	nowMarker    = "{{now}}"
	cutoffMarker = "{{cutoff}}"
)

const (
	upsertAgentSQL = `
		INSERT INTO agents (
			agent_id, agent_type, client_type, agent_name,
			user_name, hostname, first_seen_at, last_seen_at
		)
		VALUES (
			$1, $2, $3, $4, $5, $6, {{now}}, {{now}}
		)
		ON CONFLICT (agent_id) DO UPDATE
		SET last_seen_at = {{now}}`

	incrementAgentTokensSQL = `
		UPDATE agents
		SET total_tokens = total_tokens + $2,
		    last_seen_at = {{now}}
		WHERE agent_id = $1`

	updateTokensUsedSQL = `
		UPDATE sessions
		SET tokens_used = tokens_used + $1,
		    last_seen_at = {{now}}
		WHERE session_id = $2`

	updateLastSeenSQL = `
		UPDATE sessions SET last_seen_at = {{now}} WHERE session_id = $1`

	reviveIfRevivableSQL = `
		UPDATE sessions
		SET state = 'active',
		    last_seen_at = {{now}}
		WHERE session_id = $1
		  AND state IN ('stale', 'lost')`

	bumpAgentSessionCountSQL = `
		UPDATE agents
		SET total_sessions = total_sessions + 1,
		    last_seen_at = {{now}}
		WHERE agent_id = $1`

	markStaleSQL = `
		UPDATE sessions
		SET state = 'stale'
		WHERE state IN ('active', 'idle')
		  AND last_seen_at < {{cutoff}}
		RETURNING CAST(session_id AS TEXT)`

	markLostSQL = `
		UPDATE sessions
		SET state = 'lost'
		WHERE state = 'stale'
		  AND last_seen_at < {{cutoff}}
		RETURNING CAST(session_id AS TEXT)`
)

// now is the dialect's current-time expression.
func (q queries) now() string { return q.nowExpr }

// newQueries renders the writer's SQL for the database's backend.
func newQueries(db *storage.DB) queries {
	d := db.Dialect
	q := postgresQueries
	if db.Backend == storage.SQLite {
		q = sqliteQueries
	}
	now := d.Now()
	q.nowExpr = now
	render := func(sql string) string {
		sql = strings.ReplaceAll(sql, cutoffMarker, d.AddInterval(now, "$1"))
		return strings.ReplaceAll(sql, nowMarker, now)
	}
	q.upsertAgent = render(upsertAgentSQL)
	q.incrementAgentTokens = render(incrementAgentTokensSQL)
	q.updateTokensUsed = render(updateTokensUsedSQL)
	q.updateLastSeen = render(updateLastSeenSQL)
	q.reviveIfRevivable = render(reviveIfRevivableSQL)
	q.bumpAgentSessionCount = render(bumpAgentSessionCountSQL)
	q.markStale = render(markStaleSQL)
	q.markLost = render(markLostSQL)
	q.upsertSessionClaim = render(q.upsertSessionClaim)
	q.upsertSessionRefresh = render(q.upsertSessionRefresh)
	q.bumpParent = render(q.bumpParent)
	q.settleSessionEnd = render(q.settleSessionEnd)
	q.reapOrphans = render(q.reapOrphans)
	return q
}
