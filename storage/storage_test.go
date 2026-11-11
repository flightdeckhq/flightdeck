package storage_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
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
		if _, err := storage.Open(context.Background(), url); !errors.Is(err, storage.ErrSQLiteNeedsFile) {
			t.Errorf("Open(%q) = %v, want ErrSQLiteNeedsFile", url, err)
		}
	}
}

// Every handle is bounded: the Postgres pool at pgxpool's old default
// (max(4, NumCPU) open and idle), the SQLite writer at one connection
// and the SQLite reader at its fixed pool size. Token validation runs
// before the rate limiter and never caches an unknown token, so an
// unbounded pool could exhaust the server's max_connections.
func TestOpen_ConnectionsAreCapped(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		switch db.Backend {
		case storage.Postgres:
			want := max(4, runtime.NumCPU())
			if got := db.Stats().MaxOpenConnections; got != want {
				t.Errorf("postgres MaxOpenConnections = %d, want max(4, NumCPU) = %d", got, want)
			}
		case storage.SQLite:
			if got := db.Stats().MaxOpenConnections; got != 1 {
				t.Errorf("sqlite writer MaxOpenConnections = %d, want 1", got)
			}
			if got := db.Reader().Stats().MaxOpenConnections; got != 8 {
				t.Errorf("sqlite reader MaxOpenConnections = %d, want 8", got)
			}
		}
	})
}

// openRetryTestBudget is the budget the retry test gives a database
// that never answers: long enough for the first two backoff steps
// (0.5 s + 1 s) to prove the loop retries, short enough to keep the
// test under a few seconds.
const openRetryTestBudget = 1600 * time.Millisecond

func TestOpenRetry_RetriesUntilTheBudgetThenGivesUp(t *testing.T) {
	// Port 1 is reserved and never listens: every attempt is refused
	// at once, so the elapsed time is the backoff alone.
	const closed = "postgres://u:p@127.0.0.1:1/x?sslmode=disable&connect_timeout=1"
	start := time.Now()
	_, err := storage.OpenRetry(context.Background(), closed, openRetryTestBudget)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("OpenRetry to a closed port succeeded")
	}
	if elapsed < openRetryTestBudget || elapsed > openRetryTestBudget+3*time.Second {
		t.Errorf("gave up after %s, want about the %s budget", elapsed, openRetryTestBudget)
	}
	m := regexp.MustCompile(`after (\d+) attempts`).FindStringSubmatch(err.Error())
	if m == nil {
		t.Fatalf("error does not report its attempts: %v", err)
	}
	if n, _ := strconv.Atoi(m[1]); n < 3 {
		t.Errorf("%d attempts within %s, want at least 3 (0.5 s, 1 s, then the remainder)", n, openRetryTestBudget)
	}
	if !strings.Contains(err.Error(), "connection refused") && !strings.Contains(err.Error(), "connect") {
		t.Errorf("error does not carry the last connection error: %v", err)
	}

	// A URL Open can never accept is not retried.
	start = time.Now()
	if _, err := storage.OpenRetry(context.Background(), "mysql://x", openRetryTestBudget); !errors.Is(err, storage.ErrUnsupportedURL) {
		t.Errorf("unsupported URL: %v, want ErrUnsupportedURL", err)
	}
	if _, err := storage.OpenRetry(context.Background(), "sqlite://:memory:", openRetryTestBudget); !errors.Is(err, storage.ErrSQLiteNeedsFile) {
		t.Errorf("memory sqlite: %v, want ErrSQLiteNeedsFile", err)
	}
	if since := time.Since(start); since > 500*time.Millisecond {
		t.Errorf("non-retryable URLs took %s; they must fail at once", since)
	}

	// A cancelled context ends the wait early.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start = time.Now()
	if _, err := storage.OpenRetry(ctx, closed, time.Minute); err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("cancelled retry: %v, want DeadlineExceeded", err)
	}
	if since := time.Since(start); since > 2*time.Second {
		t.Errorf("cancelled retry took %s", since)
	}

	// A reachable database opens on the first attempt.
	path := filepath.Join(t.TempDir(), "fd.db")
	db, err := storage.OpenRetry(context.Background(), "sqlite://"+path, openRetryTestBudget)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
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
	// Durability and concurrency settings of every connection, the
	// writer's and the read pool's: write-ahead logging, and
	// synchronous NORMAL (1), under which a committed transaction
	// survives a crash of the process and the log is synced at each
	// checkpoint.
	const synchronousNormal = 1
	for name, handle := range map[string]*sql.DB{"writer": db.DB, "reader": db.Reader()} {
		var mode string
		if err := handle.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
			t.Errorf("%s journal_mode %q (%v), want wal", name, mode, err)
		}
		var synchronous int
		if err := handle.QueryRowContext(context.Background(), "PRAGMA synchronous").Scan(&synchronous); err != nil || synchronous != synchronousNormal {
			t.Errorf("%s synchronous %d (%v), want %d (NORMAL)", name, synchronous, err, synchronousNormal)
		}
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
			url := storage.SQLiteURL(path)
			if got := storage.SQLitePath(url); got != path {
				t.Fatalf("SQLitePath(SQLiteURL(%q)) = %q", path, got)
			}
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

// Share gives a second service of the process a handle on the same
// database: on SQLite one writer for both and a read pool each, on
// Postgres a pool each, and a Close that leaves the original usable.
func TestShare_OneSQLiteWriterAPoolEachAndAnIndependentClose(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		shared, err := db.Share(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if shared.Backend != db.Backend || shared.URL() != db.URL() {
			t.Fatalf("shared handle is %s at %q, want %s at %q", shared.Backend, shared.URL(), db.Backend, db.URL())
		}
		switch db.Backend {
		case storage.SQLite:
			if shared.DB != db.DB {
				t.Fatal("the shared handle has a writer of its own; the process must keep one")
			}
			if shared.Reader() == db.Reader() || shared.Reader() == shared.DB {
				t.Fatal("on SQLite the shared handle reads through a pool of its own")
			}
			if n := db.Stats().MaxOpenConnections; n != 1 {
				t.Fatalf("the writer allows %d connections, want 1", n)
			}
			// The shared pool is a read pool: it cannot write.
			if _, err := shared.Reader().ExecContext(ctx, "INSERT INTO token_policies (scope, scope_value) VALUES ('global', 'x')"); err == nil {
				t.Fatal("a write through the shared read pool succeeded")
			}
		case storage.Postgres:
			if shared.DB == db.DB || shared.Reader() != shared.DB {
				t.Fatal("on Postgres the shared handle is one pool of its own")
			}
			if got, want := shared.Stats().MaxOpenConnections, db.Stats().MaxOpenConnections; got != want {
				t.Fatalf("the shared pool allows %d connections, want the original's %d", got, want)
			}
		}

		// A row written through either handle is read through the other.
		scope := fmt.Sprintf("share-test-%d", time.Now().UnixNano())
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), "DELETE FROM token_policies WHERE scope_value LIKE $1", scope+"%")
		})
		mustExec(t, shared, "INSERT INTO token_policies (scope, scope_value) VALUES ('flavor', $1)", scope+"-a")
		mustExec(t, db, "INSERT INTO token_policies (scope, scope_value) VALUES ('flavor', $1)", scope+"-b")
		for name, h := range map[string]*storage.DB{"original": db, "shared": shared} {
			var n int
			if err := h.Reader().QueryRowContext(ctx, "SELECT COUNT(*) FROM token_policies WHERE scope_value LIKE $1", scope+"%").Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n != 2 {
				t.Errorf("the %s handle reads %d of the 2 rows", name, n)
			}
		}

		// Closing the shared handle leaves the original whole.
		if err := shared.Close(); err != nil {
			t.Fatalf("close the shared handle: %v", err)
		}
		mustExec(t, db, "INSERT INTO token_policies (scope, scope_value) VALUES ('flavor', $1)", scope+"-c")
		if n := queryInt(t, db, "SELECT COUNT(*) FROM token_policies WHERE scope_value LIKE $1", scope+"%"); n != 3 {
			t.Errorf("the original handle reads %d rows after the shared one closed, want 3", n)
		}
		if err := shared.Reader().PingContext(ctx); err == nil {
			t.Error("the shared handle's own pool still answers after its Close")
		}
	})
}

// SQLiteURL and SQLitePath are inverses for every path shape a data
// directory can have, Windows drive paths included: the URL carries the
// path verbatim, so no character is escaped on the way in or decoded on
// the way out.
func TestSQLiteURL_RoundTripsEveryPath(t *testing.T) {
	for _, path := range []string{
		"/var/lib/flightdeck/flightdeck.db",
		"relative/flightdeck.db",
		"/home/o m/My Documents/flightdeck.db",
		"/data/a#b/x?y/50%/%41/flightdeck.db",
		`C:\Users\omria\AppData\Local\flightdeck\flightdeck.db`,
		`C:\Users\O'Neil & Sons #1\AppData\Local\flightdeck\flightdeck.db`,
		"C:/Users/omria/AppData/Local/flightdeck/flightdeck.db",
		"/tmp/ünïcödé/flightdeck.db",
	} {
		url := storage.SQLiteURL(path)
		if got := storage.SQLitePath(url); got != path {
			t.Errorf("SQLitePath(SQLiteURL(%q)) = %q", path, got)
		}
		if b, err := storage.BackendOf(url); err != nil || b != storage.SQLite {
			t.Errorf("BackendOf(SQLiteURL(%q)) = %q, %v", path, b, err)
		}
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
