// Package processor contains event processing logic for the worker pipeline.
package processor

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
)

// identityFromEvent extracts the agent identity fields from an
// event payload. The ingestion API has already validated them (UUID
// shape, vocabulary), so the worker trusts the values verbatim.
func identityFromEvent(e consumer.EventPayload) writer.AgentIdentity {
	return writer.AgentIdentity{
		AgentID:    e.AgentID,
		AgentType:  e.AgentType,
		ClientType: e.ClientType,
		AgentName:  e.AgentName,
		UserName:   e.User,
		Hostname:   e.Hostname,
	}
}

// SessionProcessor manages the session state machine in the database.
// Its own reads run on the database's read handle; its writes go
// through the writer.
type SessionProcessor struct {
	w  *writer.Writer
	db *storage.DB

	// lookupSession, settleEnd and readOwner are the database reads and
	// writes HandleSessionEnd makes for every end. Nil means the real
	// store; unit tests set stubs. Claiming an ownerless row
	// (attributeSession, when readOwner reports one) goes through the
	// writer, which the database-backed tests exercise.
	lookupSession func(ctx context.Context, sessionID string) (sessionLookup, error)
	settleEnd     func(ctx context.Context, sessionID string, closedSeq uint64, endedAt time.Time) (applied, closedNow bool, err error)
	readOwner     func(ctx context.Context, sessionID string) (ownerless bool, err error)
}

// ErrEventDropped is returned by HandleSessionEnd when it discards an
// orphan session_end. Process turns it into a nil return, so the
// consumer ACKs the message and no event row is inserted.
var ErrEventDropped = errors.New("processor: event dropped")

// NewSessionProcessor creates a SessionProcessor.
func NewSessionProcessor(w *writer.Writer, db *storage.DB) *SessionProcessor {
	return &SessionProcessor{w: w, db: db}
}

func (sp *SessionProcessor) lookupState(ctx context.Context, sessionID string) (sessionLookup, error) {
	if sp.lookupSession != nil {
		return sp.lookupSession(ctx, sessionID)
	}
	return sp.sessionLookupState(ctx, sessionID)
}

func (sp *SessionProcessor) settleRow(ctx context.Context, sessionID string, closedSeq uint64, endedAt time.Time) (applied, closedNow bool, err error) {
	if sp.settleEnd != nil {
		return sp.settleEnd(ctx, sessionID, closedSeq, endedAt)
	}
	return sp.w.SettleSessionEnd(ctx, sessionID, closedSeq, endedAt)
}

// eventTime is the time the event's client dated it, or the zero time
// when its timestamp does not parse. Only an assembled OpenTelemetry
// session's start and end are dated by it (the writer caps it at the
// worker's clock, and reads the zero time as the clock); every other
// session takes the worker's clock.
func eventTime(e consumer.EventPayload) time.Time {
	ts, err := time.Parse(time.RFC3339, e.Timestamp)
	if err != nil {
		return time.Time{}
	}
	return ts
}

// rowOwnerless reports whether the session row exists and no agent owns
// it. A missing row reports false: there is nothing to claim.
func (sp *SessionProcessor) rowOwnerless(ctx context.Context, sessionID string) (bool, error) {
	if sp.readOwner != nil {
		return sp.readOwner(ctx, sessionID)
	}
	var ownerless bool
	err := sp.db.Reader().QueryRowContext(ctx,
		"SELECT agent_id IS NULL FROM sessions WHERE session_id = $1", sessionID,
	).Scan(&ownerless)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read owner of session %s: %w", sessionID, err)
	}
	return ownerless, nil
}

// handleSessionGuard enforces the revive-or-create-or-skip policy
// before a non-session_start handler applies its side effects.
//
//   - closed -> warn + skip. The user explicitly ended the session;
//     reviving would contradict an explicit exit. HandlePostCall still
//     adds the tokens of a call published before the end.
//   - stale/lost -> warn + revive to active + advance last_seen_at.
//     Caller proceeds with normal processing.
//   - not-found (sql.ErrNoRows) -> lazy-create a new row from
//     the event's best-effort identity fields, then caller proceeds.
//     Without this the caller's UPDATE queries no-op silently and
//     the subsequent InsertEvent FK-violates, so the event is
//     dropped even though the session is legitimately active.
//   - active / idle / unknown-DB-error -> no-op, caller proceeds.
//
// Whatever its state, a row that no agent owns (a parent stub whose own
// session_start has not been processed) is first attributed to the
// event's agent and counted toward its total_sessions once
// (attributeSession).
//
// Returns true if the caller should skip further processing (closed
// sessions only). All other states / failure modes fall open so the
// event's downstream UPDATE + InsertEvent have a chance to succeed.
//
// The one exception to skipping a closed row at once is a late call of
// an assembled OpenTelemetry session (awaitsReattachment): the guard
// then returns consumer.ErrRetryLater, so the event is redelivered after
// the re-attaching session_start another worker replica holds has
// landed. The same read supplies the row's closed_seq and context, so
// the check costs no extra query.
//
// HandleSessionEnd does its own lookup instead -- closing a stale/lost
// session should transition directly via SettleSessionEnd, and we do
// not lazy-create on session_end (a teardown signal for a session we
// never saw should not retroactively manifest a closed row).
func (sp *SessionProcessor) handleSessionGuard(ctx context.Context, e consumer.EventPayload) (skip bool, err error) {
	var state string
	var unattributed, assembled bool
	var closedSeq int64
	err = sp.db.Reader().QueryRowContext(ctx, sp.guardReadSQL(), e.SessionID).Scan(&state, &unattributed, &closedSeq, &assembled)
	if errors.Is(err, sql.ErrNoRows) {
		// Session never seen. Lazy-create from event fields.
		occurredAt, tsErr := time.Parse(time.RFC3339, e.Timestamp)
		if tsErr != nil {
			occurredAt = time.Now().UTC()
		}
		created, cErr := sp.w.ReviveOrCreateSession(
			ctx, e.SessionID, e.Flavor, e.AgentType,
			e.Host, e.Framework, e.Model,
			identityFromEvent(e), occurredAt,
			e.ParentSessionID, e.AgentRole,
		)
		if cErr != nil {
			// Lazy-create failed. Log and fail open -- InsertEvent
			// will then FK-violate and the consumer will Nak+retry,
			// so a transient DB failure costs a redelivery, not the event.
			slog.Error("lazy-create session failed",
				"session_id", e.SessionID,
				"event_type", logcap.EventType(e.EventType),
				"err", logcap.Err(cErr),
			)
			return false, nil
		}
		if created {
			slog.Info("lazy-created session on event",
				"session_id", e.SessionID,
				"event_type", logcap.EventType(e.EventType),
				"flavor", logcap.Name(e.Flavor),
			)
		} else {
			// The row appeared after the read above: another event of
			// the session created it, or a sub-agent's session_start
			// wrote it as a parent stub, which no agent owns yet.
			sp.attributeSession(ctx, e)
		}
		sp.upgradeContextIfPresent(ctx, e)
		return false, nil
	}
	if err != nil {
		// Non-ErrNoRows DB error -- fail open, like the rest of this
		// guard. Skip the context upgrade: we
		// have no confirmation the row exists, so the UPDATE would
		// no-op silently, and a transient DB blip should not trigger
		// extra write pressure.
		return false, nil
	}
	if unattributed {
		sp.attributeSession(ctx, e)
	}
	// Row exists. If the event payload carries sub-agent linkage
	// and the row's parent_session_id / agent_role columns are still
	// NULL (lazy-create that ran before linkage was visible, or a
	// session whose framework / plugin failed to emit session_start
	// but keeps emitting interior events), backfill idempotently.
	// No-op when the row already has linkage.
	if e.ParentSessionID != "" || e.AgentRole != "" {
		if bErr := sp.w.BackfillSubAgentLinkage(
			ctx, e.SessionID, e.ParentSessionID, e.AgentRole,
		); bErr != nil {
			slog.Warn("sub-agent linkage backfill failed",
				"session_id", e.SessionID,
				"err", logcap.Err(bErr),
			)
		}
	}
	switch state {
	case "closed":
		if awaitsReattachment(e, closedSeq, assembled) {
			return false, consumer.ErrRetryLater
		}
		metrics.IncrDropped(metrics.ReasonClosedSessionSkip)
		slog.Warn("skipping event for closed session",
			"session_id", e.SessionID,
			"event_type", logcap.EventType(e.EventType),
		)
		return true, nil
	case "stale", "lost":
		slog.Warn("reviving stale/lost session on event",
			"session_id", e.SessionID,
			"event_type", logcap.EventType(e.EventType),
			"prior_state", state,
		)
		if _, rerr := sp.w.ReviveIfRevivable(ctx, e.SessionID); rerr != nil {
			// Revival failure is non-fatal: log and let the event's
			// normal side effects run. UpdateLastSeen / UpdateTokensUsed
			// still execute the same UPDATE against state-agnostic
			// WHERE clauses, so last_seen_at advances even if the
			// state flip missed. The worst case is the reconciler
			// re-observes state=stale|lost with a fresh last_seen_at
			// on its next tick and leaves it alone.
			slog.Error("revive session failed",
				"session_id", e.SessionID,
				"event_type", logcap.EventType(e.EventType),
				"err", logcap.Err(rerr),
			)
		}
		sp.upgradeContextIfPresent(ctx, e)
		return false, nil
	default:
		sp.upgradeContextIfPresent(ctx, e)
		return false, nil
	}
}

// The guard's read, per backend: the row's state, whether no agent
// owns it, its end sequence and whether its context carries the
// otel_trace_id key (an assembled OpenTelemetry session). Postgres
// tests the key with its `?` operator; SQLite with json_type, which is
// NULL for a missing key and a type name (including 'null') for a
// present one.
const (
	guardReadPostgresSQL = `
		SELECT state, agent_id IS NULL, COALESCE(closed_seq, 0),
		       COALESCE(context ? 'otel_trace_id', false)
		FROM sessions WHERE session_id = $1`
	guardReadSQLiteSQL = `
		SELECT state, agent_id IS NULL, COALESCE(closed_seq, 0),
		       json_type(context, '$.otel_trace_id') IS NOT NULL
		FROM sessions WHERE session_id = $1`
)

// guardReadSQL is handleSessionGuard's read for the database's backend.
func (sp *SessionProcessor) guardReadSQL() string {
	if sp.db.Backend == storage.SQLite {
		return guardReadSQLiteSQL
	}
	return guardReadPostgresSQL
}

// awaitsReattachment reports whether a call that found its session
// closed should be redelivered rather than skipped. An assembled
// OpenTelemetry session (its context carries otel_trace_id) gets its
// late calls wrapped in a re-attaching session_start and a session_end;
// every worker replica pulls from the one durable consumer, so the call
// can reach this replica while the start waits in another's lane. The
// row is then still closed by the previous run's end, with the call's
// stream sequence above closed_seq, and the call's tokens would not be
// added. Redelivered, the call finds the row reopened by the start, or
// closed again by the new end with the call before it, and its tokens
// count.
//
// Only token-bearing calls wait (a post_call, embeddings or llm_error
// with tokens, the ones addTokensBeforeEnd would count), only on
// assembled sessions, and only with both sequences known. Every other
// event on a closed row, and every other client's straggler after its
// end, is skipped at once. On the last delivery the budget allows the
// call never waits: it takes the closed-session skip, with its event
// row stored.
func awaitsReattachment(e consumer.EventPayload, closedSeq int64, assembled bool) bool {
	if e.FinalDelivery || !assembled || !tokenBearing(e) {
		return false
	}
	return closedSeq > 0 && e.StreamSeq > uint64(closedSeq)
}

// tokenBearing reports whether the event is a model call that adds
// tokens to its session.
func tokenBearing(e consumer.EventPayload) bool {
	switch e.EventType {
	case "post_call", "embeddings", "llm_error":
		return e.TokensTotal != nil && *e.TokensTotal > 0
	}
	return false
}

// attributeSession gives a session row that no agent owns yet the
// identity of the event's agent and, when this call did, counts the
// session toward that agent's total_sessions. Such a row is a parent
// stub whose own session_start has not been processed, or never will be
// (a client that failed to send it); left alone, the session would
// belong to no agent and its agent would show no sessions on the Fleet.
// Only an identity ingestion validated decides the owner: POST
// /v1/events and the OTLP receiver check agent_id, agent_type and
// client_type on every event, but POST /v1/heartbeat forwards its body
// unchecked, so a heartbeat never claims a row (the agents table's own
// constraints would apply either way). Best effort: a failure is logged,
// and the session's next event or its session_start tries again.
func (sp *SessionProcessor) attributeSession(ctx context.Context, e consumer.EventPayload) {
	if e.AgentID == "" || e.EventType == "heartbeat" {
		return
	}
	identity := identityFromEvent(e)
	// The sessions.agent_id foreign key needs the agent row, which an
	// agent whose session_start was never processed may not have yet.
	if err := sp.w.UpsertAgent(ctx, identity); err != nil {
		slog.Warn("upsert agent for session attribution failed",
			"session_id", e.SessionID,
			"agent_id", logcap.ID(e.AgentID),
			"err", logcap.Err(err),
		)
		return
	}
	attributed, err := sp.w.AttributeSession(ctx, e.SessionID, identity)
	if err != nil {
		slog.Warn("attribute session failed",
			"session_id", e.SessionID,
			"agent_id", logcap.ID(e.AgentID),
			"err", logcap.Err(err),
		)
		return
	}
	if !attributed {
		return
	}
	slog.Info("attributed session to its agent on event",
		"session_id", e.SessionID,
		"agent_id", logcap.ID(e.AgentID),
		"event_type", logcap.EventType(e.EventType),
	)
	if bErr := sp.w.BumpAgentSessionCount(ctx, e.AgentID); bErr != nil {
		// Non-fatal -- see ReviveOrCreateSession rationale.
		slog.Warn("bump agent session count failed (attribution)",
			"session_id", e.SessionID,
			"agent_id", logcap.ID(e.AgentID),
			"err", logcap.Err(bErr),
		)
	}
}

// claimOwnerlessRow runs attributeSession for an event that bypasses
// handleSessionGuard (session_end) when the event's session row exists
// and no agent owns it. The read keeps the common case, a row with an
// owner, to one indexed lookup with no write. A missing row is left
// missing: this never creates one.
func (sp *SessionProcessor) claimOwnerlessRow(ctx context.Context, e consumer.EventPayload) {
	if e.AgentID == "" {
		return
	}
	ownerless, err := sp.rowOwnerless(ctx, e.SessionID)
	if err != nil {
		slog.Warn("read session owner failed",
			"session_id", e.SessionID,
			"event_type", logcap.EventType(e.EventType),
			"err", logcap.Err(err),
		)
		return
	}
	if ownerless {
		sp.attributeSession(ctx, e)
	}
}

// upgradeContextIfPresent fills in sessions.context when the incoming
// event carries one. Called from every non-closed branch of
// handleSessionGuard so lazy-created rows and already-active
// rows whose session_start never landed both pick up context from the
// first event that actually reaches the worker.
//
// Scoped to the context column only. Flavor, agent_type, token_id,
// and token_name remain session_start-only writes to preserve
// attribution semantics: a non-session_start event has no authoritative
// source for those columns.
//
// The UPDATE uses COALESCE(NULLIF(context, '{}'::jsonb), EXCLUDED) so
// real stored context is not overwritten -- safe to call repeatedly,
// safe on the session revival path where the context genuinely changed
// since the previous run (default: keep-old / write-once; revisit if
// users report stale working_dir after cross-run directory changes).
func (sp *SessionProcessor) upgradeContextIfPresent(ctx context.Context, e consumer.EventPayload) {
	if len(e.Context) == 0 {
		return
	}
	cbytes, merr := json.Marshal(e.Context)
	if merr != nil {
		slog.Warn("marshal event context for upgrade",
			"session_id", e.SessionID,
			"event_type", logcap.EventType(e.EventType),
			"err", logcap.Err(merr),
		)
		return
	}
	if uerr := sp.w.UpgradeSessionContext(ctx, e.SessionID, cbytes); uerr != nil {
		slog.Warn("upgrade session context failed",
			"session_id", e.SessionID,
			"event_type", logcap.EventType(e.EventType),
			"err", logcap.Err(uerr),
		)
	}
}

// sessionLookup is the result of sessionLookupState. "missing" distinguishes
// "unknown session_id" from "known but closed" so HandleSessionEnd can emit
// a WARN + dropped-events counter increment for the former while treating
// the latter as an idempotent no-op. Without it an orphan session_end
// would be dropped via a silent FK-violation + NATS Nak loop; the
// three-way result surfaces it cleanly.
type sessionLookup int

const (
	sessionLookupMissing sessionLookup = iota
	sessionLookupClosed
	sessionLookupOpen
)

// sessionLookupState reads the session row's state. Only "no such row"
// is reported as missing; any other database error is returned so the
// caller NAKs and the event is redelivered within the retry budget,
// rather than mistaking an outage for an orphan.
func (sp *SessionProcessor) sessionLookupState(ctx context.Context, sessionID string) (sessionLookup, error) {
	var state string
	err := sp.db.Reader().QueryRowContext(ctx,
		"SELECT state FROM sessions WHERE session_id = $1", sessionID,
	).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return sessionLookupMissing, nil
	}
	if err != nil {
		return sessionLookupMissing, err
	}
	if state == "closed" {
		return sessionLookupClosed, nil
	}
	return sessionLookupOpen, nil
}

// HandleSessionStart upserts the agent and creates (or revives) a session.
//
// session_start events are the attach path. The ingestion API
// has already revived the row synchronously (flipping state back to
// active and recording a session_attachments row) so by the time this
// runs the row is state=active and UpsertSession's ON CONFLICT branch
// only has to refresh last_seen_at and the optional identity fields.
// Skipping session_start here (as an earlier design did) would undo the
// attachment because the response envelope has already been sent to
// the sensor.
//
// Terminal policy: heartbeat, post_call, tool_call, pre_call, and
// directive_result run through handleSessionGuard, which revives
// stale/lost sessions on the fly, skips only closed ones, and lazily
// creates the row when it doesn't exist.
// session_end does its own lookup (a closed session's session_end is a
// no-op; a stale or lost session_end goes straight to closed via
// SettleSessionEnd rather than flickering through active). The
// lazy-create path deliberately excludes session_end -- a teardown
// signal for a session we never saw should not retroactively manifest
// a closed row.
//
// The runtime context dict from e.Context is marshaled to JSON and
// passed to UpsertSession, which writes it once into sessions.context
// (JSONB) on insert. The ON CONFLICT branch deliberately does NOT
// touch context so reconnects from the same session_id can't
// overwrite the initial collection.
func (sp *SessionProcessor) HandleSessionStart(ctx context.Context, e consumer.EventPayload) error {
	identity := identityFromEvent(e)
	if err := sp.w.UpsertAgent(ctx, identity); err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	var contextJSON []byte
	if len(e.Context) > 0 {
		marshaled, mErr := json.Marshal(e.Context)
		if mErr != nil {
			slog.Warn("marshal session context",
				"session_id", e.SessionID,
				"err", logcap.Err(mErr),
			)
		} else {
			contextJSON = marshaled
		}
	}

	// Forward-reference soft-link. When this event is a
	// sub-agent session_start whose parent_session_id is not yet in
	// the DB, INSERT a parent-stub row first so the child's UpsertSession
	// satisfies the new parent_session_id FK. The stub belongs to no
	// agent. The real parent's later session_start (if it ever arrives)
	// claims it through UpsertSession, which fills its identity, upgrades
	// its "unknown" sentinels and counts it toward the parent's agent; a
	// parent whose start never arrives is claimed by its first other
	// event (handleSessionGuard, or HandleSessionEnd for its end). Stub
	// creation failure is
	// logged-but-non-fatal: the child
	// INSERT will then FK-violate, the worker NAKs, NATS redelivers,
	// and the stub path retries on the redelivery — better than
	// failing the wider session_start path on a transient stub-INSERT
	// hiccup. ParentSessionID is empty on root sessions and direct-SDK
	// sessions, so the guard short-circuits for the overwhelming
	// majority of session_start events.
	if e.ParentSessionID != "" {
		exists, lErr := sp.w.SessionExists(ctx, e.ParentSessionID)
		if lErr != nil {
			slog.Warn("parent session lookup failed",
				"session_id", e.SessionID,
				"parent_session_id", logcap.ID(e.ParentSessionID),
				"err", logcap.Err(lErr),
			)
		} else if !exists {
			startedAt, tErr := time.Parse(time.RFC3339, e.Timestamp)
			if tErr != nil {
				startedAt = time.Now().UTC()
			}
			if _, sErr := sp.w.UpsertParentStub(
				ctx, e.ParentSessionID, startedAt,
			); sErr != nil {
				slog.Warn("upsert parent stub failed",
					"session_id", e.SessionID,
					"parent_session_id", logcap.ID(e.ParentSessionID),
					"err", logcap.Err(sErr),
				)
			}
		}
	}

	// The row keeps the lowest stream sequence of the start's copies:
	// with two copies of one start in flight at once (neither stored,
	// so Process let both through), the later one upserts with the
	// earlier one's sequence, or lowers the row back to it.
	startSeq, replacedSeq, err := sp.w.ClaimStartSeq(ctx, e.ID, e.StreamSeq)
	if err != nil {
		return fmt.Errorf("session start: %w", err)
	}

	// attributed is true when this start inserted the row or claimed a
	// parent stub that a sub-agent's session_start wrote first, so the
	// session counts toward the agent once whichever of the two the
	// worker processed first; a redelivered or re-attaching start of a
	// row the agent already owns reports false.
	attributed, err := sp.w.UpsertSession(
		ctx, e.SessionID, e.Flavor, e.AgentType,
		e.Host, e.Framework, e.Model, "active",
		e.AgentID, e.ClientType, e.AgentName,
		contextJSON,
		e.TokenID, e.TokenName,
		e.ParentSessionID, e.AgentRole,
		e.CapturePrompts,
		startSeq,
		eventTime(e),
	)
	if err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	if replacedSeq > 0 {
		if err := sp.w.LowerStartSeq(ctx, e.SessionID, replacedSeq, startSeq); err != nil {
			return fmt.Errorf("session start: %w", err)
		}
	}
	if attributed {
		if bErr := sp.w.BumpAgentSessionCount(ctx, e.AgentID); bErr != nil {
			// Non-fatal -- see ReviveOrCreateSession rationale.
			slog.Warn("bump agent session count failed (session_start)",
				"session_id", e.SessionID,
				"agent_id", logcap.ID(e.AgentID),
				"err", logcap.Err(bErr),
			)
		}
	}
	return nil
}

// HandleHeartbeat updates last_seen_at on the session.
func (sp *SessionProcessor) HandleHeartbeat(ctx context.Context, e consumer.EventPayload) error {
	skip, err := sp.handleSessionGuard(ctx, e)
	if err != nil {
		return err
	}
	if skip {
		return nil
	}
	if err := sp.w.UpdateLastSeen(ctx, e.SessionID); err != nil {
		return err
	}
	sp.bumpParentIfPresent(ctx, e)
	return nil
}

// bumpParentIfPresent propagates a child event's freshness to its
// parent session. No-op when the event has no parent or when the
// parent is closed (BumpParentLastSeen filters terminal rows). On
// stale/lost → active revival, bumps
// metrics.IncrSessionRevived(metrics.RevivalTriggerChildEvent) so
// operators can chart the rate of parent-via-child revivals
// separately from any other revival path.
//
// Best-effort: a failed parent-bump is logged but never fails the
// child handler. The child event still lands in events; the parent's
// freshness is the optimistic side effect, not the load-bearing
// operation.
func (sp *SessionProcessor) bumpParentIfPresent(ctx context.Context, e consumer.EventPayload) {
	if e.ParentSessionID == "" {
		return
	}
	revived, err := sp.w.BumpParentLastSeen(ctx, e.ParentSessionID)
	if err != nil {
		slog.Warn("bump parent last_seen failed",
			"child_session_id", e.SessionID,
			"parent_session_id", logcap.ID(e.ParentSessionID),
			"event_type", logcap.EventType(e.EventType),
			"err", logcap.Err(err),
		)
		return
	}
	if revived {
		metrics.IncrSessionRevived(metrics.RevivalTriggerChildEvent)
		slog.Info("revived parent on child event",
			"child_session_id", e.SessionID,
			"parent_session_id", logcap.ID(e.ParentSessionID),
			"event_type", logcap.EventType(e.EventType),
		)
	}
}

// HandlePostCall updates token usage, last_seen_at, and the session's
// model field. The model column on sessions is not populated at
// session_start (the sensor doesn't know it yet); it is updated here
// from each post_call event so the API can return a non-null model
// for sessions that have made LLM calls. The call's framework fills a
// session whose session_start carried none (a framework the sensor
// detected after init()). Failures in the model and framework update
// are logged but do not abort processing -- the token update is
// load-bearing.
func (sp *SessionProcessor) HandlePostCall(ctx context.Context, e consumer.EventPayload) error {
	skip, err := sp.handleSessionGuard(ctx, e)
	if err != nil {
		// consumer.ErrRetryLater: a late call of an assembled session
		// waits for its re-attaching session_start.
		return err
	}
	if skip {
		return sp.addTokensBeforeEnd(ctx, e)
	}
	if err := sp.w.UpdateSessionFromCall(ctx, e.SessionID, e.Model, e.Framework); err != nil {
		slog.Warn("update session model and framework failed", "session_id", e.SessionID, "err", logcap.Err(err))
	}
	delta := 0
	if e.TokensTotal != nil {
		delta = *e.TokensTotal
	}
	if delta > 0 {
		if err := sp.w.UpdateTokensUsed(ctx, e.SessionID, delta); err != nil {
			return fmt.Errorf("post call: %w", err)
		}
		// Agent-level rollup. Non-fatal on error so a
		// transient UPDATE failure does not fail the whole event
		// -- the session-level tokens_used is authoritative, the
		// agent-level total_tokens is a dashboard convenience.
		if e.AgentID != "" {
			if aErr := sp.w.IncrementAgentTokens(ctx, e.AgentID, int64(delta)); aErr != nil {
				slog.Warn("increment agent tokens failed",
					"session_id", e.SessionID,
					"agent_id", logcap.ID(e.AgentID),
					"err", logcap.Err(aErr),
				)
			}
		}
	} else {
		if err := sp.w.UpdateLastSeen(ctx, e.SessionID); err != nil {
			return fmt.Errorf("post call: %w", err)
		}
	}
	sp.bumpParentIfPresent(ctx, e)
	return nil
}

// addTokensBeforeEnd handles a call event that reaches a closed
// session. The guard skips its session side effects, but a call
// published before the session_end still belongs in the session's and
// the agent's token totals (its event row is stored either way); only
// the order the two reached the worker differs (a redelivered call, or a
// client that published them out of order). A call
// published after the end is left out, as before.
func (sp *SessionProcessor) addTokensBeforeEnd(ctx context.Context, e consumer.EventPayload) error {
	if e.TokensTotal == nil || *e.TokensTotal <= 0 {
		return nil
	}
	delta := *e.TokensTotal
	added, err := sp.w.AddTokensBeforeEnd(ctx, e.SessionID, e.StreamSeq, delta)
	if err != nil {
		return fmt.Errorf("post call on closed session: %w", err)
	}
	if !added {
		return nil
	}
	slog.Info("added tokens of a call published before its session ended",
		"session_id", e.SessionID,
		"event_type", logcap.EventType(e.EventType),
		"tokens", delta,
	)
	if e.AgentID != "" {
		if aErr := sp.w.IncrementAgentTokens(ctx, e.AgentID, int64(delta)); aErr != nil {
			slog.Warn("increment agent tokens failed",
				"session_id", e.SessionID,
				"agent_id", logcap.ID(e.AgentID),
				"err", logcap.Err(aErr),
			)
		}
	}
	return nil
}

// HandleMCPServerAttached UPSERTs an MCP server fingerprint into
// “sessions.context.mcp_servers“. Routed
// from Process() alongside HandlePostCall (which advances
// last_seen_at) so the per-server dict lands and the dashboard
// SessionDrawer panel reflects it within ~2-3 s of attach via
// the existing fleet WebSocket re-fetch path.
//
// Maps the wire payload's “server_name“/“server_url_canonical“
// to the existing context dict's “name“/“server_url“ keys so
// the stored shape stays exactly what session_start writes
// (no schema bump). Idempotent at the SQL layer via
// AppendMCPServerToContext's (name, server_url) tuple dedup.
//
// Logs and continues on marshalling / DB failure — a malformed
// payload from a third-party emitter (validation already gates
// these at ingestion per Rule 36, but defensive logging keeps
// the worker resilient) must not block other event processing.
func (sp *SessionProcessor) HandleMCPServerAttached(
	ctx context.Context, e consumer.EventPayload,
) error {
	// Build the per-server dict matching the existing context shape.
	// Field omissions: AttachedAt (audit-only), Fingerprint (dedup-
	// only — the (canonical_url, name) tuple uniquely determines
	// it). The dashboard SessionDrawer reads this dict's name /
	// transport / protocol_version / version / capabilities /
	// instructions / server_url fields directly.
	dict := map[string]any{
		"name":         e.ServerName,
		"transport":    nilIfEmpty(e.Transport),
		"version":      nilIfEmpty(e.Version),
		"instructions": nilIfEmpty(e.Instructions),
		"server_url":   e.ServerURLCanonical,
	}
	if len(e.ProtocolVersion) > 0 {
		// Preserve source-type fidelity (str | int) by passing the
		// raw JSON bytes through — json.Marshal on map[string]any
		// will serialise json.RawMessage verbatim.
		dict["protocol_version"] = e.ProtocolVersion
	} else {
		dict["protocol_version"] = ""
	}
	if len(e.Capabilities) > 0 {
		dict["capabilities"] = e.Capabilities
	} else {
		dict["capabilities"] = map[string]any{}
	}

	dictBytes, err := json.Marshal(dict)
	if err != nil {
		slog.Warn("mcp_server_attached marshal dict",
			"session_id", e.SessionID, "err", logcap.Err(err))
		return nil
	}
	if err := sp.w.AppendMCPServerToContext(
		ctx, e.SessionID, e.ServerName, e.ServerURLCanonical, dictBytes,
	); err != nil {
		slog.Warn("mcp_server_attached append failed",
			"session_id", e.SessionID,
			"server_name", logcap.Name(e.ServerName),
			"err", logcap.Err(err),
		)
	}
	return nil
}

// nilIfEmpty returns nil when s is the empty string, else s.
// Used to round-trip optional MCPServerFingerprint fields whose
// "absent" sentinel is "" on the wire but null in the dashboard's
// context dict (matches the existing shape's non-string fields'
// JSON null vs "" distinction).
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// HandleSessionEnd closes the session and reports whether it did.
// Unlike the other handlers, session_end deliberately bypasses
// handleSessionGuard: closing a stale or lost session should transition
// it directly to closed, not flicker through active, and a teardown
// signal for a session the server never saw must not lazy-create a
// closed row.
//
// The end is applied in one guarded statement (SettleSessionEnd): an
// open row whose current run began before the end was published is
// closed with the end's sequence; a row that is already closed keeps
// its close and takes a greater closed_seq, so a session_start queued
// between a run's end and the next run's end cannot revive a session
// whose later run has also ended, while an end at or below the stored
// closed_seq is a duplicate that costs no write; an end published
// before the row's current run began matches nothing and is recorded as
// an event without closing anything (superseded_session_end). Unknown
// sequences (zero) stand the ordering rule down.
//
// The row can be missing because the session_end reached the worker
// before its session_start (a client published them out of order, or
// the start is being redelivered). A missing row therefore asks the
// consumer for a delayed redelivery (consumer.ErrRetryLater) instead of
// holding the lane; only on the final delivery is it an orphan session_end:
// WARN, counter, and ErrEventDropped, which Process turns into a clean
// ACK with no event row. Letting the insert run would fail the sessions
// foreign key and spend the retry budget on an opaque "process error".
//
// Once the end has settled on an existing row, a row that no agent owns
// yet (a parent stub whose own session_start never reached the worker,
// such as a root start the client gave up on) is claimed for the agent
// the end names and counted once (claimOwnerlessRow). Like the end
// itself, the claim never creates a row.
func (sp *SessionProcessor) HandleSessionEnd(ctx context.Context, e consumer.EventPayload) (closed bool, err error) {
	closed, err = sp.applySessionEnd(ctx, e)
	if err == nil {
		// A nil error means the row exists: the end closed it, found
		// it already closed, or found it opened by a later start. The
		// claim reads the row after the settle, so it also sees a stub
		// a child's session_start wrote while this end was settling.
		sp.claimOwnerlessRow(ctx, e)
	}
	return closed, err
}

// applySessionEnd settles a session_end on its row (see HandleSessionEnd).
func (sp *SessionProcessor) applySessionEnd(ctx context.Context, e consumer.EventPayload) (closed bool, err error) {
	// At most two attempts: a statement that matched nothing because
	// the row did not exist yet is repeated once the read finds the row
	// (another goroutine lazily created, upserted or even closed it in
	// between), so a second miss means the row really predates this end
	// or is closed by an end at or past it.
	for attempt := 0; ; attempt++ {
		applied, closedNow, err := sp.settleRow(ctx, e.SessionID, e.StreamSeq, eventTime(e))
		if err != nil {
			return false, err
		}
		if applied {
			if closedNow {
				return true, nil
			}
			// Duplicate session_end on a closed row. Idempotent by
			// design; log and skip (a later end has left its
			// sequence behind).
			metrics.IncrDropped(metrics.ReasonClosedSessionSkip)
			slog.Warn("skipping event for closed session",
				"session_id", e.SessionID,
				"event_type", "session_end",
			)
			return false, nil
		}
		state, err := sp.lookupState(ctx, e.SessionID)
		if err != nil {
			return false, fmt.Errorf("session end: look up %s: %w", e.SessionID, err)
		}
		if state == sessionLookupMissing {
			if !e.FinalDelivery {
				return false, consumer.ErrRetryLater
			}
			// We deliberately do NOT lazy-create on session_end -- a
			// teardown signal for a session we never saw should not
			// retroactively manifest a closed row. Log + counter + ACK
			// without an event row (ErrEventDropped).
			metrics.IncrDropped(metrics.ReasonOrphanSessionEnd)
			slog.Warn("dropped orphan session_end",
				"session_id", e.SessionID,
				"reason", string(metrics.ReasonOrphanSessionEnd),
			)
			return false, ErrEventDropped
		}
		if attempt == 0 {
			continue
		}
		if state == sessionLookupClosed {
			// Already closed by this end or a later one: a duplicate,
			// idempotent by design, that cost no write. Log and skip.
			metrics.IncrDropped(metrics.ReasonClosedSessionSkip)
			slog.Warn("skipping event for closed session",
				"session_id", e.SessionID,
				"event_type", "session_end",
			)
			return false, nil
		}
		metrics.IncrDropped(metrics.ReasonSupersededSessionEnd)
		slog.Warn("session_end predates the session's current run; recorded without closing",
			"session_id", e.SessionID,
			"reason", string(metrics.ReasonSupersededSessionEnd),
			"end_seq", e.StreamSeq,
		)
		return false, nil
	}
}

// StartReconciler runs a background loop that ticks every `interval`
// to mark stale/lost sessions and to reap orphaned `lost` rows after
// `orphanTimeout`. The interval comes from
// FLIGHTDECK_RECONCILER_INTERVAL_SECS (60 s by default; the dev stack
// lowers it so the integration tests that wait for a tick stay short).
// The reaper closes sessions whose owning sensor / plugin never sent
// session_end (process crash, kill -9, missed lifecycle hook) and
// stamps close_reason="orphan_timeout" via a synthetic session_end so
// the dashboard's close-reason facet surfaces the reconciler's verdict
// alongside happy-path shutdowns.
func (sp *SessionProcessor) StartReconciler(
	ctx context.Context,
	interval time.Duration,
	orphanTimeout time.Duration,
) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := sp.w.ReconcileStaleSessions(ctx); err != nil {
				slog.Error("reconciler error", "err", err)
			}
			reaped, err := sp.w.ReapOrphanedLostSessions(ctx, orphanTimeout)
			if err != nil {
				slog.Error("orphan reaper error", "err", err)
				continue
			}
			if reaped > 0 {
				metrics.IncrSessionClosedN(metrics.CloseReasonOrphanTimeout, uint64(reaped))
				slog.Info("reaped orphaned sessions",
					"count", reaped,
					"close_reason", string(metrics.CloseReasonOrphanTimeout),
					"timeout", orphanTimeout.String(),
				)
			}
		}
	}
}
