package otlpstage

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// sqliteQueries is the SQLite query set. Record keys travel as one JSON
// array of [span id as hex, kind] pairs that json_each unpacks, unhex
// turning the ids back into the BLOB the key column holds so the
// primary key index serves the lookup. One process holds
// the one writer connection and every write transaction begins
// IMMEDIATE, so the claim and the sweeps meet no row another writer
// holds and lock nothing themselves; each is one statement, atomic on
// its own.
func sqliteQueries(d storage.Dialect) queries {
	if d == nil {
		d = storage.DialectFor(storage.SQLite)
	}
	const keyList = `(span_id, kind) IN (
		SELECT unhex(json_extract(value, '$[0]')), json_extract(value, '$[1]') FROM json_each($3))`
	return queries{
		existingRecords: `
			SELECT span_id, kind FROM otlp_spans
			WHERE token_key = $1 AND trace_id = $2 AND ` + keyList,
		claimDue: `
			UPDATE otlp_traces SET lease_owner = $1, lease_expires = $3
			WHERE (token_key, trace_id) IN (
			      SELECT token_key, trace_id FROM otlp_traces
			      WHERE pending AND resolve_at <= $2
			        AND (lease_expires IS NULL OR lease_expires < $2)
			      ORDER BY resolve_at
			      LIMIT $4)
			RETURNING ` + traceColumns,
		deferTrace: fmt.Sprintf(`
			UPDATE otlp_traces
			SET lease_owner = NULL, lease_expires = NULL,
			    resolve_at = min(%s, CASE WHEN gen <> $5 THEN min(resolve_at, $6) ELSE $6 END)
			WHERE token_key = $1 AND trace_id = $2 AND lease_owner = $3 AND lease_expires >= $4`,
			d.AddInterval("first_received_at", "$7")),
		markRecords: `
			UPDATE otlp_spans SET assembled = TRUE, assembled_in = $4
			WHERE token_key = $1 AND trace_id = $2 AND NOT assembled AND ` + keyList,
		deleteContent: `
			DELETE FROM otlp_span_content
			WHERE token_key = $1 AND trace_id = $2 AND ` + keyList,
		sweepTraces: `
			DELETE FROM otlp_traces
			WHERE NOT pending AND (token_key, trace_id) IN (
			      SELECT token_key, trace_id FROM otlp_traces
			      WHERE NOT pending AND assembled_at < $1
			        AND (assembly_reason = $4 OR assembled_at < $2)
			      LIMIT $3)`,
		sweepContent: `
			DELETE FROM otlp_span_content
			WHERE (token_key, trace_id, span_id, kind) IN (
			      SELECT token_key, trace_id, span_id, kind FROM otlp_span_content
			      WHERE staged_at < $1
			      LIMIT $2)`,
		keyArgs:       sqliteKeyArgs,
		insertFacts:   sqliteInsertFacts,
		insertContent: sqliteInsertContent,
	}
}

// sqliteKeyArgs renders the keys as the JSON array of pairs the
// IN-lists read with json_each.
func sqliteKeyArgs(ids [][]byte, kinds []int16) []any {
	pairs := make([][2]any, len(ids))
	for i, id := range ids {
		pairs[i] = [2]any{hex.EncodeToString(id), kinds[i]}
	}
	doc, _ := json.Marshal(pairs)
	return []any{string(doc)}
}

// sqliteInsertChunk bounds the rows of one multi-row INSERT. SQLite
// binds at most SQLITE_MAX_VARIABLE_NUMBER parameters per statement
// (32766 in current builds, 999 in old ones); a record binds 16
// columns, so 500 rows use 8000 parameters, well inside either limit,
// and a request at the MaxSpansPerTrace cap takes 20 statements
// instead of 10 000. One statement per record was measured at about a
// fifth of StageTimeout for a maximal request on a fast disk and past
// it under the race detector.
const sqliteInsertChunk = 500

// sqliteInsertFacts stages the records in multi-row INSERTs of
// sqliteInsertChunk rows, inside the caller's transaction. The records
// are the ones the lookup in this same transaction found absent, and no
// other writer can add a row while it holds the one writer connection,
// so every row inserts: the rows a statement changed say so, and a
// statement that changed fewer (which the ON CONFLICT clause tolerates
// as a defence) re-reads which of its keys are staged. Not reading the
// inserted keys back through RETURNING spares a result row per record,
// which at the 10 000-record cap is a third of the write's time. The
// full-chunk statement is prepared once and run for every full chunk
// (SQLite parses a statement of 8000 parameters in milliseconds, which
// adds up over twenty chunks); the last, shorter chunk is one more
// statement. The VALUES list is the one place this store renders
// placeholders itself: SQLite has no array parameters to unnest.
func sqliteInsertFacts(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) ([]Record, error) {
	const columns = 16
	const insert = `
		INSERT INTO otlp_spans (token_key, trace_id, span_id, kind, parent_span_id, remote_parent,
		                        scope_name, scope_version, name, op, agent_name,
		                        start_ns, end_ns, status, meta, received_at)
		VALUES `
	const tail = `
		ON CONFLICT DO NOTHING`
	var inserted []Record
	var full *sql.Stmt
	defer func() {
		if full != nil {
			_ = full.Close()
		}
	}()
	for chunk := range slices.Chunk(records, sqliteInsertChunk) {
		args := make([]any, 0, columns*len(chunk))
		for _, r := range chunk {
			var parent []byte
			if r.ParentSpanID != [8]byte{} {
				parent = r.ParentSpanID[:]
			}
			args = append(args, key.TokenKey, key.TraceID[:], r.SpanID[:], int16(r.Kind), parent, r.RemoteParent,
				r.ScopeName, r.ScopeVersion, r.Name, r.Op, r.AgentName,
				r.StartNs, r.EndNs, r.Status, jsonOrEmpty(r.Meta), now)
		}
		var (
			res sql.Result
			err error
		)
		if len(chunk) == sqliteInsertChunk {
			if full == nil {
				full, err = tx.PrepareContext(ctx, insert+sqliteValuesList(sqliteInsertChunk, columns)+tail)
				if err != nil {
					return nil, fmt.Errorf("otlpstage: prepare insert: %w", err)
				}
			}
			res, err = full.ExecContext(ctx, args...)
		} else {
			res, err = tx.ExecContext(ctx, insert+sqliteValuesList(len(chunk), columns)+tail, args...)
		}
		if err != nil {
			return nil, fmt.Errorf("otlpstage: insert records: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, fmt.Errorf("otlpstage: insert records: %w", err)
		}
		if n == int64(len(chunk)) {
			inserted = append(inserted, chunk...)
			continue
		}
		written, err := sqliteStagedKeys(ctx, tx, key, chunk)
		if err != nil {
			return nil, err
		}
		inserted = append(inserted, keep(chunk, written)...)
	}
	return inserted, nil
}

// sqliteStagedKeys reads which of the records' keys are staged.
func sqliteStagedKeys(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record) (map[FactKey]bool, error) {
	ids := make([][]byte, len(records))
	kinds := make([]int16, len(records))
	for i, r := range records {
		ids[i] = r.SpanID[:]
		kinds[i] = int16(r.Kind)
	}
	q := sqliteQueries(nil)
	rows, err := tx.QueryContext(ctx, q.existingRecords, append([]any{key.TokenKey, key.TraceID[:]}, q.keyArgs(ids, kinds)...)...)
	if err != nil {
		return nil, fmt.Errorf("otlpstage: look up inserted records: %w", err)
	}
	defer func() { _ = rows.Close() }()
	staged := map[FactKey]bool{}
	for rows.Next() {
		var id []byte
		var kind int16
		if err := rows.Scan(&id, &kind); err != nil {
			return nil, fmt.Errorf("otlpstage: scan inserted record: %w", err)
		}
		staged[factKey(id, kind)] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("otlpstage: look up inserted records: %w", err)
	}
	return staged, nil
}

func sqliteInsertContent(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) error {
	for chunk := range slices.Chunk(withContent(records), sqliteInsertChunk) {
		args := make([]any, 0, 6*len(chunk))
		for _, r := range chunk {
			args = append(args, key.TokenKey, key.TraceID[:], r.SpanID[:], int16(r.Kind), string(r.Content), now)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO otlp_span_content (token_key, trace_id, span_id, kind, content, staged_at)
			VALUES `+sqliteValuesList(len(chunk), 6)+`
			ON CONFLICT DO NOTHING`, args...); err != nil {
			return fmt.Errorf("otlpstage: insert content: %w", err)
		}
	}
	return nil
}

// sqliteValuesList renders rows tuples of cols placeholders each:
// "(?, ?), (?, ?)". The placeholders are positional, not the $N of the
// rest of the store: SQLite resolves a named parameter by scanning the
// statement's parameter names, which over thousands of parameters is
// quadratic and was measured at seconds per chunk, while positional
// ones bind in constant time.
func sqliteValuesList(rows, cols int) string {
	tuple := "(?" + strings.Repeat(", ?", cols-1) + ")"
	return tuple + strings.Repeat(", "+tuple, rows-1)
}
