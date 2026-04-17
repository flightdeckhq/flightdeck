// Package writer provides direct pgx operations for upserting fleet state.
// No ORM -- all queries are parameterized SQL via pgx.
package writer

import (
	"context"
	"encoding/json"
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
//
// The optional contextJSON argument carries the runtime context dict
// collected by the sensor at init() time (see sensor/core/context.py).
// It is stored in sessions.context (JSONB) and is set ONCE on insert
// -- the ON CONFLICT branch deliberately does NOT touch the context
// column so reconnects from the same session_id can't overwrite the
// initial collection. Pass nil for events that don't carry context
// (only session_start does).
func (w *Writer) UpsertSession(
	ctx context.Context,
	sessionID, flavor, agentType, host, framework, model, state string,
	contextJSON []byte,
	tokenID, tokenName string,
) error {
	if contextJSON == nil {
		contextJSON = []byte("{}")
	}
	// tokenID is a nullable UUID FK; the NULLIF('') dance keeps the
	// insert path generic for sessions created before Phase 5 or for
	// any future code path that doesn't resolve a token (there are
	// none today, but a defensive NULL is cheaper than a panic). The
	// ON CONFLICT branch deliberately does NOT overwrite token_id /
	// token_name: a session belongs to whichever token opened it,
	// and subsequent session_start attachments (D094 re-attach)
	// intentionally keep the original attribution.
	_, err := w.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, flavor, agent_type, host, framework, model, state,
			started_at, last_seen_at, context, token_id, token_name
		)
		VALUES (
			$1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7,
			NOW(), NOW(), $8,
			NULLIF($9, '')::uuid, NULLIF($10, '')
		)
		ON CONFLICT (session_id) DO UPDATE
		SET state = EXCLUDED.state,
		    last_seen_at = NOW(),
		    host = COALESCE(EXCLUDED.host, sessions.host),
		    framework = COALESCE(EXCLUDED.framework, sessions.framework),
		    model = COALESCE(EXCLUDED.model, sessions.model)
		    -- context, token_id, token_name intentionally NOT updated on conflict
	`, sessionID, flavor, agentType, host, framework, model, state, contextJSON, tokenID, tokenName)
	if err != nil {
		return fmt.Errorf("upsert session %s: %w", sessionID, err)
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
	var eventID string
	err := w.pool.QueryRow(ctx, `
		INSERT INTO events (session_id, flavor, event_type, model, tokens_input, tokens_output, tokens_total, tokens_cache_read, tokens_cache_creation, latency_ms, tool_name, has_content, occurred_at, payload)
		VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		RETURNING id::text
	`, sessionID, flavor, eventType, model, tokensInput, tokensOutput, tokensTotal, cacheRead, cacheCreation, latencyMs, toolName, hasContent, occurredAt, payload).Scan(&eventID)
	if err != nil {
		return "", fmt.Errorf("insert event: %w", err)
	}
	return eventID, nil
}

// InsertEventContent inserts prompt capture content into event_content.
// Called only when event.HasContent is true.
func (w *Writer) InsertEventContent(ctx context.Context, eventID, sessionID string, content json.RawMessage) error {
	// Parse the content JSON to extract fields
	var c struct {
		Provider     string          `json:"provider"`
		Model        string          `json:"model"`
		SystemPrompt *string         `json:"system"`
		Messages     json.RawMessage `json:"messages"`
		Tools        json.RawMessage `json:"tools"`
		Response     json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(content, &c); err != nil {
		return fmt.Errorf("parse event content: %w", err)
	}
	_, err := w.pool.Exec(ctx, `
		INSERT INTO event_content (event_id, session_id, provider, model, system_prompt, messages, tools, response)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (event_id) DO NOTHING
	`, eventID, sessionID, c.Provider, c.Model, c.SystemPrompt, c.Messages, c.Tools, c.Response)
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
