package storage_test

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/url"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// The helpers the api store conversion added: percentiles, time
// differences, calendar dates, JSON type and boolean reads, JSON array
// expansion, LEAST / GREATEST, and the unique-violation classifier.
// Every one runs on both backends against the same rows.

// jsonTable creates a table with one JSON document per row.
func jsonTable(t *testing.T, db *storage.DB, docs ...string) {
	t.Helper()
	createTable(t, db, "storagetest_dialect_json",
		"(id INTEGER PRIMARY KEY, doc JSONB)",
		"(id INTEGER PRIMARY KEY, doc TEXT CHECK (json_valid(doc)))")
	for i, doc := range docs {
		var arg any = doc
		if doc == "" {
			arg = nil
		}
		mustExec(t, db, "INSERT INTO storagetest_dialect_json (id, doc) VALUES ($1, $2)", i+1, arg)
	}
}

func TestDialect_Percentile(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_dialect_pct",
			"(grp TEXT NOT NULL, v INTEGER)",
			"(grp TEXT NOT NULL, v INTEGER)")
		for _, r := range []struct {
			grp string
			v   any
		}{
			{"a", 10}, {"a", 20}, {"a", 30}, {"a", 40}, {"a", nil},
			{"b", 7},
			{"c", nil},
		} {
			mustExec(t, db, "INSERT INTO storagetest_dialect_pct (grp, v) VALUES ($1, $2)", r.grp, r.v)
		}
		d := db.Dialect
		rows, err := db.QueryContext(context.Background(),
			"SELECT grp, "+d.Percentile("0.5", "v")+", "+d.Percentile("0.95", "v")+
				", "+d.Percentile("0.5", "CASE WHEN v > 15 THEN v END")+
				" FROM storagetest_dialect_pct GROUP BY grp ORDER BY grp")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		type want struct {
			p50, p95, filtered sql.NullFloat64
		}
		wants := map[string]want{
			// 10 20 30 40: p50 at row 1.5 = 25; p95 at row 2.85 = 30 + 0.85*10.
			"a": {sql.NullFloat64{Float64: 25, Valid: true}, sql.NullFloat64{Float64: 38.5, Valid: true}, sql.NullFloat64{Float64: 30, Valid: true}},
			"b": {sql.NullFloat64{Float64: 7, Valid: true}, sql.NullFloat64{Float64: 7, Valid: true}, sql.NullFloat64{}},
			// Only NULLs: no value, as PERCENTILE_CONT yields.
			"c": {},
		}
		seen := 0
		for rows.Next() {
			var grp string
			var p50, p95, filtered sql.NullFloat64
			if err := rows.Scan(&grp, &p50, &p95, &filtered); err != nil {
				t.Fatal(err)
			}
			seen++
			w := wants[grp]
			for _, c := range []struct {
				name      string
				got, want sql.NullFloat64
			}{{"p50", p50, w.p50}, {"p95", p95, w.p95}, {"filtered p50", filtered, w.filtered}} {
				if c.got.Valid != c.want.Valid || math.Abs(c.got.Float64-c.want.Float64) > 1e-9 {
					t.Errorf("group %s %s = %+v, want %+v", grp, c.name, c.got, c.want)
				}
			}
		}
		if seen != 3 {
			t.Errorf("got %d groups, want 3", seen)
		}
	})
}

func TestDialect_SecondsBetweenAndDateOf(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		base := time.Date(2026, 11, 7, 23, 45, 12, 345000000, time.UTC)
		timesTable(t, db, base)
		d := db.Dialect
		later := base.Add(90*time.Second + 250*time.Millisecond)
		var secs float64
		if err := db.QueryRowContext(context.Background(),
			"SELECT "+d.SecondsBetween("$1", "ts")+" FROM storagetest_dialect_times", later).Scan(&secs); err != nil {
			t.Fatal(err)
		}
		if math.Abs(secs-90.25) > 1e-9 {
			t.Errorf("SecondsBetween = %v, want 90.25", secs)
		}
		// Negative when a precedes b.
		if err := db.QueryRowContext(context.Background(),
			"SELECT "+d.SecondsBetween("ts", "$1")+" FROM storagetest_dialect_times", later).Scan(&secs); err != nil {
			t.Fatal(err)
		}
		if math.Abs(secs+90.25) > 1e-9 {
			t.Errorf("SecondsBetween reversed = %v, want -90.25", secs)
		}
		var day storage.Time
		if err := db.QueryRowContext(context.Background(),
			"SELECT "+d.DateOf("ts")+" FROM storagetest_dialect_times").Scan(&day); err != nil {
			t.Fatal(err)
		}
		if !day.Valid || !day.Time.Equal(time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)) {
			t.Errorf("DateOf = %+v, want 2026-11-07", day)
		}
		// DateOf over a truncation groups the way a chart buckets.
		if err := db.QueryRowContext(context.Background(),
			"SELECT "+d.DateOf(d.DateTrunc(storage.TruncHour, "ts"))+" FROM storagetest_dialect_times").Scan(&day); err != nil {
			t.Fatal(err)
		}
		if !day.Valid || !day.Time.Equal(time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)) {
			t.Errorf("DateOf(DateTrunc(hour)) = %+v, want 2026-11-07", day)
		}
		// The date is the UTC date whatever the session time zone: on
		// Postgres a bare CAST to DATE would read 23:45Z of the 7th as
		// the 7th in New York only because New York is behind UTC;
		// 01:30Z of the 8th is still the 7th there.
		if db.Backend == storage.Postgres {
			u, err := url.Parse(storagetest.PostgresURL(t))
			if err != nil {
				t.Fatal(err)
			}
			q := u.Query()
			q.Set("TimeZone", "America/New_York")
			u.RawQuery = q.Encode()
			tzDB, err := storage.Open(context.Background(), u.String())
			if err != nil {
				t.Fatalf("open with TimeZone: %v", err)
			}
			defer func() { _ = tzDB.Close() }()
			early := time.Date(2026, 11, 8, 1, 30, 0, 0, time.UTC)
			mustExec(t, db, "UPDATE storagetest_dialect_times SET ts = $1 WHERE id = 1", early)
			var tzDay storage.Time
			if err := tzDB.QueryRowContext(context.Background(),
				"SELECT "+d.DateOf("ts")+" FROM storagetest_dialect_times").Scan(&tzDay); err != nil {
				t.Fatal(err)
			}
			if !tzDay.Valid || !tzDay.Time.Equal(time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)) {
				t.Errorf("DateOf under TimeZone=America/New_York = %+v, want 2026-11-08 (the UTC date)", tzDay)
			}
			if err := tzDB.QueryRowContext(context.Background(),
				"SELECT "+d.DateOf(d.DateTrunc(storage.TruncDay, "ts"))+" FROM storagetest_dialect_times").Scan(&tzDay); err != nil {
				t.Fatal(err)
			}
			if !tzDay.Valid || !tzDay.Time.Equal(time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)) {
				t.Errorf("DateOf(DateTrunc(day)) under TimeZone=America/New_York = %+v, want 2026-11-08", tzDay)
			}
		}
	})
}

func TestDialect_JSONTypeAndBooleans(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		jsonTable(t, db,
			`{"t": true, "f": false, "s": "true", "n": 3, "r": 2.5, "o": {"k": "v"}, "a": [1], "z": null, "err": {"error_type": "rate_limit"}}`,
			`{"other": 1}`,
			"",
		)
		d := db.Dialect
		ctx := context.Background()
		typeOf := func(key string) sql.NullString {
			var s sql.NullString
			if err := db.QueryRowContext(ctx, "SELECT "+d.JSONTypeOf("doc", key)+" FROM storagetest_dialect_json WHERE id = 1").Scan(&s); err != nil {
				t.Fatalf("JSONTypeOf(%s): %v", key, err)
			}
			return s
		}
		for key, want := range map[string]string{
			"t": "boolean", "f": "boolean", "s": "string", "n": "number", "r": "number",
			"o": "object", "a": "array", "z": "null",
		} {
			if got := typeOf(key); !got.Valid || got.String != want {
				t.Errorf("JSONTypeOf(%s) = %+v, want %s", key, got, want)
			}
		}
		if got := typeOf("missing"); got.Valid {
			t.Errorf("JSONTypeOf(missing) = %+v, want NULL", got)
		}
		var whole string
		if err := db.QueryRowContext(ctx, "SELECT "+d.JSONTypeOf("doc")+" FROM storagetest_dialect_json WHERE id = 1").Scan(&whole); err != nil {
			t.Fatal(err)
		}
		if whole != "object" {
			t.Errorf("JSONTypeOf(doc) = %q, want object", whole)
		}

		// JSONIsTrue: the boolean true and the string "true".
		var n int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM storagetest_dialect_json WHERE "+d.JSONIsTrue("doc", "t")).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("JSONIsTrue(t) matched %d rows, want 1", n)
		}
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM storagetest_dialect_json WHERE "+d.JSONIsTrue("doc", "s")).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("JSONIsTrue(s) matched %d rows, want 1", n)
		}
		for _, key := range []string{"f", "n", "missing"} {
			if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM storagetest_dialect_json WHERE "+d.JSONIsTrue("doc", key)).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n != 0 {
				t.Errorf("JSONIsTrue(%s) matched %d rows, want 0", key, n)
			}
		}

		// JSONBoolText renders booleans as text on both engines.
		for key, want := range map[string]string{"t": "true", "f": "false", "s": "true", "n": "3"} {
			var s sql.NullString
			if err := db.QueryRowContext(ctx, "SELECT "+d.JSONBoolText("doc", key)+" FROM storagetest_dialect_json WHERE id = 1").Scan(&s); err != nil {
				t.Fatal(err)
			}
			if !s.Valid || s.String != want {
				t.Errorf("JSONBoolText(%s) = %+v, want %q", key, s, want)
			}
		}
		// JSONNumber reads numbers; nested JSONText reads a string.
		var num float64
		if err := db.QueryRowContext(ctx, "SELECT "+d.JSONNumber("doc", "r")+" FROM storagetest_dialect_json WHERE id = 1").Scan(&num); err != nil {
			t.Fatal(err)
		}
		if num != 2.5 {
			t.Errorf("JSONNumber(r) = %v, want 2.5", num)
		}
		var nested string
		if err := db.QueryRowContext(ctx, "SELECT "+d.JSONText("doc", "err", "error_type")+" FROM storagetest_dialect_json WHERE id = 1").Scan(&nested); err != nil {
			t.Fatal(err)
		}
		if nested != "rate_limit" {
			t.Errorf("JSONText(err.error_type) = %q", nested)
		}
	})
}

func TestDialect_JSONArrayElements(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		jsonTable(t, db,
			`{"frameworks": ["langchain/0.1", "crewai/0.4"], "servers": [{"name": "fs"}, {"name": "git"}]}`,
			`{"frameworks": "not-an-array"}`,
			`{}`,
			"",
		)
		d := db.Dialect
		ctx := context.Background()
		// A cross join yields one row per element; non-arrays and
		// absent keys yield none.
		rows, err := db.QueryContext(ctx, "SELECT j.id, "+d.JSONElementText("fw")+
			" FROM storagetest_dialect_json j, "+d.JSONArrayElements(d.JSONArray("j.doc", "frameworks"), "fw")+
			" ORDER BY j.id, "+d.JSONElementText("fw"))
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for rows.Next() {
			var id int
			var v string
			if err := rows.Scan(&id, &v); err != nil {
				t.Fatal(err)
			}
			got = append(got, v)
		}
		_ = rows.Close()
		if len(got) != 2 || got[0] != "crewai/0.4" || got[1] != "langchain/0.1" {
			t.Errorf("elements = %v, want [crewai/0.4 langchain/0.1]", got)
		}
		// A LEFT JOIN keeps rows without elements, with a NULL element.
		var n int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM storagetest_dialect_json j LEFT JOIN "+
			d.JSONArrayElements(d.JSONArray("j.doc", "frameworks"), "fw")+" ON TRUE").Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 5 {
			t.Errorf("left join rows = %d, want 5 (2 elements + 3 element-less documents)", n)
		}
		// An object element's key reads through JSONText.
		rows, err = db.QueryContext(ctx, "SELECT "+d.JSONText("srv.value", "name")+
			" FROM storagetest_dialect_json j, "+d.JSONArrayElements(d.JSONArray("j.doc", "servers"), "srv")+
			" ORDER BY 1")
		if err != nil {
			t.Fatal(err)
		}
		got = nil
		for rows.Next() {
			var v string
			if err := rows.Scan(&v); err != nil {
				t.Fatal(err)
			}
			got = append(got, v)
		}
		_ = rows.Close()
		if len(got) != 2 || got[0] != "fs" || got[1] != "git" {
			t.Errorf("object elements = %v, want [fs git]", got)
		}
	})
}

// Rows stamped with one timestamp come back in a total, repeatable
// order with InsertionOrder as the tie-break: on SQLite the order they
// were inserted in, whatever their ids; on Postgres, which keeps no
// insertion order, by id.
func TestDialect_InsertionOrderBreaksATimestampTie(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_dialect_tie",
			"(id TEXT PRIMARY KEY, stamped_at TIMESTAMPTZ NOT NULL)",
			"(id TEXT PRIMARY KEY, stamped_at TIMESTAMP NOT NULL)")
		ctx := context.Background()
		stamp := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
		// Inserted in an order that is neither ascending nor descending
		// by id, so neither a lucky scan nor an id sort passes for
		// insertion order.
		inserted := []string{"m", "c", "x", "a", "q", "f", "z", "b"}
		for _, id := range inserted {
			mustExec(t, db, "INSERT INTO storagetest_dialect_tie (id, stamped_at) VALUES ($1, $2)", id, stamp)
		}
		// One row with a later stamp: the tie-break never overrides the
		// timestamp.
		mustExec(t, db, "INSERT INTO storagetest_dialect_tie (id, stamped_at) VALUES ('later', $1)", stamp.Add(time.Second))

		read := func(direction string) []string {
			t.Helper()
			query := "SELECT t.id FROM storagetest_dialect_tie t ORDER BY t.stamped_at " + direction + ", " +
				db.Dialect.InsertionOrder("t", "id") + " " + direction
			rows, err := db.Reader().QueryContext(ctx, query)
			if err != nil {
				t.Fatalf("%s: %v", query, err)
			}
			defer func() { _ = rows.Close() }()
			var ids []string
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, id)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			return ids
		}

		want := append([]string{}, inserted...)
		if db.Backend == storage.Postgres {
			slices.Sort(want)
		}
		asc := read("ASC")
		if !slices.Equal(asc, append(append([]string{}, want...), "later")) {
			t.Errorf("ascending: %v, want %v then later", asc, want)
		}
		slices.Reverse(want)
		desc := read("DESC")
		if !slices.Equal(desc, append([]string{"later"}, want...)) {
			t.Errorf("descending: %v, want later then %v", desc, want)
		}
		if again := read("DESC"); !slices.Equal(again, desc) {
			t.Errorf("the order changed between two reads: %v then %v", desc, again)
		}

		// Unqualified, for a statement with no alias.
		if got := db.Dialect.InsertionOrder("", "id"); got != map[storage.Backend]string{
			storage.SQLite: "rowid", storage.Postgres: "id",
		}[db.Backend] {
			t.Errorf("InsertionOrder(\"\", \"id\") = %q", got)
		}
	})
}

func TestDialect_LeastGreatest(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		d := db.Dialect
		var lo, hi int
		// Bare placeholders have no type on Postgres; a store compares
		// columns and literals.
		if err := db.QueryRowContext(context.Background(),
			"SELECT "+d.Least("CAST($1 AS INTEGER)", "CAST($2 AS INTEGER)")+", "+
				d.Greatest("CAST($1 AS INTEGER)", "CAST($2 AS INTEGER)"), 3, 9).Scan(&lo, &hi); err != nil {
			t.Fatal(err)
		}
		if lo != 3 || hi != 9 {
			t.Errorf("Least, Greatest = %d, %d, want 3, 9", lo, hi)
		}
	})
}

// regexp_like and regexp_replace spell the same on both engines:
// Postgres 15+ has them, SQLite gets them from the storage driver.
func TestRegexpFunctions(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		var matched bool
		if err := db.QueryRowContext(ctx, `SELECT regexp_like($1, '^(claude|anthropic\.)')`, "claude-sonnet-4-5").Scan(&matched); err != nil {
			t.Fatal(err)
		}
		if !matched {
			t.Error("regexp_like(claude-sonnet-4-5, ^(claude|anthropic\\.)) = false")
		}
		if err := db.QueryRowContext(ctx, `SELECT regexp_like($1, '^o[1-9](-|$)')`, "o3-mini").Scan(&matched); err != nil {
			t.Fatal(err)
		}
		if !matched {
			t.Error("regexp_like(o3-mini) = false")
		}
		if err := db.QueryRowContext(ctx, `SELECT regexp_like($1, '^o[1-9](-|$)')`, "omni").Scan(&matched); err != nil {
			t.Fatal(err)
		}
		if matched {
			t.Error("regexp_like(omni) = true")
		}
		cases := []struct{ in, pattern, repl, want string }{
			{"plugin_acme_fs", `^plugin_([^_:]+)_([^:]+)$`, `plugin:\1:\2`, "plugin:acme:fs"},
			{"plugin:acme:fs", `^plugin_([^_:]+)_([^:]+)$`, `plugin:\1:\2`, "plugin:acme:fs"},
			{"ft:gpt-4o:org::abc", `^ft:`, ``, "gpt-4o:org::abc"},
			{"claude-sonnet-4-5-20250929", `-([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$`, ``, "claude-sonnet-4-5"},
			{"gemini-2.5-pro-2025-06-17", `-([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$`, ``, "gemini-2.5-pro"},
			{"aXbXc", `X`, `-`, "a-bXc"}, // the first match only, as without the g flag
			{"abc", `b`, `[\&]`, "a[b]c"},
			{"cost $5", `\$`, `USD `, "cost USD 5"},
		}
		for _, c := range cases {
			var got string
			if err := db.QueryRowContext(ctx, `SELECT regexp_replace($1, $2, $3)`, c.in, c.pattern, c.repl).Scan(&got); err != nil {
				t.Fatalf("regexp_replace(%q, %q, %q): %v", c.in, c.pattern, c.repl, err)
			}
			if got != c.want {
				t.Errorf("regexp_replace(%q, %q, %q) = %q, want %q", c.in, c.pattern, c.repl, got, c.want)
			}
		}
		var null sql.NullString
		if err := db.QueryRowContext(ctx, `SELECT regexp_replace(NULL, 'a', 'b')`).Scan(&null); err != nil {
			t.Fatal(err)
		}
		if null.Valid {
			t.Errorf("regexp_replace(NULL) = %q, want NULL", null.String)
		}
	})
}

// gen_random_uuid() yields a canonical lower-case version-4 UUID on
// both engines, so it passes the SQLite schema's uuid CHECKs.
func TestGenRandomUUID(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		var a, b string
		if err := db.QueryRowContext(context.Background(), `SELECT CAST(gen_random_uuid() AS TEXT), CAST(gen_random_uuid() AS TEXT)`).Scan(&a, &b); err != nil {
			t.Fatal(err)
		}
		re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
		if !re.MatchString(a) || !re.MatchString(b) {
			t.Errorf("gen_random_uuid() = %q, %q, want canonical v4 UUIDs", a, b)
		}
		if a == b {
			t.Errorf("two calls returned the same id %q", a)
		}
		// Usable as an INSERT value under the uuid CHECK.
		if _, err := db.ExecContext(context.Background(),
			`INSERT INTO token_policies (id, scope, scope_value) VALUES (gen_random_uuid(), 'flavor', $1)`, "uuid-fn-"+a[:8]); err != nil {
			t.Errorf("insert with gen_random_uuid(): %v", err)
		}
	})
}

func TestIsUniqueViolation(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_unique",
			"(k TEXT PRIMARY KEY, u TEXT UNIQUE)",
			"(k TEXT PRIMARY KEY, u TEXT UNIQUE)")
		mustExec(t, db, "INSERT INTO storagetest_unique (k, u) VALUES ('a', 'x')")
		_, err := db.ExecContext(context.Background(), "INSERT INTO storagetest_unique (k, u) VALUES ('a', 'y')")
		if !storage.IsUniqueViolation(err) {
			t.Errorf("duplicate primary key: IsUniqueViolation(%v) = false", err)
		}
		_, err = db.ExecContext(context.Background(), "INSERT INTO storagetest_unique (k, u) VALUES ('b', 'x')")
		if !storage.IsUniqueViolation(err) {
			t.Errorf("duplicate unique column: IsUniqueViolation(%v) = false", err)
		}
		_, err = db.ExecContext(context.Background(), "INSERT INTO storagetest_unique (k, u) VALUES (NULL, 'z')")
		if storage.IsUniqueViolation(err) {
			t.Errorf("NOT NULL violation classified as unique: %v", err)
		}
		if storage.IsUniqueViolation(nil) || storage.IsUniqueViolation(errors.New("x")) {
			t.Error("nil or a plain error classified as unique violation")
		}
	})
}
