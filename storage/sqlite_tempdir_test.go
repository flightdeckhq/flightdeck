package storage

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// spillRows and spillRowBytes size the table the spill test sorts: its
// sort keys come to about eight megabytes, four times the two megabytes
// of sorter memory a connection has with SQLite's default cache, so the
// sort must write its runs to a temporary file.
const (
	spillRows     = 60000
	spillRowBytes = 64
)

// tempDirTestTimeout bounds each statement of these tests. They take
// well under a second; the bound turns a hang into a failure.
const tempDirTestTimeout = 60 * time.Second

// withSQLiteTempDir names dir as SQLite's temporary directory for the
// test and restores SQLite's own choice after it.
func withSQLiteTempDir(t *testing.T, dir string) {
	t.Helper()
	SetSQLiteTempDir(dir)
	t.Cleanup(func() { SetSQLiteTempDir("") })
}

func openSQLiteForTest(t *testing.T) *DB {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), tempDirTestTimeout)
	defer cancel()
	db, err := Open(ctx, SQLiteURL(filepath.Join(t.TempDir(), "flightdeck.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// Every connection, the writer's and the read pool's, carries the
// directory, whatever characters its path has.
func TestSetSQLiteTempDir_EveryConnectionNamesTheDirectory(t *testing.T) {
	for _, name := range []string{"tmp", "tmp dir #1", "it's tmp", "50% tmp?"} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), name)
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			withSQLiteTempDir(t, dir)
			db := openSQLiteForTest(t)
			ctx, cancel := context.WithTimeout(context.Background(), tempDirTestTimeout)
			defer cancel()

			var got string
			if err := db.QueryRowContext(ctx, "PRAGMA temp_store_directory").Scan(&got); err != nil {
				t.Fatalf("writer: %v", err)
			}
			if got != dir {
				t.Errorf("writer: temp_store_directory = %q, want %q", got, dir)
			}
			got = ""
			if err := db.Reader().QueryRowContext(ctx, "PRAGMA temp_store_directory").Scan(&got); err != nil {
				t.Fatalf("reader: %v", err)
			}
			if got != dir {
				t.Errorf("reader: temp_store_directory = %q, want %q", got, dir)
			}
			// A handle another service of the process shares.
			shared, err := db.Share(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = shared.Close() }()
			got = ""
			if err := shared.Reader().QueryRowContext(ctx, "PRAGMA temp_store_directory").Scan(&got); err != nil {
				t.Fatalf("shared reader: %v", err)
			}
			if got != dir {
				t.Errorf("shared reader: temp_store_directory = %q, want %q", got, dir)
			}
		})
	}
}

// A directory that cannot hold files is refused when the database is
// opened, with SQLite's reason, not at the first large query.
func TestSetSQLiteTempDir_AMissingDirectoryFailsTheOpen(t *testing.T) {
	withSQLiteTempDir(t, filepath.Join(t.TempDir(), "absent"))
	ctx, cancel := context.WithTimeout(context.Background(), tempDirTestTimeout)
	defer cancel()
	db, err := Open(ctx, SQLiteURL(filepath.Join(t.TempDir(), "flightdeck.db")))
	if err == nil {
		_ = db.Close()
		t.Fatal("Open succeeded with a temporary directory that does not exist")
	}
	if !strings.Contains(err.Error(), "not a writable directory") {
		t.Fatalf("err = %v, want SQLite's \"not a writable directory\"", err)
	}
}

// openFilesUnder returns the process's open file descriptors whose
// target is directly inside dir, as "<descriptor> <target>". SQLite's
// temporary files have no name to list: they are opened unnamed
// (O_TMPFILE) or unlinked at once, so the descriptor is the only place
// one shows, as "<dir>/#<inode> (deleted)".
func openFilesUnder(t *testing.T, dir string) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, e := range entries {
		target, err := os.Readlink(filepath.Join("/proc/self/fd", e.Name()))
		if err != nil {
			continue // closed since the listing
		}
		if filepath.Dir(target) == dir {
			found[e.Name()+" "+target] = true
		}
	}
	return found
}

// A sort too large for memory writes its runs under the named
// directory. The statement is held open after its first row, when the
// sort has run and its temporary file is still open, and the process's
// own descriptors are read: the sort must have opened a file there.
// Without SetSQLiteTempDir the file is in SQLite's own choice
// (/var/tmp on Linux) and this test fails.
func TestSetSQLiteTempDir_ASortThatSpillsWritesThere(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc/self/fd, which only Linux has")
	}
	dir := filepath.Join(t.TempDir(), "tmp")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	withSQLiteTempDir(t, dir)
	db := openSQLiteForTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), tempDirTestTimeout)
	defer cancel()

	if _, err := db.ExecContext(ctx, "CREATE TABLE spill (x TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		 INSERT INTO spill (x) SELECT hex(randomblob(?)) FROM n`, spillRows, spillRowBytes/2); err != nil {
		t.Fatal(err)
	}

	before := openFilesUnder(t, dir)
	rows, err := db.Reader().QueryContext(ctx, "SELECT x FROM spill ORDER BY x")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		t.Fatalf("the sorted query returned no row: %v", rows.Err())
	}
	opened := 0
	for f := range openFilesUnder(t, dir) {
		if !before[f] {
			opened++
		}
	}
	if opened == 0 {
		t.Fatalf("sorting %d rows opened no file under %s: either the sort did not spill, or its temporary file is somewhere else", spillRows, dir)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Errorf("the temporary directory lists %d entries after the statement (err %v), want none", len(entries), err)
	}
}
