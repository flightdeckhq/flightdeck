package writer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// The SQLite query set, and the transaction forms of the statements
// Postgres runs as one data-modifying CTE. The translations:
//
//   - `col ? 'key'` (key present) is json_type(col, '$.key') IS NOT
//     NULL: json_type is NULL for a missing key and 'null' for a key
//     holding JSON null, as Postgres' ? operator is true for both.
//   - `col <> '{}'::jsonb` is json(col) <> '{}': json() minifies, so
//     the empty object compares equal whatever its whitespace, as the
//     jsonb comparison does.
//   - jsonb_array_elements_text(col->'k') is json_each(col, '$.k'),
//     which yields no rows for a missing key or a NULL document.
//   - split_part(f, '/', 1) is substr(f || '/', 1, instr(f || '/', '/')
//     - 1): the appended separator makes instr find one on a bare
//     label too.
//   - jsonb_set(col, '{k}', arr || to_jsonb(x)) is json_set(col,
//     '$.k', json_insert(arr, '$[#]', x)); json_insert returns a JSON
//     value, so json_set embeds it as an array, not a string.
//   - LEAST / GREATEST are min / max, wrapped in COALESCE because
//     SQLite's are NULL when any argument is.
//   - $n::bigint is CAST($n AS BIGINT); $n::uuid and $n::jsonb need no
//     cast (text columns).
//   - Timestamps compare as text in storage.TimeLayout, which sorts
//     chronologically byte for byte; the driver binds a time.Time in
//     that layout.
//
// {{now}} is the dialect's current time, filled in by newQueries.

// upsertSessionSQLiteSQL is the session_start upsert UpsertSession
// runs (see upsertSessionPostgresSQL for the semantics of each column).
const upsertSessionSQLiteSQL = `
	INSERT INTO sessions (
		session_id, flavor, agent_type, host, framework, model, state,
		started_at, last_seen_at, context, token_id, token_name,
		agent_id, client_type, agent_name,
		parent_session_id, agent_role, capture_prompts,
		start_seq
	)
	VALUES (
		$1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7,
		CASE WHEN json_type($8, '$.otel_trace_id') IS NOT NULL
		     THEN min({{now}}, COALESCE($18, {{now}}))
		     ELSE {{now}} END,
		{{now}}, $8,
		NULLIF($9, ''), NULLIF($10, ''),
		$11, $12, $13,
		NULLIF($14, ''), NULLIF($15, ''), $16,
		NULLIF(CAST($17 AS BIGINT), 0)
	)
	ON CONFLICT (session_id) DO UPDATE
	SET state = CASE WHEN sessions.state = 'closed'
	                  AND sessions.closed_seq > NULLIF(CAST($17 AS BIGINT), 0)
	                 THEN sessions.state
	                 ELSE excluded.state END,
	    ended_at = CASE WHEN sessions.state = 'closed'
	                     AND sessions.closed_seq > NULLIF(CAST($17 AS BIGINT), 0)
	                    THEN sessions.ended_at
	                    ELSE NULL END,
	    closed_seq = CASE WHEN sessions.state = 'closed'
	                       AND sessions.closed_seq > NULLIF(CAST($17 AS BIGINT), 0)
	                      THEN sessions.closed_seq
	                      ELSE NULL END,
	    start_seq = COALESCE(max(sessions.start_seq, NULLIF(CAST($17 AS BIGINT), 0)),
	                         sessions.start_seq, NULLIF(CAST($17 AS BIGINT), 0)),
	    started_at = CASE WHEN sessions.capture_prompts IS NULL
	                       AND json_type(excluded.context, '$.otel_trace_id') IS NOT NULL
	                      THEN excluded.started_at
	                      ELSE sessions.started_at END,
	    last_seen_at = {{now}},
	    host = COALESCE(excluded.host, sessions.host),
	    framework = COALESCE(excluded.framework, sessions.framework),
	    model = COALESCE(excluded.model, sessions.model),
	    context = CASE
	        WHEN sessions.context IS NULL
	             AND sessions.framework IS NOT NULL
	             AND COALESCE(sessions.client_type, excluded.client_type) = 'flightdeck_sensor'
	             AND excluded.context IS NOT NULL AND json(excluded.context) <> '{}'
	             AND COALESCE(json_type(excluded.context, '$.frameworks'), 'array') = 'array'
	             AND NOT EXISTS (
	                 SELECT 1
	                 FROM json_each(excluded.context, '$.frameworks') AS f
	                 WHERE substr(f.value || '/', 1, instr(f.value || '/', '/') - 1) = sessions.framework
	             )
	        THEN json_set(excluded.context, '$.frameworks',
	                      json_insert(COALESCE(json_extract(excluded.context, '$.frameworks'), '[]'),
	                                  '$[#]', sessions.framework))
	        ELSE COALESCE(sessions.context, excluded.context) END,
	    token_id = COALESCE(sessions.token_id, excluded.token_id),
	    token_name = COALESCE(sessions.token_name, excluded.token_name),
	    flavor = CASE WHEN sessions.flavor = 'unknown'
	                  THEN excluded.flavor
	                  ELSE sessions.flavor END,
	    agent_type = CASE WHEN sessions.agent_type = 'unknown'
	                      THEN excluded.agent_type
	                      ELSE sessions.agent_type END,
	    agent_id = COALESCE(sessions.agent_id, excluded.agent_id),
	    client_type = COALESCE(sessions.client_type, excluded.client_type),
	    agent_name = COALESCE(sessions.agent_name, excluded.agent_name),
	    parent_session_id = COALESCE(
	        sessions.parent_session_id, excluded.parent_session_id),
	    agent_role = COALESCE(sessions.agent_role, excluded.agent_role),
	    capture_prompts = COALESCE(
	        sessions.capture_prompts, excluded.capture_prompts)
`

var sqliteQueries = queries{
	upsertSessionClaim: upsertSessionSQLiteSQL + `
	WHERE sessions.agent_id IS NULL
	RETURNING 1`,

	// The refresh runs in the claim's transaction on the one writer
	// connection, so the row it saw is still there and owned: it never
	// inserts, and reports so.
	upsertSessionRefresh: upsertSessionSQLiteSQL + `
	WHERE sessions.agent_id IS NOT NULL
	RETURNING 0`,

	// Both "no context yet" sentinels, NULL and the empty object, are
	// replaced; a real context is left as stored, byte for byte.
	upgradeSessionContext: `
		UPDATE sessions
		SET context = CASE WHEN context IS NULL OR json(context) = '{}' THEN $2 ELSE context END
		WHERE session_id = $1`,

	// json($2) marks the dict as a JSON value, so json_insert appends
	// an object rather than a string.
	appendMCPServer: `
		UPDATE sessions
		SET context = json_set(
			COALESCE(context, '{}'),
			'$.mcp_servers',
			json_insert(COALESCE(json_extract(context, '$.mcp_servers'), '[]'), '$[#]', json($2))
		)
		WHERE session_id = $1
		  AND NOT EXISTS (
			SELECT 1
			  FROM json_each(COALESCE(context, '{}'), '$.mcp_servers') AS s
			 WHERE json_extract(s.value, '$.name') = $3
			   AND COALESCE(json_extract(s.value, '$.server_url'), '') = COALESCE($4, '')
		  )`,

	updateSessionFromCall: `
		UPDATE sessions
		SET model = COALESCE(NULLIF($2, ''), model),
		    framework = COALESCE(framework, NULLIF($3, '')),
		    context = CASE
		        WHEN $3 <> ''
		             AND (framework IS NULL
		                  OR (framework = $3 AND client_type = 'flightdeck_sensor'))
		             AND context IS NOT NULL AND json(context) <> '{}'
		             AND COALESCE(json_type(context, '$.frameworks'), 'array') = 'array'
		             AND NOT EXISTS (
		                 SELECT 1
		                 FROM json_each(context, '$.frameworks') AS f
		                 WHERE substr(f.value || '/', 1, instr(f.value || '/', '/') - 1) = $3
		             )
		        THEN json_set(context, '$.frameworks',
		                      json_insert(COALESCE(json_extract(context, '$.frameworks'), '[]'), '$[#]', $3))
		        ELSE context END
		WHERE session_id = $1
		  AND ($2 <> '' OR (framework IS NULL AND $3 <> ''))`,

	// No row lock: the whole batch is claimed and rewritten inside one
	// write transaction, which the single writer connection serialises
	// against every other write.
	backfillSelect: `
		SELECT CAST(e.id AS TEXT), e.occurred_at, CAST(e.session_id AS TEXT), e.model, e.event_type,
		       COALESCE(s.client_type, '')
		FROM events e
		LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.model IS NOT NULL AND e.model_requested IS NULL
		ORDER BY e.occurred_at
		LIMIT $1`,
}

// bumpParentSQLite is BumpParentLastSeen's write on SQLite: the prior
// state is read and the row updated in one write transaction, which
// holds the write lock from BEGIN, so the state it reads is the state
// the update acts on. It returns "" for a closed or missing row.
func (w *Writer) bumpParentSQLite(ctx context.Context, parentSessionID string) (prevState string, err error) {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	err = tx.QueryRowContext(ctx,
		`SELECT state FROM sessions WHERE session_id = $1 AND state <> 'closed'`, parentSessionID,
	).Scan(&prevState)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, w.q.updateParent(), parentSessionID); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return prevState, nil
}

// updateParent is the UPDATE of bumpParentSQLite, rendered with the
// dialect's current time.
func (q queries) updateParent() string {
	return `UPDATE sessions
		SET state = CASE WHEN state IN ('stale', 'lost') THEN 'active' ELSE state END,
		    last_seen_at = ` + q.now() + `
		WHERE session_id = $1 AND state <> 'closed'`
}

// settleSessionEndSQLite is SettleSessionEnd on SQLite: the row's prior
// state is read and the guarded UPDATE run in one write transaction, so
// the state read is the one the UPDATE acts on. closedSeq is the end's
// sequence (0 unknown) and endedAt the end's time (nil: the clock).
func (w *Writer) settleSessionEndSQLite(ctx context.Context, sessionID string, closedSeq int64, endedAt any) (applied, closedNow bool, err error) {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return false, false, fmt.Errorf("settle session end %s: begin: %w", sessionID, err)
	}
	defer func() { _ = tx.Rollback() }()
	var prior string
	err = tx.QueryRowContext(ctx, `SELECT state FROM sessions WHERE session_id = $1`, sessionID).Scan(&prior)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("settle session end %s: %w", sessionID, err)
	}
	now := w.q.now()
	res, err := tx.ExecContext(ctx, `
		UPDATE sessions
		SET state = 'closed',
		    ended_at = CASE WHEN state = 'closed' THEN ended_at
		                    WHEN json_type(context, '$.otel_trace_id') IS NOT NULL
		                    THEN min(`+now+`, COALESCE($3, `+now+`))
		                    ELSE `+now+` END,
		    last_seen_at = CASE WHEN state = 'closed' THEN last_seen_at ELSE `+now+` END,
		    closed_seq = CASE WHEN state = 'closed'
		                      THEN COALESCE(max(closed_seq, NULLIF(CAST($2 AS BIGINT), 0)),
		                                    closed_seq, NULLIF(CAST($2 AS BIGINT), 0))
		                      ELSE NULLIF(CAST($2 AS BIGINT), 0) END
		WHERE session_id = $1
		  AND (start_seq IS NULL OR CAST($2 AS BIGINT) = 0 OR start_seq < CAST($2 AS BIGINT))
		  AND (state <> 'closed' OR closed_seq IS NULL OR closed_seq < CAST($2 AS BIGINT))
	`, sessionID, closedSeq, endedAt)
	if err != nil {
		return false, false, fmt.Errorf("settle session end %s: %w", sessionID, err)
	}
	if rowsAffected(res) == 0 {
		return false, false, nil
	}
	if err := tx.Commit(); err != nil {
		return false, false, fmt.Errorf("settle session end %s: commit: %w", sessionID, err)
	}
	return true, prior != "closed", nil
}

// reapOrphansSQLite is ReapOrphanedLostSessions on SQLite: the expired
// rows are selected, closed and given their synthetic session_end in
// one write transaction. cutoffSecs is negative: how far back silence
// must reach.
func (w *Writer) reapOrphansSQLite(ctx context.Context, cutoffSecs int64) ([]fleetNotifyPayload, error) {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `
		SELECT session_id, flavor FROM sessions
		WHERE state = 'lost' AND last_seen_at < `+w.db.Dialect.AddInterval(w.q.now(), "$1"), cutoffSecs)
	if err != nil {
		return nil, err
	}
	type expired struct{ sessionID, flavor string }
	var batch []expired
	for rows.Next() {
		var e expired
		if err := rows.Scan(&e.sessionID, &e.flavor); err != nil {
			_ = rows.Close()
			return nil, err
		}
		batch = append(batch, e)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()

	closes := make([]fleetNotifyPayload, 0, len(batch))
	for _, e := range batch {
		if _, err := tx.ExecContext(ctx,
			`UPDATE sessions SET state = 'closed', ended_at = `+w.q.now()+` WHERE session_id = $1`, e.sessionID); err != nil {
			return nil, err
		}
		p := fleetNotifyPayload{SessionID: e.sessionID, EventType: orphanCloseEventType}
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO events (session_id, flavor, event_type, payload)
			VALUES ($1, $2, $3, json_object('close_reason', 'orphan_timeout'))
			RETURNING CAST(id AS TEXT)`, e.sessionID, e.flavor, orphanCloseEventType).Scan(&p.EventID); err != nil {
			return nil, err
		}
		closes = append(closes, p)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return closes, nil
}
