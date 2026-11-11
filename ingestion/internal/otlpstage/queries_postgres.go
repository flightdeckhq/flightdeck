package otlpstage

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// postgresQueries is the Postgres query set. Record keys travel as two
// parallel arrays (bytea[], smallint[]) that unnest pairs up; several
// replicas share the tables, so the claim and the sweeps lock the rows
// they take and skip the ones another transaction holds.
func postgresQueries(d storage.Dialect) queries {
	const keyList = `(span_id, kind) IN (SELECT * FROM unnest(CAST($3 AS bytea[]), CAST($4 AS smallint[])))`
	return queries{
		existingRecords: `
			SELECT span_id, kind FROM otlp_spans
			WHERE token_key = $1 AND trace_id = $2 AND ` + keyList,
		claimDue: `
			UPDATE otlp_traces t SET lease_owner = $1, lease_expires = $3
			FROM (SELECT token_key, trace_id FROM otlp_traces
			      WHERE pending AND resolve_at <= $2
			        AND (lease_expires IS NULL OR lease_expires < $2)
			      ORDER BY resolve_at
			      LIMIT $4
			      FOR UPDATE SKIP LOCKED) due
			WHERE t.token_key = due.token_key AND t.trace_id = due.trace_id
			RETURNING ` + postgresTraceColumns,
		deferTrace: fmt.Sprintf(`
			UPDATE otlp_traces
			SET lease_owner = NULL, lease_expires = NULL,
			    resolve_at = LEAST(%s, CASE WHEN gen <> $5 THEN LEAST(resolve_at, $6) ELSE $6 END)
			WHERE token_key = $1 AND trace_id = $2 AND lease_owner = $3 AND lease_expires >= $4`,
			d.AddInterval("first_received_at", "$7")),
		markRecords: `
			UPDATE otlp_spans SET assembled = TRUE, assembled_in = $5
			WHERE token_key = $1 AND trace_id = $2 AND NOT assembled AND ` + keyList,
		deleteContent: `
			DELETE FROM otlp_span_content
			WHERE token_key = $1 AND trace_id = $2 AND ` + keyList,
		sweepTraces: `
			DELETE FROM otlp_traces t
			USING (SELECT token_key, trace_id FROM otlp_traces
			       WHERE NOT pending AND assembled_at < $1
			         AND (assembly_reason = $4 OR assembled_at < $2)
			       LIMIT $3
			       FOR UPDATE SKIP LOCKED) expired
			WHERE t.token_key = expired.token_key AND t.trace_id = expired.trace_id
			  AND NOT t.pending`,
		sweepContent: `
			DELETE FROM otlp_span_content c
			USING (SELECT token_key, trace_id, span_id, kind FROM otlp_span_content
			       WHERE staged_at < $1
			       LIMIT $2
			       FOR UPDATE SKIP LOCKED) old
			WHERE c.token_key = old.token_key AND c.trace_id = old.trace_id
			  AND c.span_id = old.span_id AND c.kind = old.kind`,
		keyArgs: func(ids [][]byte, kinds []int16) []any {
			return []any{ids, kinds}
		},
		insertFacts:   postgresInsertFacts,
		insertContent: postgresInsertContent,
	}
}

// postgresTraceColumns is traceColumns qualified by the claim's alias,
// whose FROM clause also names token_key and trace_id.
const postgresTraceColumns = `t.token_key, t.trace_id, t.source, t.source_version, t.token_name,
	t.resource, t.capture, t.first_received_at, t.last_received_at, t.root_seen_at,
	t.resolve_at, t.gen, t.lease_expires, t.assembled_at, t.assembly_count,
	COALESCE(t.assembly_reason, ''), t.span_count`

// postgresInsertFacts stages all records in one statement over
// parallel arrays; the lock on the trace row makes a conflict
// impossible, and ON CONFLICT with the returned keys keep the counts
// true regardless.
func postgresInsertFacts(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) ([]Record, error) {
	n := len(records)
	var (
		ids, parents                     = make([][]byte, n), make([][]byte, n)
		kinds, statuses                  = make([]int16, n), make([]int16, n)
		remotes                          = make([]bool, n)
		scopes, versions, names, ops, ag = make([]string, n), make([]string, n), make([]string, n), make([]string, n), make([]string, n)
		starts, ends                     = make([]int64, n), make([]int64, n)
		metas                            = make([]string, n)
	)
	for i, r := range records {
		ids[i] = r.SpanID[:]
		if r.ParentSpanID != [8]byte{} {
			parents[i] = r.ParentSpanID[:]
		}
		kinds[i] = int16(r.Kind)
		statuses[i] = r.Status
		remotes[i] = r.RemoteParent
		scopes[i], versions[i], names[i], ops[i], ag[i] = r.ScopeName, r.ScopeVersion, r.Name, r.Op, r.AgentName
		starts[i], ends[i] = r.StartNs, r.EndNs
		metas[i] = jsonOrEmpty(r.Meta)
	}
	rows, err := tx.QueryContext(ctx, `
		INSERT INTO otlp_spans (token_key, trace_id, span_id, kind, parent_span_id, remote_parent,
		                        scope_name, scope_version, name, op, agent_name,
		                        start_ns, end_ns, status, meta, received_at)
		SELECT $1, $2, u.span_id, u.kind, u.parent_span_id, u.remote_parent,
		       u.scope_name, u.scope_version, u.name, u.op, u.agent_name,
		       u.start_ns, u.end_ns, u.status, CAST(u.meta AS jsonb), $16
		FROM unnest(CAST($3 AS bytea[]), CAST($4 AS smallint[]), CAST($5 AS bytea[]), CAST($6 AS boolean[]),
		            CAST($7 AS text[]), CAST($8 AS text[]), CAST($9 AS text[]), CAST($10 AS text[]), CAST($11 AS text[]),
		            CAST($12 AS bigint[]), CAST($13 AS bigint[]), CAST($14 AS smallint[]), CAST($15 AS text[]))
		     AS u(span_id, kind, parent_span_id, remote_parent,
		          scope_name, scope_version, name, op, agent_name,
		          start_ns, end_ns, status, meta)
		ON CONFLICT DO NOTHING
		RETURNING span_id, kind`,
		key.TokenKey, key.TraceID[:], ids, kinds, parents, remotes,
		scopes, versions, names, ops, ag, starts, ends, statuses, metas, now)
	if err != nil {
		return nil, fmt.Errorf("otlpstage: insert records: %w", err)
	}
	written := map[FactKey]bool{}
	for rows.Next() {
		var id []byte
		var kind int16
		if err := rows.Scan(&id, &kind); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("otlpstage: scan inserted record: %w", err)
		}
		written[factKey(id, kind)] = true
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("otlpstage: insert records: %w", err)
	}
	return keep(records, written), nil
}

func postgresInsertContent(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) error {
	var (
		ids      [][]byte
		kinds    []int16
		contents []string
	)
	for _, r := range withContent(records) {
		ids = append(ids, r.SpanID[:])
		kinds = append(kinds, int16(r.Kind))
		contents = append(contents, string(r.Content))
	}
	if len(ids) == 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO otlp_span_content (token_key, trace_id, span_id, kind, content, staged_at)
		SELECT $1, $2, u.span_id, u.kind, CAST(u.content AS jsonb), $6
		FROM unnest(CAST($3 AS bytea[]), CAST($4 AS smallint[]), CAST($5 AS text[])) AS u(span_id, kind, content)
		ON CONFLICT DO NOTHING`,
		key.TokenKey, key.TraceID[:], ids, kinds, contents, now); err != nil {
		return fmt.Errorf("otlpstage: insert content: %w", err)
	}
	return nil
}

// keep returns the records whose keys are in written, in their order.
func keep(records []Record, written map[FactKey]bool) []Record {
	inserted := make([]Record, 0, len(written))
	for _, r := range records {
		if written[r.Key()] {
			inserted = append(inserted, r)
		}
	}
	return inserted
}

// withContent returns the records that have content to stage. Content
// is inserted only when the batch's capture holds, and that is the AND
// of its records', so every record given declares capture; the check
// is kept as defence in depth.
func withContent(records []Record) []Record {
	var out []Record
	for _, r := range records {
		if r.Capture && r.Content != nil {
			out = append(out, r)
		}
	}
	return out
}
