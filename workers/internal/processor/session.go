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

// isTerminal checks if a session is in a terminal state (closed or lost).
// Returns false if the session does not exist (new session -- allow through).
// On Postgres error, logs warning and returns false (fail open).
func (sp *SessionProcessor) isTerminal(ctx context.Context, sessionID string) bool {
	var state string
	err := sp.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid", sessionID,
	).Scan(&state)
	if err != nil {
		// Session doesn't exist (new) or DB error -- fail open
		return false
	}
	return state == "closed" || state == "lost"
}

// HandleSessionStart upserts the agent and creates (or revives) a session.
//
// D094: session_start events are the only events allowed to land on a
// terminal (closed/lost) session row. The ingestion API has already
// revived the row synchronously -- flipping state back to active and
// stamping last_attached_at -- so by the time this runs the row is
// state=active and UpsertSession's ON CONFLICT branch only has to
// refresh last_seen_at and the optional identity fields. Skipping
// session_start here (the old KI13 behaviour) would undo the
// attachment because the response envelope has already been sent to
// the sensor. Heartbeat / post_call / session_end still honour
// isTerminal below -- attachment is a session_start-only transition.
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
	); err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	return nil
}

// HandleHeartbeat updates last_seen_at on the session.
func (sp *SessionProcessor) HandleHeartbeat(ctx context.Context, e consumer.EventPayload) error {
	if sp.isTerminal(ctx, e.SessionID) {
		slog.Warn("skipping event for terminal session",
			"session_id", e.SessionID,
			"event_type", "heartbeat",
		)
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
	if sp.isTerminal(ctx, e.SessionID) {
		slog.Warn("skipping event for terminal session",
			"session_id", e.SessionID,
			"event_type", "post_call",
		)
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

// HandleSessionEnd closes the session.
func (sp *SessionProcessor) HandleSessionEnd(ctx context.Context, e consumer.EventPayload) error {
	if sp.isTerminal(ctx, e.SessionID) {
		slog.Warn("skipping event for terminal session",
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
