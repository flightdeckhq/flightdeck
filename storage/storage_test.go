package storage_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

func TestOpen_RejectsUnknownScheme(t *testing.T) {
	_, err := storage.Open(context.Background(), "mysql://x")
	if !errors.Is(err, storage.ErrUnsupportedURL) {
		t.Fatalf("got %v, want ErrUnsupportedURL", err)
	}
	if _, err := storage.BackendOf("sqlite://a.db"); err != nil {
		t.Fatal(err)
	}
	if b, _ := storage.BackendOf("postgresql://u@h/db"); b != storage.Postgres {
		t.Fatalf("postgresql:// is %q, want postgres", b)
	}
}

func TestOpen_SQLiteNeedsAFile(t *testing.T) {
	for _, url := range []string{"sqlite://", "sqlite://:memory:"} {
		if _, err := storage.Open(context.Background(), url); err == nil {
			t.Errorf("Open(%q) succeeded, want an error", url)
		}
	}
}

func TestOpen_SQLiteCreatesFileWithWALAndForeignKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fd.db")
	db, err := storage.Open(context.Background(), "sqlite://"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if db.Backend != storage.SQLite || db.Dialect.Backend() != storage.SQLite {
		t.Fatalf("backend %q / dialect %q, want sqlite", db.Backend, db.Dialect.Backend())
	}
	if got := queryString(t, db, "PRAGMA journal_mode"); got != "wal" {
		t.Errorf("journal_mode %q, want wal", got)
	}
	if got := queryInt(t, db, "PRAGMA foreign_keys"); got != 1 {
		t.Errorf("foreign_keys %d, want 1", got)
	}
	var rows int
	if err := db.Reader().QueryRowContext(context.Background(), "PRAGMA foreign_keys").Scan(&rows); err != nil || rows != 1 {
		t.Errorf("reader foreign_keys %d (%v), want 1", rows, err)
	}
	if db.Reader() == db.DB {
		t.Error("SQLite reader is the writer handle; want a separate pool")
	}
}

// A path with the characters SQLite's URI syntax reserves opens the
// file at exactly that path: nothing is truncated at "#" or "?", a "%"
// is not decoded, and no sibling file appears.
func TestOpen_SQLitePathWithURIReservedCharacters(t *testing.T) {
	for _, dir := range []string{"a#b", "x?y", "50%", "%41", "My Documents", "mix #?% ed"} {
		t.Run(dir, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, dir), 0o755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, dir, "fd.db")
			url := "sqlite://" + path
			ctx := context.Background()
			// The migrator opens the same path through the same DSN.
			if err := storage.Migrate(ctx, url); err != nil {
				t.Fatalf("migrate: %v", err)
			}
			db, err := storage.Open(ctx, url)
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			defer func() { _ = db.Close() }()
			mustExec(t, db, "INSERT INTO token_policies (scope, scope_value) VALUES ('global', $1)", dir)
			if n := queryInt(t, db, "SELECT COUNT(*) FROM token_policies WHERE scope_value = $1", dir); n != 1 {
				t.Errorf("row written through the writer not read back by the reader: %d", n)
			}
			if _, err := os.Stat(path); err != nil {
				t.Errorf("database file is not at %q: %v", path, err)
			}
			entries, err := os.ReadDir(root)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range entries {
				if e.Name() != dir {
					t.Errorf("unexpected entry %q beside %q: the path was cut or decoded", e.Name(), dir)
				}
			}
		})
	}
}

// The read pool cannot write, and a plain LIKE is case-sensitive, as on
// Postgres.
func TestOpen_SQLiteReaderIsQueryOnlyAndLikeIsCaseSensitive(t *testing.T) {
	db := storagetest.OpenSQLite(t)
	ctx := context.Background()
	_, err := db.Reader().ExecContext(ctx, "INSERT INTO token_policies (scope, scope_value) VALUES ('global', 'x')")
	if err == nil || !strings.Contains(err.Error(), "readonly") {
		t.Errorf("write through Reader(): err=%v, want a readonly database error", err)
	}
	if n := queryInt(t, db, "SELECT COUNT(*) FROM token_policies WHERE scope_value = 'x'"); n != 0 {
		t.Errorf("the refused write landed: %d rows", n)
	}
	// The pragma is per connection: every reader connection has it.
	for i := 0; i < 2*8; i++ {
		var ro int
		if err := db.Reader().QueryRowContext(ctx, "PRAGMA query_only").Scan(&ro); err != nil || ro != 1 {
			t.Fatalf("reader connection %d: query_only=%d err=%v", i, ro, err)
		}
	}
	if n := queryInt(t, db, "SELECT COUNT(*) FROM access_tokens WHERE name LIKE 'development token'"); n != 0 {
		t.Errorf("plain LIKE matched %d rows ignoring case; case_sensitive_like is off", n)
	}
	if n := queryInt(t, db, "SELECT COUNT(*) FROM access_tokens WHERE name LIKE 'Development Token'"); n != 1 {
		t.Errorf("plain LIKE on the exact name matched %d rows, want 1", n)
	}
}

// Every DB-backed assertion below runs on both backends.

func TestTime_RoundTripsThroughBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_times",
			"(id INTEGER PRIMARY KEY, ts TIMESTAMPTZ NOT NULL, maybe TIMESTAMPTZ)",
			"(id INTEGER PRIMARY KEY, ts TIMESTAMP NOT NULL, maybe TIMESTAMP)")
		ctx := context.Background()

		// Microseconds on the way in. Postgres keeps them; SQLite stores
		// the millisecond (TimeLayout), so the expected value is at the
		// backend's own precision.
		in := time.Date(2026, 11, 7, 13, 45, 12, 345678000, time.FixedZone("IST", 2*3600))
		want := in
		if db.Backend == storage.SQLite {
			want = in.Truncate(time.Millisecond)
		}
		mustExec(t, db, "INSERT INTO storagetest_times (id, ts, maybe) VALUES ($1, $2, $3)", 1, in, nil)
		mustExec(t, db, "INSERT INTO storagetest_times (id, ts, maybe) VALUES ($1, $2, $3)", 2, in, sql.NullTime{Time: in, Valid: true})

		var out time.Time
		var maybe sql.NullTime
		if err := db.QueryRowContext(ctx, "SELECT ts, maybe FROM storagetest_times WHERE id = $1", 1).Scan(&out, &maybe); err != nil {
			t.Fatal(err)
		}
		if !out.Equal(want) {
			t.Errorf("ts = %s, want %s", out.UTC(), want.UTC())
		}
		if maybe.Valid {
			t.Errorf("maybe = %v, want NULL", maybe)
		}
		if err := db.QueryRowContext(ctx, "SELECT maybe FROM storagetest_times WHERE id = $1", 2).Scan(&maybe); err != nil {
			t.Fatal(err)
		}
		if !maybe.Valid || !maybe.Time.Equal(want) {
			t.Errorf("maybe = %v, want %s", maybe, want.UTC())
		}

		// A computed timestamp (no declared column type) scans through
		// storage.Time on both backends.
		var computed storage.Time
		if err := db.QueryRowContext(ctx, "SELECT MAX(ts) FROM storagetest_times").Scan(&computed); err != nil {
			t.Fatal(err)
		}
		if !computed.Valid || !computed.Time.Equal(want) {
			t.Errorf("MAX(ts) = %+v, want %s", computed, want.UTC())
		}
		var none storage.Time
		if err := db.QueryRowContext(ctx, "SELECT MAX(maybe) FROM storagetest_times WHERE id = 1").Scan(&none); err != nil {
			t.Fatal(err)
		}
		if none.Valid {
			t.Errorf("MAX of NULL = %+v, want invalid", none)
		}

		// A time bound as a parameter compares with the stored value.
		if n := queryInt(t, db, "SELECT COUNT(*) FROM storagetest_times WHERE ts = $1", in); n != 2 {
			t.Errorf("ts = $1 matched %d rows, want 2", n)
		}
		if n := queryInt(t, db, "SELECT COUNT(*) FROM storagetest_times WHERE ts > $1", in.Add(-time.Second)); n != 2 {
			t.Errorf("ts > $1 matched %d rows, want 2", n)
		}

		if db.Backend == storage.SQLite {
			// The stored text is the fixed layout, so it sorts
			// chronologically and the date functions read it.
			if got := queryString(t, db, "SELECT CAST(ts AS TEXT) FROM storagetest_times WHERE id = 1"); got != "2026-11-07T11:45:12.345Z" {
				t.Errorf("stored text %q, want 2026-11-07T11:45:12.345Z", got)
			}
		}
	})
}

func TestTime_ParseAndFormat(t *testing.T) {
	want := time.Date(2026, 11, 7, 11, 45, 12, 345000000, time.UTC)
	if got := storage.FormatTime(want.In(time.FixedZone("x", 3600))); got != "2026-11-07T11:45:12.345Z" {
		t.Errorf("FormatTime = %q", got)
	}
	for _, s := range []string{
		"2026-11-07T11:45:12.345Z",
		"2026-11-07T11:45:12.345",
		"2026-11-07 11:45:12.345",
		"2026-11-07T11:45:12.345+00:00",
		"2026-11-07T13:45:12.345+02:00",
	} {
		got, err := storage.ParseTime(s)
		if err != nil || !got.Equal(want) {
			t.Errorf("ParseTime(%q) = %v, %v; want %v", s, got, err, want)
		}
	}
	if _, err := storage.ParseTime("yesterday"); err == nil {
		t.Error("ParseTime accepted garbage")
	}
	var zero storage.Time
	if err := zero.Scan(nil); err != nil || zero.Valid {
		t.Errorf("Scan(nil) = %v, %+v", err, zero)
	}
	if err := zero.Scan(42); err == nil {
		t.Error("Scan(int) succeeded")
	}
	if v, _ := (storage.Time{}).Value(); v != nil {
		t.Errorf("invalid Time.Value() = %v, want nil", v)
	}
}

// Concurrent write transactions queue on the single SQLite writer and
// all commit; on Postgres they simply run. Reads on the Reader handle
// see every commit.
func TestWrites_ConcurrentTransactionsAllCommit(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		createTable(t, db, "storagetest_counter",
			"(id INTEGER PRIMARY KEY, n BIGINT NOT NULL)",
			"(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)")
		mustExec(t, db, "INSERT INTO storagetest_counter (id, n) VALUES (1, 0)")
		ctx := context.Background()

		const writers, perWriter = 8, 10
		var wg sync.WaitGroup
		errs := make(chan error, writers*perWriter)
		for w := 0; w < writers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < perWriter; i++ {
					tx, err := db.BeginTx(ctx, nil)
					if err != nil {
						errs <- err
						return
					}
					var n int64
					if err := tx.QueryRowContext(ctx, "SELECT n FROM storagetest_counter WHERE id = 1").Scan(&n); err != nil {
						_ = tx.Rollback()
						errs <- err
						return
					}
					if _, err := tx.ExecContext(ctx, "UPDATE storagetest_counter SET n = $1 WHERE id = 1", n+1); err != nil {
						_ = tx.Rollback()
						errs <- err
						return
					}
					if err := tx.Commit(); err != nil {
						errs <- err
						return
					}
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Errorf("write transaction: %v", err)
		}
		var n int64
		if err := db.Reader().QueryRowContext(ctx, "SELECT n FROM storagetest_counter WHERE id = 1").Scan(&n); err != nil {
			t.Fatal(err)
		}
		if db.Backend == storage.SQLite && n != writers*perWriter {
			// One writer connection makes read-modify-write serial.
			t.Errorf("counter = %d, want %d", n, writers*perWriter)
		}
		if db.Backend == storage.Postgres && n < 1 {
			// Postgres runs them concurrently; lost updates are expected
			// without SELECT ... FOR UPDATE, which is not what this
			// test is about.
			t.Errorf("counter = %d, want at least 1", n)
		}
	})
}
