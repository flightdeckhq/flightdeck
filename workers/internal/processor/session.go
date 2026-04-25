// Package processor contains event processing logic for the worker pipeline.
package processor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const reconcilerInterval = 60 * time.Second

// identityFromEvent extracts the D115 agent identity fields from an
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

// SessionProcessor manages the session state machine in Postgres.
type SessionProcessor struct {
	w    *writer.Writer
	pool *pgxpool.Pool
}

// NewSessionProcessor creates a SessionProcessor.
func NewSessionProcessor(w *writer.Writer, pool *pgxpool.Pool) *SessionProcessor {
	return &SessionProcessor{w: w, pool: pool}
}

// handleSessionGuard enforces the revive-or-create-or-skip policy
// before a non-session_start handler applies its side effects.
//
//   - closed -> warn + skip (caller returns nil). The user explicitly
//     ended the session; reviving would contradict an explicit exit.
//   - stale/lost -> warn + revive to active + advance last_seen_at
//     (D105). Caller proceeds with normal processing.
//   - not-found (pgx.ErrNoRows) -> D106 lazy-create a new row from
//     the event's best-effort identity fields, then caller proceeds.
//     Without this the caller's UPDATE queries no-op silently and
//     the subsequent InsertEvent FK-violates, so the event is
//     dropped even though the session is legitimately active.
//   - active / idle / unknown-DB-error -> no-op, caller proceeds.
//
// Returns true if the caller should skip further processing (closed
// sessions only). All other states / failure modes fall open so the
// event's downstream UPDATE + InsertEvent have a chance to succeed.
//
// HandleSessionEnd uses isClosed instead -- closing a stale/lost
// session should transition directly via CloseSession, and D106 does
// not lazy-create on session_end (a teardown signal for a session we
// never saw should not retroactively manifest a closed row).
func (sp *SessionProcessor) handleSessionGuard(ctx context.Context, e consumer.EventPayload) (skip bool) {
	var state string
	err := sp.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid", e.SessionID,
	).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		// D106: session never seen. Lazy-create from event fields.
		occurredAt, tsErr := time.Parse(time.RFC3339, e.Timestamp)
		if tsErr != nil {
			occurredAt = time.Now().UTC()
		}
		created, cErr := sp.w.ReviveOrCreateSession(
			ctx, e.SessionID, e.Flavor, e.AgentType,
			e.Host, e.Framework, e.Model,
			identityFromEvent(e), occurredAt,
		)
		if cErr != nil {
			// Lazy-create failed. Log and fail open -- InsertEvent
			// will then FK-violate and the consumer will Nak+retry,
			// which is the pre-D106 behaviour for this failure mode.
			slog.Error("lazy-create session failed (D106)",
				"session_id", e.SessionID,
				"event_type", e.EventType,
				"err", cErr,
			)
			return false
		}
		if created {
			slog.Info("lazy-created session on event (D106)",
				"session_id", e.SessionID,
				"event_type", e.EventType,
				"flavor", e.Flavor,
			)
		}
		sp.upgradeContextIfPresent(ctx, e)
		return false
	}
	if err != nil {
		// Non-ErrNoRows DB error -- fail open. Matches the prior
		// handleTerminalGuard posture. Skip the context upgrade: we
		// have no confirmation the row exists, so the UPDATE would
		// no-op silently, and a transient DB blip should not trigger
		// extra write pressure.
		return false
	}
	switch state {
	case "closed":
		metrics.IncrDropped(metrics.ReasonClosedSessionSkip)
		slog.Warn("skipping event for closed session",
			"session_id", e.SessionID,
			"event_type", e.EventType,
		)
		return true
	case "stale", "lost":
		slog.Warn("reviving stale/lost session on event (D105)",
			"session_id", e.SessionID,
			"event_type", e.EventType,
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
				"event_type", e.EventType,
				"err", rerr,
			)
		}
		sp.upgradeContextIfPresent(ctx, e)
		return false
	default:
		sp.upgradeContextIfPresent(ctx, e)
		return false
	}
}

// upgradeContextIfPresent fills in sessions.context when the incoming
// event carries one. Called from every non-closed branch of
// handleSessionGuard so lazy-created rows (D106) and already-active
// rows whose session_start never landed both pick up context from the
// first event that actually reaches the worker.
//
// Scoped to the context column only. Flavor, agent_type, token_id,
// and token_name remain session_start-only writes to preserve D094
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
			"event_type", e.EventType,
			"err", merr,
		)
		return
	}
	if uerr := sp.w.UpgradeSessionContext(ctx, e.SessionID, cbytes); uerr != nil {
		slog.Warn("upgrade session context failed",
			"session_id", e.SessionID,
			"event_type", e.EventType,
			"err", uerr,
		)
	}
}

// sessionLookup is the result of sessionLookupState. "missing" distinguishes
// "unknown session_id" from "known but closed" so HandleSessionEnd can emit
// a WARN + dropped-events counter increment for the former while treating
// the latter as an idempotent no-op. Phase 4 D2: orphan session_end was
// previously dropped via a silent FK-violation + NATS Nak loop; this
// three-way result surfaces it cleanly.
type sessionLookup int

const (
	sessionLookupMissing sessionLookup = iota
	sessionLookupClosed
	sessionLookupOpen
)

// sessionLookupState reports whether the session row is missing, present
// and closed, or present and non-closed. Fails open on a DB error (returns
// Missing) so the close path still runs -- matching the pre-Phase-4
// isClosed-returns-false fallback.
func (sp *SessionProcessor) sessionLookupState(ctx context.Context, sessionID string) sessionLookup {
	var state string
	err := sp.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid", sessionID,
	).Scan(&state)
	if err != nil {
		// pgx surfaces "no rows" as pgx.ErrNoRows; any other error
		// (network, malformed UUID cast, etc.) also funnels here.
		// Matching substring on error text keeps the import surface
		// small -- pgx.ErrNoRows is the only sentinel we care about
		// distinguishing, and the rest collapse to "assume missing,
		// let the caller decide".
		if strings.Contains(err.Error(), "no rows in result set") {
			return sessionLookupMissing
		}
		return sessionLookupMissing
	}
	if state == "closed" {
		return sessionLookupClosed
	}
	return sessionLookupOpen
}

// HandleSessionStart upserts the agent and creates (or revives) a session.
//
// D094: session_start events are the attach path. The ingestion API
// has already revived the row synchronously (flipping state back to
// active and recording a session_attachments row) so by the time this
// runs the row is state=active and UpsertSession's ON CONFLICT branch
// only has to refresh last_seen_at and the optional identity fields.
// Skipping session_start here (the old KI13 behaviour) would undo the
// attachment because the response envelope has already been sent to
// the sensor.
//
// D105 generalised the terminal policy: heartbeat, post_call, tool_call,
// pre_call, and directive_result now run through handleSessionGuard,
// which revives stale/lost sessions on the fly, skips only closed ones,
// and (since D106) lazily creates the row when it doesn't exist.
// session_end uses isClosed (a closed session's session_end is a
// no-op; a stale or lost session_end goes straight to closed via
// CloseSession rather than flickering through active). D106's
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
				"err", mErr,
			)
		} else {
			contextJSON = marshaled
		}
	}
	created, err := sp.w.UpsertSession(
		ctx, e.SessionID, e.Flavor, e.AgentType,
		e.Host, e.Framework, e.Model, "active",
		e.AgentID, e.ClientType, e.AgentName,
		contextJSON,
		e.TokenID, e.TokenName,
	)
	if err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	if created {
		if bErr := sp.w.BumpAgentSessionCount(ctx, e.AgentID); bErr != nil {
			// Non-fatal -- see ReviveOrCreateSession rationale.
			slog.Warn("bump agent session count failed (session_start)",
				"session_id", e.SessionID,
				"agent_id", e.AgentID,
				"err", bErr,
			)
		}
	}
	return nil
}

// HandleHeartbeat updates last_seen_at on the session.
func (sp *SessionProcessor) HandleHeartbeat(ctx context.Context, e consumer.EventPayload) error {
	if sp.handleSessionGuard(ctx, e) {
		return nil
	}
	return sp.w.UpdateLastSeen(ctx, e.SessionID)
}

// HandlePostCall updates token usage, last_seen_at, and the session's
// model field. The model column on sessions is not populated at
// session_start (the sensor doesn't know it yet); it is updated here
// from each post_call event so the API can return a non-null model
// for sessions that have made LLM calls. Failures in the model update
// are logged but do not abort processing -- the token update is
// load-bearing.
func (sp *SessionProcessor) HandlePostCall(ctx context.Context, e consumer.EventPayload) error {
	if sp.handleSessionGuard(ctx, e) {
		return nil
	}
	if e.Model != "" {
		if err := sp.w.UpdateSessionModel(ctx, e.SessionID, e.Model); err != nil {
			slog.Warn("update session model failed", "session_id", e.SessionID, "err", err)
		}
	}
	delta := 0
	if e.TokensTotal != nil {
		delta = *e.TokensTotal
	}
	if delta > 0 {
		if err := sp.w.UpdateTokensUsed(ctx, e.SessionID, delta); err != nil {
			return fmt.Errorf("post call: %w", err)
		}
		// D115 agent-level rollup. Non-fatal on error so a
		// transient UPDATE failure does not fail the whole event
		// -- the session-level tokens_used is authoritative, the
		// agent-level total_tokens is a dashboard convenience.
		if e.AgentID != "" {
			if aErr := sp.w.IncrementAgentTokens(ctx, e.AgentID, int64(delta)); aErr != nil {
				slog.Warn("increment agent tokens failed",
					"session_id", e.SessionID,
					"agent_id", e.AgentID,
					"err", aErr,
				)
			}
		}
	} else {
		if err := sp.w.UpdateLastSeen(ctx, e.SessionID); err != nil {
			return fmt.Errorf("post call: %w", err)
		}
	}
	return nil
}

// HandleSessionEnd closes the session. Unlike the other handlers,
// session_end deliberately bypasses handleTerminalGuard -- closing a
// stale or lost session should transition it directly to closed via
// CloseSession, not flicker through active. Already-closed sessions are
// an idempotent no-op.
//
// Phase 4 D2: orphan session_end (session_end for an unknown
// session_id) is now handled explicitly. Pre-Phase-4 behaviour was a
// silent FK-violation at InsertEvent → NATS Nak → redelivery loop → DLQ,
// with an opaque "process error" log that didn't distinguish "orphan"
// from "real problem". The new path looks up the session state before
// CloseSession runs; a missing row yields a WARN log + dropped-events
// counter increment + nil return so the consumer ACKs cleanly (there is
// nothing to recover from redelivery).
func (sp *SessionProcessor) HandleSessionEnd(ctx context.Context, e consumer.EventPayload) error {
	switch sp.sessionLookupState(ctx, e.SessionID) {
	case sessionLookupMissing:
		// D106 deliberately does NOT lazy-create on session_end -- a
		// teardown signal for a session we never saw should not
		// retroactively manifest a closed row. Log + counter + ACK.
		metrics.IncrDropped(metrics.ReasonOrphanSessionEnd)
		slog.Warn("dropped orphan session_end",
			"session_id", e.SessionID,
			"reason", string(metrics.ReasonOrphanSessionEnd),
		)
		return nil
	case sessionLookupClosed:
		// Duplicate session_end. Idempotent by design; log and skip.
		metrics.IncrDropped(metrics.ReasonClosedSessionSkip)
		slog.Warn("skipping event for closed session",
			"session_id", e.SessionID,
			"event_type", "session_end",
		)
		return nil
	}
	return sp.w.CloseSession(ctx, e.SessionID)
}

// StartReconciler runs a background loop every 60s to mark stale/lost sessions.
func (sp *SessionProcessor) StartReconciler(ctx context.Context) {
	ticker := time.NewTicker(reconcilerInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := sp.w.ReconcileStaleSessions(ctx); err != nil {
				slog.Error("reconciler error", "err", err)
			}
		}
	}
}
