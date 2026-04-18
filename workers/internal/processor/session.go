// Package processor contains event processing logic for the worker pipeline.
package processor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5/pgxpool"
)

const reconcilerInterval = 60 * time.Second

// SessionProcessor manages the session state machine in Postgres.
type SessionProcessor struct {
	w    *writer.Writer
	pool *pgxpool.Pool
}

// NewSessionProcessor creates a SessionProcessor.
func NewSessionProcessor(w *writer.Writer, pool *pgxpool.Pool) *SessionProcessor {
	return &SessionProcessor{w: w, pool: pool}
}

// handleTerminalGuard enforces the D105 revive-or-skip policy before a
// non-session_start handler applies its side effects.
//
//   - closed   -> warn + skip (caller returns nil). The user explicitly
//     ended the session; reviving would contradict an explicit exit.
//   - stale/lost -> warn + revive to active + advance last_seen_at, then
//     the caller proceeds with normal processing. This is the D105
//     extension of D094's session_start attach-on-terminal semantics to
//     every event type.
//   - active / idle / unknown / non-existent -> no-op, caller proceeds.
//
// Returns true if the caller should skip further processing (closed
// sessions only). On a DB error reading state, fails open (returns
// false) rather than blocking the event.
//
// HandleSessionEnd uses isClosed instead -- closing a stale/lost session
// should transition it directly to closed via CloseSession, not flicker
// through active.
func (sp *SessionProcessor) handleTerminalGuard(ctx context.Context, sessionID, eventType string) (skip bool) {
	var state string
	err := sp.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid", sessionID,
	).Scan(&state)
	if err != nil {
		// Session doesn't exist (new) or DB error -- fail open.
		return false
	}
	switch state {
	case "closed":
		slog.Warn("skipping event for closed session",
			"session_id", sessionID,
			"event_type", eventType,
		)
		return true
	case "stale", "lost":
		slog.Warn("reviving stale/lost session on event (D105)",
			"session_id", sessionID,
			"event_type", eventType,
			"prior_state", state,
		)
		if _, rerr := sp.w.ReviveIfRevivable(ctx, sessionID); rerr != nil {
			// Revival failure is non-fatal: log and let the event's
			// normal side effects run. UpdateLastSeen / UpdateTokensUsed
			// still execute the same UPDATE against state-agnostic
			// WHERE clauses, so last_seen_at advances even if the
			// state flip missed. The worst case is the reconciler
			// re-observes state=stale|lost with a fresh last_seen_at
			// on its next tick and leaves it alone.
			slog.Error("revive session failed",
				"session_id", sessionID,
				"event_type", eventType,
				"err", rerr,
			)
		}
		return false
	default:
		return false
	}
}

// isClosed reports whether the session is already in state=closed.
// Used by HandleSessionEnd to skip redundant CloseSession calls. Fails
// open (returns false) on a DB error or non-existent session so the
// close path still runs.
func (sp *SessionProcessor) isClosed(ctx context.Context, sessionID string) bool {
	var state string
	err := sp.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid", sessionID,
	).Scan(&state)
	if err != nil {
		return false
	}
	return state == "closed"
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
// pre_call, and directive_result now run through handleTerminalGuard,
// which revives stale/lost sessions on the fly and skips only closed
// ones. session_end uses isClosed (a closed session's session_end is a
// no-op; a stale or lost session_end goes straight to closed via
// CloseSession rather than flickering through active).
//
// The runtime context dict from e.Context is marshaled to JSON and
// passed to UpsertSession, which writes it once into sessions.context
// (JSONB) on insert. The ON CONFLICT branch deliberately does NOT
// touch context so reconnects from the same session_id can't
// overwrite the initial collection.
func (sp *SessionProcessor) HandleSessionStart(ctx context.Context, e consumer.EventPayload) error {
	if err := sp.w.UpsertAgent(ctx, e.Flavor, e.AgentType); err != nil {
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
	if err := sp.w.UpsertSession(
		ctx, e.SessionID, e.Flavor, e.AgentType,
		e.Host, e.Framework, e.Model, "active",
		contextJSON,
		e.TokenID, e.TokenName,
	); err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	return nil
}

// HandleHeartbeat updates last_seen_at on the session.
func (sp *SessionProcessor) HandleHeartbeat(ctx context.Context, e consumer.EventPayload) error {
	if sp.handleTerminalGuard(ctx, e.SessionID, "heartbeat") {
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
	if sp.handleTerminalGuard(ctx, e.SessionID, e.EventType) {
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
// CloseSession, not flicker through active. Only an already-closed
// session is a no-op.
func (sp *SessionProcessor) HandleSessionEnd(ctx context.Context, e consumer.EventPayload) error {
	if sp.isClosed(ctx, e.SessionID) {
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
