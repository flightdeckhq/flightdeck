// Package writer provides direct pgx operations for upserting fleet state.
// No ORM -- all queries are parameterized SQL via pgx.
package writer

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	staleThreshold = "2 minutes"
	lostThreshold  = "10 minutes"
)

// Writer performs all Postgres writes for the worker pipeline.
type Writer struct {
	pool *pgxpool.Pool
}

// New creates a Writer.
func New(pool *pgxpool.Pool) *Writer {
	return &Writer{pool: pool}
}

// UpsertAgent inserts a new agent or updates last_seen and increments session_count.
func (w *Writer) UpsertAgent(ctx context.Context, flavor, agentType string) error {
	_, err := w.pool.Exec(ctx, `
		INSERT INTO agents (flavor, agent_type, first_seen, last_seen, session_count)
		VALUES ($1, $2, NOW(), NOW(), 1)
		ON CONFLICT (flavor) DO UPDATE
		SET last_seen = NOW(),
		    session_count = agents.session_count + 1,
		    agent_type = EXCLUDED.agent_type
	`, flavor, agentType)
	if err != nil {
		return fmt.Errorf("upsert agent %s: %w", flavor, err)
	}
	return nil
}

// UpsertSession inserts a new session or updates its state fields.
func (w *Writer) UpsertSession(
	ctx context.Context,
	sessionID, flavor, agentType, host, framework, model, state string,
) error {
	_, err := w.pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, host, framework, model, state, started_at, last_seen_at)
		VALUES ($1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, NOW(), NOW())
		ON CONFLICT (session_id) DO UPDATE
		SET state = EXCLUDED.state,
		    last_seen_at = NOW(),
		    host = COALESCE(EXCLUDED.host, sessions.host),
		    framework = COALESCE(EXCLUDED.framework, sessions.framework),
		    model = COALESCE(EXCLUDED.model, sessions.model)
	`, sessionID, flavor, agentType, host, framework, model, state)
	if err != nil {
		return fmt.Errorf("upsert session %s: %w", sessionID, err)
	}
	return nil
}

// InsertEvent inserts a new event record (metadata only).
func (w *Writer) InsertEvent(
	ctx context.Context,
	sessionID, flavor, eventType, model string,
	tokensInput, tokensOutput, tokensTotal *int,
	latencyMs *int,
	toolName *string,
	hasContent bool,
	occurredAt time.Time,
) error {
	_, err := w.pool.Exec(ctx, `
		INSERT INTO events (session_id, flavor, event_type, model, tokens_input, tokens_output, tokens_total, latency_ms, tool_name, has_content, occurred_at)
		VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11)
	`, sessionID, flavor, eventType, model, tokensInput, tokensOutput, tokensTotal, latencyMs, toolName, hasContent, occurredAt)
	if err != nil {
		return fmt.Errorf("insert event: %w", err)
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
