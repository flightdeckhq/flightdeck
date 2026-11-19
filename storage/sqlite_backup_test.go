package storage_test

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// migratedSQLite is a SQLite database migrated to the newest schema in
// a temporary directory, open, with its path.
func migratedSQLite(t *testing.T) (*storage.DB, string) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "flightdeck.db")
	if err := storage.Migrate(ctx, storage.SQLiteURL(path)); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(ctx, storage.SQLiteURL(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, path
}

// emptyPrivateFile creates the empty 0600 file a snapshot is written
// into, as the backup command does.
func emptyPrivateFile(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A snapshot taken while another connection keeps writing is the
// database as of one moment: it passes integrity_check, its rows are an
// unbroken prefix of what was written (a torn copy would miss rows in
// the middle or hold half a transaction), and it holds what was still
// in the write-ahead log at that moment.
func TestSQLiteSnapshot_IsOneMomentOfADatabaseThatIsBeingWritten(t *testing.T) {
	ctx := context.Background()
	db, path := migratedSQLite(t)
	mustExec(t, db, `CREATE TABLE snap_rows (id INTEGER PRIMARY KEY, pair INTEGER NOT NULL)`)
	var written atomic.Int64
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		for i := int64(1); ; i++ {
			select {
			case <-stop:
				done <- nil
				return
			default:
			}
			// Two rows per transaction: a snapshot holds both or neither.
			tx, err := db.BeginTx(ctx, nil)
			if err == nil {
				_, err = tx.ExecContext(ctx, `INSERT INTO snap_rows (id, pair) VALUES (?, ?), (?, ?)`, 2*i-1, i, 2*i, i)
			}
			if err == nil {
				err = tx.Commit()
			}
			if err != nil {
				done <- err
				return
			}
			written.Store(2 * i)
		}
	}()
	for written.Load() < 2000 {
		time.Sleep(5 * time.Millisecond)
	}
	if info, err := os.Stat(path + "-wal"); err != nil || info.Size() == 0 {
		t.Fatalf("the test needs rows in the write-ahead log: %v", err)
	}
	out := filepath.Join(t.TempDir(), "snapshot.db")
	emptyPrivateFile(t, out)
	if err := storage.SQLiteSnapshot(ctx, path, out); err != nil {
		t.Fatal(err)
	}
	close(stop)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	f, err := storage.CheckSQLiteFile(ctx, out, storage.CheckFull)
	latest, _ := storage.LatestVersion(storage.SQLite)
	if err != nil || f.Version != latest || f.Dirty {
		t.Fatalf("the snapshot reads as %+v, %v; want version %d, clean", f, err, latest)
	}
	// One file: nothing beside it, after the snapshot and its read-only
	// check (the Open below would give it a write-ahead log of its own).
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(out + suffix); err == nil {
			t.Errorf("the snapshot has a %s beside it: it is not one file", suffix)
		}
	}
	snap, err := storage.Open(ctx, storage.SQLiteURL(out))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = snap.Close() }()
	n := queryInt(t, snap, `SELECT count(*) FROM snap_rows`)
	maxID := queryInt(t, snap, `SELECT coalesce(max(id), 0) FROM snap_rows`)
	unpaired := queryInt(t, snap, `SELECT count(*) FROM (SELECT pair FROM snap_rows GROUP BY pair HAVING count(*) != 2)`)
	if n == 0 || n != maxID || n%2 != 0 || unpaired != 0 || int64(n) > written.Load() {
		t.Errorf("the snapshot holds %d rows up to id %d (%d half transactions) of %d written: not one moment", n, maxID, unpaired, written.Load())
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(out); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("the snapshot's mode is %v (%v), want the 0600 of the file it was written into", info.Mode().Perm(), err)
		}
	}
}

// A database whose last writes are only in its write-ahead log, with no
// process holding it (a server that was killed), is copied whole, and
// its log is left as it was.
func TestSQLiteSnapshot_ACrashedDatabaseIsCopiedWithItsLog(t *testing.T) {
	ctx := context.Background()
	db, path := migratedSQLite(t)
	mustExec(t, db, `CREATE TABLE crash_rows (id INTEGER PRIMARY KEY)`)
	for i := 1; i <= 50; i++ {
		mustExec(t, db, `INSERT INTO crash_rows (id) VALUES (?)`, i)
	}
	crashed := filepath.Join(t.TempDir(), "crashed.db")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		data, err := os.ReadFile(path + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(crashed+suffix, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	walBefore, _ := os.ReadFile(crashed + "-wal")
	out := filepath.Join(t.TempDir(), "out.db")
	if err := storage.SQLiteSnapshot(ctx, crashed, out); err != nil {
		t.Fatal(err)
	}
	snap, err := storage.Open(ctx, storage.SQLiteURL(out))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = snap.Close() }()
	if n := queryInt(t, snap, `SELECT count(*) FROM crash_rows`); n != 50 {
		t.Errorf("the copy of a crashed database holds %d of its 50 rows", n)
	}
	if walAfter, _ := os.ReadFile(crashed + "-wal"); string(walAfter) != string(walBefore) {
		t.Error("the snapshot changed the source's write-ahead log")
	}
}

func TestSQLiteSnapshot_RefusesAFileThatHoldsSomething(t *testing.T) {
	_, path := migratedSQLite(t)
	out := filepath.Join(t.TempDir(), "taken.db")
	if err := os.WriteFile(out, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := storage.SQLiteSnapshot(context.Background(), path, out); err == nil {
		t.Error("a snapshot was written over a file that holds something")
	}
	if data, _ := os.ReadFile(out); string(data) != "mine" {
		t.Errorf("the file was changed to %d bytes", len(data))
	}
}

func TestCheckSQLiteFile_SaysWhatAFileIs(t *testing.T) {
	ctx := context.Background()
	db, path := migratedSQLite(t)
	mustExec(t, db, `INSERT INTO sessions (session_id, flavor, agent_type) VALUES ('11111111-1111-4111-8111-111111111111', 'f', 'coding')`)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	latest, _ := storage.LatestVersion(storage.SQLite)
	f, err := storage.CheckSQLiteFile(ctx, path, storage.CheckFull)
	if err != nil || f.Version != latest || f.Sessions != 1 || f.Events != 0 {
		t.Fatalf("a migrated database reads as %+v, %v", f, err)
	}

	dir := t.TempDir()
	text := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(text, []byte(strings.Repeat("not a database\n", 400)), 0o600)
	if _, err := storage.CheckSQLiteFile(ctx, text, storage.CheckFull); !errors.Is(err, storage.ErrNotSQLite) {
		t.Errorf("a text file: %v, want ErrNotSQLite", err)
	}

	whole, _ := os.ReadFile(path)
	truncated := filepath.Join(dir, "truncated.db")
	_ = os.WriteFile(truncated, whole[:len(whole)/2], 0o600)
	var damaged *storage.DamagedError
	if _, err := storage.CheckSQLiteFile(ctx, truncated, storage.CheckFull); !errors.As(err, &damaged) {
		t.Errorf("a truncated database: %v, want a DamagedError", err)
	}

	bare := filepath.Join(dir, "bare.db")
	plain, err := storage.Open(ctx, storage.SQLiteURL(bare))
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, plain, `CREATE TABLE something (x INTEGER)`)
	_ = plain.Close()
	if _, err := storage.CheckSQLiteFile(ctx, bare, storage.CheckFull); !errors.Is(err, storage.ErrNoSchema) {
		t.Errorf("a SQLite database of something else: %v, want ErrNoSchema", err)
	}

	if _, err := storage.CheckSQLiteFile(ctx, filepath.Join(dir, "missing.db"), storage.CheckOpens); err == nil {
		t.Error("a file that is not there was checked")
	}
	if _, err := os.Stat(filepath.Join(dir, "missing.db")); !errors.Is(err, fs.ErrNotExist) {
		t.Error("checking a missing file created it")
	}
}

func TestLatestVersion_IsTheNewestMigrationOfEachBackend(t *testing.T) {
	for _, b := range []storage.Backend{storage.SQLite, storage.Postgres} {
		fsys, err := storage.MigrationsFS(b)
		if err != nil {
			t.Fatal(err)
		}
		names, _ := fs.Glob(fsys, "*.up.sql")
		var want uint
		for _, name := range names {
			v, _ := strconv.ParseUint(name[:6], 10, 32)
			want = max(want, uint(v))
		}
		if got, err := storage.LatestVersion(b); err != nil || got != want || got == 0 {
			t.Errorf("LatestVersion(%s) = %d, %v; want %d", b, got, err, want)
		}
	}
}

// A database a newer release migrated is refused in words that name both
// versions and the ways out, not with golang-migrate's "no migration
// found"; the database is left as it was.
func TestMigrate_RefusesANewerSchemaInWords(t *testing.T) {
	ctx := context.Background()
	db, path := migratedSQLite(t)
	latest, _ := storage.LatestVersion(storage.SQLite)
	mustExec(t, db, `UPDATE schema_migrations SET version = ?`, latest+1)
	err := storage.Migrate(ctx, storage.SQLiteURL(path))
	var newer *storage.NewerSchemaError
	if !errors.As(err, &newer) || newer.Version != latest+1 || newer.Latest != latest {
		t.Fatalf("Migrate on a newer schema: %v", err)
	}
	for _, want := range []string{fmt.Sprintf("version %d", latest+1), fmt.Sprintf("up to %d", latest),
		"Install that release", "flightdeck restore"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the message lacks %q: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "no migration found") {
		t.Errorf("the message is golang-migrate's: %v", err)
	}
	if v := queryInt(t, db, `SELECT version FROM schema_migrations`); v != int(latest+1) {
		t.Errorf("the refused migration changed the version to %d", v)
	}
}
