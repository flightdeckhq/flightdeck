package otlpstage

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

// sqliteInsertFacts stages the records one statement each, inside the
// caller's transaction: SQLite has no array parameters, and a statement
// on the local file costs no round trip. The rows a statement affected
// (one or, on a conflict, none) say which records were inserted.
func sqliteInsertFacts(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) ([]Record, error) {
	written := map[FactKey]bool{}
	for _, r := range records {
		var parent []byte
		if r.ParentSpanID != [8]byte{} {
			parent = r.ParentSpanID[:]
		}
		res, err := tx.ExecContext(ctx, `
			INSERT INTO otlp_spans (token_key, trace_id, span_id, kind, parent_span_id, remote_parent,
			                        scope_name, scope_version, name, op, agent_name,
			                        start_ns, end_ns, status, meta, received_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
			ON CONFLICT DO NOTHING`,
			key.TokenKey, key.TraceID[:], r.SpanID[:], int16(r.Kind), parent, r.RemoteParent,
			r.ScopeName, r.ScopeVersion, r.Name, r.Op, r.AgentName,
			r.StartNs, r.EndNs, r.Status, jsonOrEmpty(r.Meta), now)
		if err != nil {
			return nil, fmt.Errorf("otlpstage: insert records: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, fmt.Errorf("otlpstage: insert records: %w", err)
		}
		if n == 1 {
			written[r.Key()] = true
		}
	}
	return keep(records, written), nil
}

func sqliteInsertContent(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) error {
	for _, r := range withContent(records) {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO otlp_span_content (token_key, trace_id, span_id, kind, content, staged_at)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT DO NOTHING`,
			key.TokenKey, key.TraceID[:], r.SpanID[:], int16(r.Kind), string(r.Content), now); err != nil {
			return fmt.Errorf("otlpstage: insert content: %w", err)
		}
	}
	return nil
}
