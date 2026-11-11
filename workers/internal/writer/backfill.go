package writer

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/billing"
	"github.com/flightdeckhq/flightdeck/workers/internal/modelid"
)

// modelBackfillBatchSize is the number of events one backfill
// transaction rewrites. Large enough that a table of millions of rows
// finishes in minutes, small enough that each transaction holds its row
// locks for well under a second and never delays the live write path.
const modelBackfillBatchSize = 1000

// modelBackfillPause separates consecutive batches. Each batch rewrites
// whole rows (payload included) and their index entries, so running
// batches back to back on a large table would compete with the live
// write path for I/O; a short pause leaves it room at the cost of a few
// seconds per hundred thousand rows.
const modelBackfillPause = 100 * time.Millisecond

// modelBackfillAttempts bounds how often a failing batch is retried
// before the run gives up until the next worker start. A failure is
// usually transient (a deadlock with another worker's batch, a dropped
// connection); a persistent one is not worth retrying forever.
const modelBackfillAttempts = 5

// modelBackfillRetryBase is the delay before the first retry of a
// failed batch; each further retry doubles it.
const modelBackfillRetryBase = time.Second

// backfillRow is one event the backfill rewrites, as read from the
// database and as computed from its raw model id.
type backfillRow struct {
	id         string
	occurredAt time.Time
	sessionID  string
	raw        string
	model      string
	provider   string
	billing    string
	scope      string
}

// RunModelBackfill rewrites, batch by batch, the events stored before
// the write path canonicalised model ids (ARCHITECTURE.md, Cost
// estimation, Model ids): each gets its raw id as model_requested, the
// canonical id as model, the provider derived from it, the default
// billing mode for its client when it is an LLM call, its
// provider_metadata.platform copied into platform, and the
// inference_scope a Bedrock region prefix implied. The sessions those
// events belong to get the canonical id in sessions.model when it
// still holds the raw one.
//
// On Postgres batches are claimed with FOR UPDATE SKIP LOCKED, so
// several workers share the work; on SQLite each batch is one write
// transaction on the single writer. A restart resumes where it
// stopped. It returns when no rows are left or ctx is done. A failed
// batch is retried with exponential backoff; one that keeps failing
// ends the run, which the next worker start repeats.
func (w *Writer) RunModelBackfill(ctx context.Context) {
	total := 0
	for {
		n, err := w.backfillBatchWithRetry(ctx)
		if err != nil {
			if ctx.Err() == nil {
				slog.Error("model id backfill failed; it resumes on the next start",
					"err", err, "rows_rewritten", total)
			}
			return
		}
		total += n
		if n == 0 || !sleepCtx(ctx, modelBackfillPause) {
			break
		}
	}
	if total > 0 {
		slog.Info("model id backfill finished", "rows_rewritten", total)
	}
}

// backfillBatchWithRetry runs one batch, retrying a failure up to
// modelBackfillAttempts times in all.
func (w *Writer) backfillBatchWithRetry(ctx context.Context) (int, error) {
	delay := modelBackfillRetryBase
	for attempt := 1; ; attempt++ {
		n, err := w.backfillModelBatch(ctx, modelBackfillBatchSize)
		if err == nil || attempt == modelBackfillAttempts || ctx.Err() != nil {
			return n, err
		}
		slog.Warn("model id backfill batch failed; retrying",
			"err", err, "attempt", attempt, "retry_in", delay)
		if !sleepCtx(ctx, delay) {
			return 0, ctx.Err()
		}
		delay *= 2
	}
}

// sleepCtx waits for d and reports whether it did, false when ctx was
// cancelled first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// backfillModelBatch rewrites up to limit events in one transaction and
// returns how many it rewrote.
func (w *Writer) backfillModelBatch(ctx context.Context, limit int) (int, error) {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin backfill batch: %w", err)
	}
	// A no-op once Commit has succeeded.
	defer func() { _ = tx.Rollback() }()

	batch, err := w.selectBackfillBatch(ctx, tx, limit)
	if err != nil {
		return 0, err
	}
	if len(batch) == 0 {
		return 0, nil
	}
	if w.db.Backend == storage.SQLite {
		err = backfillUpdateSQLite(ctx, tx, batch)
	} else {
		err = backfillUpdatePostgres(ctx, tx, batch)
	}
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit backfill batch: %w", err)
	}
	return len(batch), nil
}

// selectBackfillBatch reads the next batch of events to rewrite, on the
// transaction, with the rewritten values computed from each raw id.
func (w *Writer) selectBackfillBatch(ctx context.Context, tx *sql.Tx, limit int) ([]backfillRow, error) {
	rows, err := tx.QueryContext(ctx, w.q.backfillSelect, limit)
	if err != nil {
		return nil, fmt.Errorf("select backfill batch: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var batch []backfillRow
	for rows.Next() {
		var b backfillRow
		var eventType, clientType string
		if err := rows.Scan(&b.id, &b.occurredAt, &b.sessionID, &b.raw, &eventType, &clientType); err != nil {
			return nil, fmt.Errorf("read backfill batch: %w", err)
		}
		c := modelid.Canonicalize(b.raw)
		b.model, b.scope = c.Model, c.InferenceScope
		if b.model != "" {
			b.provider = modelid.Provider(b.model)
		}
		if billing.Applies(eventType) {
			b.billing = billing.DefaultMode(clientType)
		}
		batch = append(batch, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read backfill batch: %w", err)
	}
	return batch, nil
}

// backfillUpdatePostgres rewrites the batch's events and their sessions
// in two set-based statements. Values a client already sent (provider,
// billing_mode, platform, inference_scope) are kept; only empty ones
// are filled.
func backfillUpdatePostgres(ctx context.Context, tx *sql.Tx, batch []backfillRow) error {
	cols := struct {
		ids, sessions, raws, models, providers, billings, scopes []string
		times                                                    []time.Time
	}{}
	for _, b := range batch {
		cols.ids = append(cols.ids, b.id)
		cols.times = append(cols.times, b.occurredAt)
		cols.sessions = append(cols.sessions, b.sessionID)
		cols.raws = append(cols.raws, b.raw)
		cols.models = append(cols.models, b.model)
		cols.providers = append(cols.providers, b.provider)
		cols.billings = append(cols.billings, b.billing)
		cols.scopes = append(cols.scopes, b.scope)
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE events e
		SET model_requested = u.raw,
		    model           = NULLIF(u.model, ''),
		    provider        = COALESCE(e.provider, NULLIF(u.provider, '')),
		    billing_mode    = COALESCE(e.billing_mode, NULLIF(u.billing, '')),
		    platform        = COALESCE(e.platform, e.payload->'provider_metadata'->>'platform'),
		    payload         = CASE
		        WHEN u.scope = '' OR COALESCE(e.payload ? 'inference_scope', false) THEN e.payload
		        ELSE jsonb_set(COALESCE(e.payload, '{}'::jsonb), '{inference_scope}', to_jsonb(u.scope))
		    END
		FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
		     AS u(id, occurred_at, raw, model, provider, billing, scope)
		WHERE e.id = u.id AND e.occurred_at = u.occurred_at
	`, cols.ids, cols.times, cols.raws, cols.models, cols.providers, cols.billings, cols.scopes); err != nil {
		return fmt.Errorf("update backfill batch: %w", err)
	}

	// A session's model is the raw id of one of its events; replace it
	// with the canonical id only while it still holds that raw id, so a
	// concurrent write of a newer model is never overwritten. Batches of
	// different workers can share sessions, so their rows are locked in
	// session_id order first: two workers then queue for a shared
	// session instead of each holding one the other needs.
	if _, err := tx.ExecContext(ctx, `
		SELECT 1 FROM sessions
		WHERE session_id = ANY($1::uuid[])
		ORDER BY session_id
		FOR UPDATE
	`, cols.sessions); err != nil {
		return fmt.Errorf("lock backfill sessions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE sessions s
		SET model = u.model
		FROM (SELECT DISTINCT session_id, raw, model
		      FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(session_id, raw, model)
		      WHERE model <> '' AND model <> raw) AS u
		WHERE s.session_id = u.session_id AND s.model = u.raw
	`, cols.sessions, cols.raws, cols.models); err != nil {
		return fmt.Errorf("update backfill sessions: %w", err)
	}
	return nil
}

// backfillUpdateSQLite rewrites the batch's events and their sessions
// row by row inside the batch's transaction; a thousand single-row
// statements in one SQLite transaction take milliseconds, and no other
// writer runs meanwhile. The same values are kept and filled as on
// Postgres.
func backfillUpdateSQLite(ctx context.Context, tx *sql.Tx, batch []backfillRow) error {
	for _, b := range batch {
		if _, err := tx.ExecContext(ctx, `
			UPDATE events
			SET model_requested = $3,
			    model           = NULLIF($4, ''),
			    provider        = COALESCE(provider, NULLIF($5, '')),
			    billing_mode    = COALESCE(billing_mode, NULLIF($6, '')),
			    platform        = COALESCE(platform, json_extract(payload, '$.provider_metadata.platform')),
			    payload         = CASE
			        WHEN $7 = '' OR json_type(payload, '$.inference_scope') IS NOT NULL THEN payload
			        ELSE json_set(COALESCE(payload, '{}'), '$.inference_scope', $7)
			    END
			WHERE id = $1 AND occurred_at = $2
		`, b.id, b.occurredAt, b.raw, b.model, b.provider, b.billing, b.scope); err != nil {
			return fmt.Errorf("update backfill batch: %w", err)
		}
	}
	type sessionModel struct{ sessionID, raw, model string }
	seen := make(map[sessionModel]struct{})
	for _, b := range batch {
		if b.model == "" || b.model == b.raw {
			continue
		}
		k := sessionModel{b.sessionID, b.raw, b.model}
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		if _, err := tx.ExecContext(ctx,
			`UPDATE sessions SET model = $3 WHERE session_id = $1 AND model = $2`,
			k.sessionID, k.raw, k.model); err != nil {
			return fmt.Errorf("update backfill sessions: %w", err)
		}
	}
	return nil
}
