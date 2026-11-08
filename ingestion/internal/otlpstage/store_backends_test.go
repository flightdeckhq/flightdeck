package otlpstage

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// The two claim statements return the same columns in the same order:
// the Postgres one qualifies them with the row's alias, scanTrace reads
// either.
func TestTraceColumnsAgreeBetweenBackends(t *testing.T) {
	unqualified := strings.ReplaceAll(postgresTraceColumns, "t.", "")
	if unqualified != traceColumns {
		t.Fatalf("postgresTraceColumns without the alias:\n%s\nwant traceColumns:\n%s", unqualified, traceColumns)
	}
}

// With capture off nothing of a record's content reaches the database
// on either backend (CLAUDE.md rules 18 and 19): a record whose
// resource does not declare capture stages no content row however much
// content it carries, the trace's posture is off, LoadTrace returns no
// content, and the content table holds nothing for the trace. The
// record's metadata is staged as usual.
func TestCaptureOffStagesNoContentOnEitherBackend(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		e := newTestEnv(t, db)
		key := e.newKey()
		const secret = `{"gen_ai.input.messages":"the secret prompt"}`
		root := span(1, 0)
		root.Content = json.RawMessage(secret)
		call := span(2, 1)
		call.Content = json.RawMessage(secret)
		if res := e.stage(e.batch(key, root, call)); res.Staged != 2 {
			t.Fatalf("stage = %+v, want 2 staged", res)
		}
		if tr := e.traceRow(key); tr.Capture {
			t.Fatal("the trace's capture is on for records that never declared it")
		}
		if n := e.contentRows(key); n != 0 {
			t.Fatalf("%d content rows staged with capture off", n)
		}
		if e.spanRows(key) != 2 {
			t.Fatalf("%d records staged, want 2: capture never drops metadata", e.spanRows(key))
		}
		_, lt := e.claimOne("a", key)
		if lt.Capture {
			t.Fatal("the loaded trace says capture is on")
		}
		for _, f := range lt.Facts {
			if f.Content != nil {
				t.Fatalf("record %x loaded with content %s under capture off", f.SpanID, f.Content)
			}
			if strings.Contains(string(f.Meta), "secret") {
				t.Fatalf("record %x carries content in its meta: %s", f.SpanID, f.Meta)
			}
		}
		// Nothing in the content table names the prompt, for any trace.
		var n int
		if err := db.Reader().QueryRowContext(context.Background(),
			`SELECT count(*) FROM otlp_span_content WHERE CAST(content AS TEXT) LIKE '%secret prompt%'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%d content rows hold the prompt", n)
		}
	})
}

// Without the replacement the store applies, a raw U+0000 in a JSON
// document is refused by both backends (Postgres' jsonb and SQLite's
// json_valid check both reject the control character), so a record
// that carried one would fail its whole request on every retry; and a
// U+0000 in a text column, which SQLite stores as given, cuts the value
// short for SQLite's text functions. The store's path, through
// pgtext, stages the same record with U+FFFD in place.
func TestRawNULIsRefusedWithoutTheReplacement(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		e := newTestEnv(t, db)
		ctx := context.Background()
		key := e.newKey()
		e.stage(e.batch(key, span(1, 0)))
		nul := string(rune(0))

		_, err := db.ExecContext(ctx, `
			INSERT INTO otlp_spans (token_key, trace_id, span_id, kind, scope_name, name, start_ns, end_ns, status, meta, received_at)
			VALUES ($1, $2, $3, 1, 's', 'n', 0, 0, 0, $4, $5)`,
			key.TokenKey, key.TraceID[:], idBytes(9), `{"gen_ai.agent.name":"a`+nul+`b"}`, time.Now())
		if err == nil {
			t.Fatal("a JSON document with a raw U+0000 was stored")
		}
		if class := storage.ErrorClass(err); strings.Contains(class, "gen_ai.agent.name") {
			t.Errorf("the refusal's class quotes the document: %s", class)
		}

		if db.Backend == storage.SQLite {
			// Stored as given, but cut short for every text function.
			if _, err := db.ExecContext(ctx, `
				INSERT INTO otlp_spans (token_key, trace_id, span_id, kind, scope_name, name, start_ns, end_ns, status, meta, received_at)
				VALUES ($1, $2, $3, 1, 's', $4, 0, 0, 0, '{}', $5)`,
				key.TokenKey, key.TraceID[:], idBytes(8), "a"+nul+"b", time.Now()); err != nil {
				t.Fatalf("SQLite refused a raw U+0000 in a text column: %v", err)
			}
			var n int
			if err := db.Reader().QueryRowContext(ctx,
				`SELECT length(name) FROM otlp_spans WHERE token_key = $1 AND trace_id = $2 AND span_id = $3`,
				key.TokenKey, key.TraceID[:], idBytes(8)).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n != 1 {
				t.Fatalf("length() of a text with a raw U+0000 = %d, want 1 (cut at the NUL)", n)
			}
		}

		// Through the store the same record is staged, replaced.
		agent := span(3, 1)
		agent.Name, agent.AgentName = "a"+nul+"b", "a"+nul+"b"
		agent.Meta = json.RawMessage(`{"gen_ai.agent.name":"a\u0000b"}`)
		if res := e.stage(e.batch(key, agent)); res.Staged != 1 {
			t.Fatalf("stage = %+v, want 1 staged", res)
		}
		lt, err := e.store.LoadTrace(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range lt.Facts {
			if f.SpanID != spanID(3) {
				continue
			}
			var meta map[string]string
			_ = json.Unmarshal(f.Meta, &meta)
			if f.Name != "a�b" || f.AgentName != "a�b" || meta["gen_ai.agent.name"] != "a�b" {
				t.Fatalf("staged record name %q agent %q meta %v, want U+FFFD in place of the NUL", f.Name, f.AgentName, meta)
			}
		}
	})
}

// The key-list statements (the staged-record lookup, the mark and the
// content delete) take an empty list and a list with a repeated key on
// both backends: unnest of empty arrays and json_each of "[]" match no
// row, and a key named twice matches its row once.
func TestKeyListHandlesEmptyAndDuplicateKeys(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		e := newTestEnv(t, db)
		ctx := context.Background()
		key := e.newKey()
		e.stage(e.batch(key, captured(span(1, 0), `{"a":1}`), captured(span(2, 1), `{"b":2}`)))
		q := queriesFor(db)
		lookup := func(ids [][]byte, kinds []int16) int {
			t.Helper()
			rows, err := db.Reader().QueryContext(ctx, q.existingRecords,
				append([]any{key.TokenKey, key.TraceID[:]}, q.keyArgs(ids, kinds)...)...)
			if err != nil {
				t.Fatalf("lookup: %v", err)
			}
			defer func() { _ = rows.Close() }()
			n := 0
			for rows.Next() {
				n++
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			return n
		}
		if n := lookup(nil, nil); n != 0 {
			t.Fatalf("an empty key list matched %d records", n)
		}
		if n := lookup([][]byte{idBytes(1), idBytes(1), idBytes(9)}, []int16{1, 1, 1}); n != 1 {
			t.Fatalf("a repeated key and an unknown one matched %d records, want 1", n)
		}
		// A key with the other kind is another key.
		if n := lookup([][]byte{idBytes(1)}, []int16{int16(KindLog)}); n != 0 {
			t.Fatalf("the log kind of a staged span matched %d records", n)
		}

		_, lt := e.claimOne("a", key)
		// The mark with a repeated key marks the record once and deletes
		// its content once; the empty list is never sent (MarkAssembled
		// skips it), so the statements are exercised directly.
		dup := []FactKey{{SpanID: spanID(1), Kind: KindSpan}, {SpanID: spanID(1), Kind: KindSpan}}
		if res, err := e.store.MarkAssembled(ctx, "a", key, lt.Gen, ReasonComplete, dup); err != nil || !res.Marked {
			t.Fatalf("MarkAssembled with a repeated key = %+v, %v", res, err)
		}
		if !e.assembledFlag(key, 1) || e.assembledFlag(key, 2) || e.contentRows(key) != 1 {
			t.Fatalf("after a repeated-key mark: record 1 assembled=%v, record 2 assembled=%v, content rows=%d; want true, false, 1",
				e.assembledFlag(key, 1), e.assembledFlag(key, 2), e.contentRows(key))
		}
		for _, stmt := range []string{q.markRecords, q.deleteContent} {
			args := append([]any{key.TokenKey, key.TraceID[:]}, q.keyArgs(nil, nil)...)
			if stmt == q.markRecords {
				args = append(args, int64(7))
			}
			res, err := db.ExecContext(ctx, stmt, args...)
			if err != nil {
				t.Fatalf("statement with an empty key list: %v", err)
			}
			if n, _ := res.RowsAffected(); n != 0 {
				t.Fatalf("an empty key list changed %d rows", n)
			}
		}
	})
}
