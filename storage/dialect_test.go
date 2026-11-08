package storage_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// Every dialect helper runs on both backends against the same rows and
// must give the same answer.

func TestDialect_Placeholder(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		d := db.Dialect
		if d.Placeholder(1) != "$1" || d.Placeholder(12) != "$12" {
			t.Fatalf("Placeholder = %q, %q", d.Placeholder(1), d.Placeholder(12))
		}
		var a, b string
		if err := db.QueryRowContext(context.Background(),
			"SELECT "+d.Placeholder(1)+", "+d.Placeholder(2), "first", "second").Scan(&a, &b); err != nil {
			t.Fatal(err)
		}
		if a != "first" || b != "second" {
			t.Errorf("bound (%q, %q), want (first, second)", a, b)
		}
		// Reusing a placeholder binds the same argument on both.
		var c, e string
		if err := db.QueryRowContext(context.Background(),
			"SELECT $1, $1", "same").Scan(&c, &e); err != nil {
			t.Fatal(err)
		}
		if c != "same" || e != "same" {
			t.Errorf("repeated $1 bound (%q, %q)", c, e)
		}
	})
}

func TestDialect_Now(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		var now storage.Time
		before := time.Now().Add(-time.Minute)
		if err := db.QueryRowContext(context.Background(), "SELECT "+db.Dialect.Now()).Scan(&now); err != nil {
			t.Fatal(err)
		}
		after := time.Now().Add(time.Minute)
		if !now.Valid || now.Time.Before(before) || now.Time.After(after) {
			t.Errorf("Now() = %+v, want within a minute of %s", now, time.Now().UTC())
		}
	})
}

// timesTable creates a table with one TIMESTAMP row for the time helpers.
func timesTable(t *testing.T, db *storage.DB, ts time.Time) {
	t.Helper()
	createTable(t, db, "storagetest_dialect_times",
		"(id INTEGER PRIMARY KEY, ts TIMESTAMPTZ NOT NULL)",
		"(id INTEGER PRIMARY KEY, ts TIMESTAMP NOT NULL)")
	mustExec(t, db, "INSERT INTO storagetest_dialect_times (id, ts) VALUES (1, $1)", ts)
}

func TestDialect_AddInterval(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		base := time.Date(2026, 11, 7, 13, 45, 12, 345000000, time.UTC)
		timesTable(t, db, base)
		d := db.Dialect
		ctx := context.Background()

		cases := []struct {
			seconds any
			want    time.Time
		}{
			{90, base.Add(90 * time.Second)},
			{-3600, base.Add(-time.Hour)},
			{0.5, base.Add(500 * time.Millisecond)},
		}
		// A bound parameter is the common case in store code.
		for _, c := range cases {
			var got storage.Time
			q := "SELECT " + d.AddInterval("ts", "$1") + " FROM storagetest_dialect_times WHERE id = 1"
			if err := db.QueryRowContext(ctx, q, c.seconds).Scan(&got); err != nil {
				t.Fatalf("AddInterval(ts, %v): %v", c.seconds, err)
			}
			if !got.Valid || !got.Time.Equal(c.want) {
				t.Errorf("AddInterval(ts, %v) = %s, want %s", c.seconds, got.Time, c.want)
			}
		}

		// A literal number and Now() compose; the row is in the past.
		q := "SELECT COUNT(*) FROM storagetest_dialect_times WHERE ts < " + d.AddInterval(d.Now(), "-60")
		if n := queryInt(t, db, q); n != 1 {
			t.Errorf("ts < Now() - 60 s matched %d rows, want 1", n)
		}
	})
}

func TestDialect_DateTrunc(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		// A Saturday, so the week truncation has to move back five days.
		base := time.Date(2026, 11, 7, 13, 45, 12, 345000000, time.UTC)
		timesTable(t, db, base)
		d := db.Dialect
		cases := map[storage.TruncUnit]time.Time{
			storage.TruncHour:  time.Date(2026, 11, 7, 13, 0, 0, 0, time.UTC),
			storage.TruncDay:   time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC),
			storage.TruncWeek:  time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
			storage.TruncMonth: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
		}
		for unit, want := range cases {
			var got storage.Time
			q := "SELECT " + d.DateTrunc(unit, "ts") + " FROM storagetest_dialect_times WHERE id = 1"
			if err := db.QueryRowContext(context.Background(), q).Scan(&got); err != nil {
				t.Fatalf("DateTrunc(%s): %v", unit, err)
			}
			if !got.Valid || !got.Time.Equal(want) {
				t.Errorf("DateTrunc(%s) = %s, want %s", unit, got.Time, want)
			}
		}
		// A Monday truncates to itself.
		mustExec(t, db, "UPDATE storagetest_dialect_times SET ts = $1 WHERE id = 1",
			time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC))
		var monday storage.Time
		if err := db.QueryRowContext(context.Background(),
			"SELECT "+d.DateTrunc(storage.TruncWeek, "ts")+" FROM storagetest_dialect_times WHERE id = 1").Scan(&monday); err != nil {
			t.Fatal(err)
		}
		if want := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC); !monday.Time.Equal(want) {
			t.Errorf("week of a Monday = %s, want %s", monday.Time, want)
		}
	})
}

func TestDialect_ILike(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_names",
			"(name TEXT NOT NULL)", "(name TEXT NOT NULL)")
		for _, n := range []string{"Hello World", "50% off", "50x off", "under_score", "underXscore", "ÉCOLE", "école"} {
			mustExec(t, db, "INSERT INTO storagetest_names (name) VALUES ($1)", n)
		}
		d := db.Dialect
		cases := []struct {
			pattern string
			want    int
		}{
			{"%hello%", 1},
			{"HELLO WORLD", 1},
			{"%WORLD", 1},
			{"nothing", 0},
			{`50\%%`, 1},   // escaped %, then a wildcard: only "50% off"
			{"50_ off", 2}, // _ matches one character
			{`under\_score`, 1},
			{"under_score", 2},
			// Non-ASCII letters are not folded on either backend: the
			// Postgres side runs under the "C" collation so the
			// database locale cannot make it match both rows.
			{"école", 1},
			{"ÉCOLE", 1},
			{"%cole", 2}, // the ASCII tail matches both
		}
		for _, c := range cases {
			q := "SELECT COUNT(*) FROM storagetest_names WHERE " + d.ILike("name", "$1")
			if n := queryInt(t, db, q, c.pattern); n != c.want {
				t.Errorf("ILike(name, %q) matched %d, want %d", c.pattern, n, c.want)
			}
		}
		// A literal pattern (not a placeholder) renders too.
		q := "SELECT COUNT(*) FROM storagetest_names WHERE " + d.ILike("name", "'hello%'")
		if n := queryInt(t, db, q); n != 1 {
			t.Errorf("ILike with a literal pattern matched %d, want 1", n)
		}
		// Plain LIKE is case-sensitive on both backends (SQLite through
		// case_sensitive_like), so a store that wants case folding has
		// to say so with ILike.
		if n := queryInt(t, db, "SELECT COUNT(*) FROM storagetest_names WHERE name LIKE 'hello%'"); n != 0 {
			t.Errorf("plain LIKE 'hello%%' matched %d rows, want 0 (case-sensitive)", n)
		}
		if n := queryInt(t, db, "SELECT COUNT(*) FROM storagetest_names WHERE name LIKE 'Hello%'"); n != 1 {
			t.Errorf("plain LIKE 'Hello%%' matched %d rows, want 1", n)
		}
	})
}

// DateTrunc truncates in UTC whatever the connection's time zone: a
// timestamp just after midnight UTC belongs to that UTC day even when
// the session zone is hours behind.
func TestDialect_DateTruncIgnoresSessionTimeZone(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		base := time.Date(2026, 11, 7, 1, 30, 0, 0, time.UTC) // Saturday 01:30 UTC
		timesTable(t, db, base)
		ctx := context.Background()
		conn, err := db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close() }()
		if db.Backend == storage.Postgres {
			// Friday 20:30 in New York; a zone-following truncation
			// would say Friday.
			if _, err := conn.ExecContext(ctx, "SET TIME ZONE 'America/New_York'"); err != nil {
				t.Fatal(err)
			}
		}
		d := db.Dialect
		cases := map[storage.TruncUnit]time.Time{
			storage.TruncHour:  time.Date(2026, 11, 7, 1, 0, 0, 0, time.UTC),
			storage.TruncDay:   time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC),
			storage.TruncWeek:  time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
			storage.TruncMonth: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
		}
		for unit, want := range cases {
			var got storage.Time
			q := "SELECT " + d.DateTrunc(unit, "ts") + " FROM storagetest_dialect_times WHERE id = 1"
			if err := conn.QueryRowContext(ctx, q).Scan(&got); err != nil {
				t.Fatalf("DateTrunc(%s): %v", unit, err)
			}
			if !got.Valid || !got.Time.Equal(want) {
				t.Errorf("DateTrunc(%s) under a non-UTC session = %s, want %s", unit, got.Time.UTC(), want)
			}
		}
		// Grouping by the truncation puts the row in the UTC day.
		var day storage.Time
		var n int
		q := "SELECT " + d.DateTrunc(storage.TruncDay, "ts") + " AS d, COUNT(*) FROM storagetest_dialect_times GROUP BY d"
		if err := conn.QueryRowContext(ctx, q).Scan(&day, &n); err != nil {
			t.Fatal(err)
		}
		if !day.Time.Equal(cases[storage.TruncDay]) || n != 1 {
			t.Errorf("GROUP BY DateTrunc = (%s, %d)", day.Time.UTC(), n)
		}
	})
}

func TestDialect_InUUIDArray(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		var ids []string
		for i := 0; i < 3; i++ {
			var id string
			if err := db.QueryRowContext(ctx,
				"INSERT INTO token_policies (scope, scope_value, token_limit) VALUES ('flavor', $1, 1) RETURNING CAST(id AS TEXT)",
				"storagetest_uuid_"+string(rune('a'+i))).Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), "DELETE FROM token_policies WHERE scope_value LIKE 'storagetest_uuid_%'")
		})
		d := db.Dialect
		q := "SELECT COUNT(*) FROM token_policies WHERE " + d.InUUIDArray("id", "$1")
		if n := queryInt(t, db, q, d.ArrayArg(ids[:2])); n != 2 {
			t.Errorf("InUUIDArray matched %d, want 2", n)
		}
		if n := queryInt(t, db, q, d.ArrayArg([]string{ids[2], "00000000-0000-4000-8000-000000000000"})); n != 1 {
			t.Errorf("InUUIDArray with an unknown id matched %d, want 1", n)
		}
		if n := queryInt(t, db, q, d.ArrayArg(nil)); n != 0 {
			t.Errorf("InUUIDArray over an empty array matched %d, want 0", n)
		}
		// Text comparison on the same rows agrees.
		q = "SELECT COUNT(*) FROM token_policies WHERE " + d.InArray("CAST(id AS TEXT)", "$1")
		if n := queryInt(t, db, q, d.ArrayArg(ids)); n != 3 {
			t.Errorf("InArray over CAST(id AS TEXT) matched %d, want 3", n)
		}
	})
}

func TestDialect_InArray(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_members",
			"(name TEXT NOT NULL)", "(name TEXT NOT NULL)")
		for _, n := range []string{"a", "b", "c", "it's"} {
			mustExec(t, db, "INSERT INTO storagetest_members (name) VALUES ($1)", n)
		}
		d := db.Dialect
		q := "SELECT COUNT(*) FROM storagetest_members WHERE " + d.InArray("name", "$1")
		cases := []struct {
			values []string
			want   int
		}{
			{[]string{"a", "b"}, 2},
			{[]string{"c", "zz", "it's"}, 2},
			{[]string{}, 0},
			{nil, 0},
		}
		for _, c := range cases {
			if n := queryInt(t, db, q, d.ArrayArg(c.values)); n != c.want {
				t.Errorf("InArray(name, %v) matched %d, want %d", c.values, n, c.want)
			}
		}
		// Not-in composes.
		q = "SELECT COUNT(*) FROM storagetest_members WHERE NOT (" + d.InArray("name", "$1") + ")"
		if n := queryInt(t, db, q, d.ArrayArg([]string{"a"})); n != 3 {
			t.Errorf("NOT InArray matched %d, want 3", n)
		}
	})
}

func TestDialect_JSONText(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_docs",
			"(id INTEGER PRIMARY KEY, doc JSONB)",
			"(id INTEGER PRIMARY KEY, doc TEXT CHECK (json_valid(doc)))")
		mustExec(t, db, "INSERT INTO storagetest_docs (id, doc) VALUES (1, $1)",
			`{"os":"linux","error":{"error_type":"timeout"},"empty":null}`)
		mustExec(t, db, "INSERT INTO storagetest_docs (id, doc) VALUES (2, $1)", nil)
		d := db.Dialect
		ctx := context.Background()

		var osName, errType, missing, empty sql.NullString
		q := "SELECT " + d.JSONText("doc", "os") + ", " + d.JSONText("doc", "error", "error_type") +
			", " + d.JSONText("doc", "nope") + ", " + d.JSONText("doc", "empty") +
			" FROM storagetest_docs WHERE id = 1"
		if err := db.QueryRowContext(ctx, q).Scan(&osName, &errType, &missing, &empty); err != nil {
			t.Fatal(err)
		}
		if osName.String != "linux" || errType.String != "timeout" {
			t.Errorf("JSONText = (%q, %q), want (linux, timeout)", osName.String, errType.String)
		}
		if missing.Valid || empty.Valid {
			t.Errorf("missing key / JSON null = (%+v, %+v), want NULL, NULL", missing, empty)
		}

		// The read works as a filter and on a NULL document.
		q = "SELECT COUNT(*) FROM storagetest_docs WHERE " + d.JSONText("doc", "os") + " = $1"
		if n := queryInt(t, db, q, "linux"); n != 1 {
			t.Errorf("filter on JSONText matched %d, want 1", n)
		}
		q = "SELECT COUNT(*) FROM storagetest_docs WHERE " + d.JSONText("doc", "os") + " IS NULL"
		if n := queryInt(t, db, q); n != 1 {
			t.Errorf("IS NULL on JSONText matched %d, want 1 (the NULL document)", n)
		}
	})
}

func TestDialect_UpsertAndReturning(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_kv",
			"(k TEXT PRIMARY KEY, v TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0)",
			"(k TEXT NOT NULL PRIMARY KEY, v TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0)")
		d := db.Dialect
		ctx := context.Background()

		upsert := "INSERT INTO storagetest_kv (k, v) VALUES ($1, $2) " +
			d.Upsert([]string{"k"}, []string{"v"}) + " " + d.Returning("k", "v", "hits")
		var k, v string
		var hits int
		if err := db.QueryRowContext(ctx, upsert, "a", "one").Scan(&k, &v, &hits); err != nil {
			t.Fatal(err)
		}
		if k != "a" || v != "one" || hits != 0 {
			t.Errorf("first upsert returned (%q, %q, %d)", k, v, hits)
		}
		if err := db.QueryRowContext(ctx, upsert, "a", "two").Scan(&k, &v, &hits); err != nil {
			t.Fatal(err)
		}
		if v != "two" {
			t.Errorf("second upsert returned v=%q, want two", v)
		}
		if n := queryInt(t, db, "SELECT COUNT(*) FROM storagetest_kv"); n != 1 {
			t.Errorf("%d rows after two upserts of one key", n)
		}

		// DO NOTHING keeps the first value and returns no row.
		nothing := "INSERT INTO storagetest_kv (k, v) VALUES ($1, $2) " +
			d.Upsert([]string{"k"}, nil) + " " + d.Returning("v")
		err := db.QueryRowContext(ctx, nothing, "a", "three").Scan(&v)
		if err != sql.ErrNoRows {
			t.Errorf("DO NOTHING upsert on an existing key: err=%v v=%q, want ErrNoRows", err, v)
		}
		if got := queryString(t, db, "SELECT v FROM storagetest_kv WHERE k = $1", "a"); got != "two" {
			t.Errorf("v after DO NOTHING = %q, want two", got)
		}
		if err := db.QueryRowContext(ctx, nothing, "b", "new").Scan(&v); err != nil || v != "new" {
			t.Errorf("DO NOTHING upsert on a new key: v=%q err=%v", v, err)
		}

		// A multi-column update sets every listed column from EXCLUDED.
		multi := "INSERT INTO storagetest_kv (k, v, hits) VALUES ($1, $2, $3) " +
			d.Upsert([]string{"k"}, []string{"v", "hits"})
		mustExec(t, db, multi, "a", "four", 7)
		if err := db.QueryRowContext(ctx, "SELECT v, hits FROM storagetest_kv WHERE k = $1", "a").Scan(&v, &hits); err != nil {
			t.Fatal(err)
		}
		if v != "four" || hits != 7 {
			t.Errorf("multi-column upsert left (%q, %d), want (four, 7)", v, hits)
		}
	})
}

func TestDialect_CastToTextIsCommon(t *testing.T) {
	// CAST(x AS TEXT) is the portable spelling of Postgres' x::text; the
	// baseline stores UUIDs as text so it is a no-op there.
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		var id string
		err := db.QueryRowContext(context.Background(),
			"SELECT CAST(id AS TEXT) FROM access_tokens WHERE name = $1", "Development Token").Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		if len(id) != 36 {
			t.Errorf("CAST(id AS TEXT) = %q, want a 36-character UUID", id)
		}
		if n := queryInt(t, db, "SELECT COUNT(*) FROM access_tokens WHERE id = $1", id); n != 1 {
			t.Errorf("id = $1 with the text form matched %d rows, want 1", n)
		}
	})
}
