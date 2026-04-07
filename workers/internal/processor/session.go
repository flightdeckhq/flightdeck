// Package processor contains event processing logic for the worker pipeline.
package processor

import (
	"context"
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

// HandleSessionStart upserts the agent and creates a new session.
func (sp *SessionProcessor) HandleSessionStart(ctx context.Context, e consumer.EventPayload) error {
	if sp.isTerminal(ctx, e.SessionID) {
		slog.Warn("skipping event for terminal session",
			"session_id", e.SessionID,
			"event_type", "session_start",
		)
		return nil
	}
	if err := sp.w.UpsertAgent(ctx, e.Flavor, e.AgentType); err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	if err := sp.w.UpsertSession(
		ctx, e.SessionID, e.Flavor, e.AgentType,
		e.Host, e.Framework, e.Model, "active",
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

// HandlePostCall updates token usage and last_seen_at.
func (sp *SessionProcessor) HandlePostCall(ctx context.Context, e consumer.EventPayload) error {
	if sp.isTerminal(ctx, e.SessionID) {
		slog.Warn("skipping event for terminal session",
			"session_id", e.SessionID,
			"event_type", "post_call",
		)
		return nil
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
