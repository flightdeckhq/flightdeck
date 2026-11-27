package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/backup"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

// stopOrKill stops a child cleanly where it can be sent SIGINT, and
// kills it on Windows, where it cannot: the database is then left with
// its write-ahead log, as a crash leaves it.
func (c *child) stopOrKill(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		_ = c.cmd.Process.Kill()
		<-c.done
		c.done <- nil
		return
	}
	if err := c.stop(t, syscall.SIGINT); err != nil {
		t.Fatalf("the binary's stop: %v\n%s", err, c.out.String())
	}
}

// A backup taken while the binary serves holds what it had stored; a
// restore is refused while the binary runs, and once it has stopped, the
// backup restored into its data dir and into a new one is served by the
// binary started on each. On Windows, where the binary is killed rather
// than stopped, the old data dir keeps a write-ahead log, which the
// restore must move aside with the database it replaces.
func TestBinary_BackupWhileServingThenRestore(t *testing.T) {
	ctx := context.Background()
	dataDir := tempDir(t)
	port := freePort(t)
	listen := "127.0.0.1:" + port
	c := start(t, listen, port, dataDir)
	token := c.dashboardToken(t)
	flavor := "backup-test-" + newUUID(t)[:8]
	sid, agent := newUUID(t), newUUID(t)
	c.postEvent(t, token, sid, agent, flavor, "session_start")
	c.postEvent(t, token, sid, agent, flavor, "post_call")
	waitFor(t, "the two events to be stored", storeTimeout, func() bool { return c.storedEvents(t, token, flavor) == 2 })

	file := filepath.Join(tempDir(t), "backup.db")
	code, out := runToExit(t, nil, "backup", "--data-dir", dataDir, file)
	if code != backup.ExitOK || !strings.Contains(out, "checked") {
		t.Fatalf("backup while serving exited %d:\n%s", code, out)
	}
	if f, err := storage.CheckSQLiteFile(ctx, file, storage.CheckFull); err != nil || f.Events != 2 {
		t.Fatalf("the backup holds %+v, %v; want the 2 events stored", f, err)
	}
	// One more event after the backup, which the restore must take away.
	c.postEvent(t, token, sid, agent, flavor, "post_call")
	waitFor(t, "the third event to be stored", storeTimeout, func() bool { return c.storedEvents(t, token, flavor) == 3 })

	code, out = runToExit(t, nil, "restore", file, "--data-dir", dataDir)
	if code != backup.ExitInUse || !strings.Contains(out, fmt.Sprintf("pid %d", c.cmd.Process.Pid)) {
		t.Fatalf("a restore while the binary runs exited %d:\n%s", code, out)
	}
	c.stopOrKill(t)

	for name, dir := range map[string]string{"its own data dir": dataDir, "a new data dir": filepath.Join(tempDir(t), "new")} {
		code, out := runToExit(t, nil, "restore", file, "--data-dir", dir)
		if code != backup.ExitOK {
			t.Fatalf("restore into %s exited %d:\n%s", name, code, out)
		}
		if _, err := os.Stat(filepath.Join(dir, datadir.DatabaseFile+"-wal")); err == nil {
			t.Errorf("restore into %s left a write-ahead log under the database's name", name)
		}
		r := start(t, listen, port, dir)
		if got := r.storedEvents(t, r.dashboardToken(t), flavor); got != 2 {
			t.Errorf("the binary on %s serves %d events, want the backup's 2", name, got)
		}
		r.stopOrKill(t)
	}
	replaced, _ := filepath.Glob(filepath.Join(dataDir, datadir.DatabaseFile+".replaced-*"))
	if len(replaced) == 0 {
		t.Fatalf("the restore kept no replaced database in %s", dataDir)
	}
	if f, err := storage.CheckSQLiteFile(ctx, replaced[0], storage.CheckFull); err != nil || f.Events != 3 {
		t.Errorf("the replaced database holds %+v, %v; want the 3 events it had", f, err)
	}
}

// A start on a SQLite database one migration behind keeps a copy of it,
// at its old version, before it migrates, and says so in the start-up
// block; a start with nothing to migrate copies nothing.
func TestBinary_KeepsACopyOfTheDatabaseBeforeMigratingIt(t *testing.T) {
	skipWithoutSignals(t)
	ctx := context.Background()
	dataDir := tempDir(t)
	latest, err := storage.LatestVersion(storage.SQLite)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.MigrateTo(ctx, storage.SQLiteURL(filepath.Join(dataDir, datadir.DatabaseFile)), latest-1); err != nil {
		t.Fatal(err)
	}
	// Runs with events, for the start to gather the planner's
	// statistics of.
	fillRuns(t, filepath.Join(dataDir, datadir.DatabaseFile))
	port := freePort(t)
	c := start(t, "127.0.0.1:"+port, port, dataDir)
	want := fmt.Sprintf("(schema version %d, kept before this start migrated it to %d)", latest-1, latest)
	if !strings.Contains(c.out.String(), "  Backup      ") || !strings.Contains(c.out.String(), want) {
		t.Errorf("the start-up block does not name the copy:\n%s", c.out.String())
	}
	if err := c.stop(t, syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	copies := backup.BeforeCopies(filepath.Join(dataDir, datadir.BackupsDir))
	if len(copies) != 1 {
		t.Fatalf("copies before the migration: %v", copies)
	}
	if f, err := storage.CheckSQLiteFile(ctx, copies[0], storage.CheckFull); err != nil || f.Version != latest-1 {
		t.Errorf("the copy reads as %+v, %v; want version %d", f, err, latest-1)
	}
	if v, _, err := storage.SchemaVersion(ctx, storage.SQLiteURL(filepath.Join(dataDir, datadir.DatabaseFile))); err != nil || v != latest {
		t.Errorf("the database is at version %d (%v) after the start, want %d", v, err, latest)
	}
	// The statistics are gathered after the copy and the migrations:
	// the copy is the file the release before left, and the migrated
	// database has them.
	if n := statisticsRows(t, copies[0]); n != 0 {
		t.Errorf("the copy before migrating holds %d rows of planner statistics; it was taken after they were gathered", n)
	}
	if n := statisticsRows(t, filepath.Join(dataDir, datadir.DatabaseFile)); n == 0 {
		t.Error("the migrated database holds no planner statistics after the start")
	}

	again := start(t, "127.0.0.1:"+port, port, dataDir)
	if strings.Contains(again.out.String(), "  Backup      ") {
		t.Errorf("a start with nothing to migrate names a copy:\n%s", again.out.String())
	}
	if err := again.stop(t, syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	if copies := backup.BeforeCopies(filepath.Join(dataDir, datadir.BackupsDir)); len(copies) != 1 {
		t.Errorf("a start with nothing to migrate added a copy: %v", copies)
	}
}

// A start on a database a newer release migrated refuses in words, and
// names the copies kept before earlier migrations.
func TestBinary_RefusesADatabaseANewerReleaseMigrated(t *testing.T) {
	ctx := context.Background()
	dataDir := tempDir(t)
	db := filepath.Join(dataDir, datadir.DatabaseFile)
	latest, _ := storage.LatestVersion(storage.SQLite)
	if err := storage.Migrate(ctx, storage.SQLiteURL(db)); err != nil {
		t.Fatal(err)
	}
	// A copy kept before an earlier migration, as a start keeps one.
	kept := backup.BeforeMigration(ctx, db, filepath.Join(dataDir, datadir.BackupsDir), "v0.11.0", time.Now()).Copy.Path
	if kept == "" {
		t.Fatal("no copy was kept")
	}
	h, err := storage.Open(ctx, storage.SQLiteURL(db))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.ExecContext(ctx, `UPDATE schema_migrations SET version = ?`, latest+1); err != nil {
		t.Fatal(err)
	}
	_ = h.Close()
	code, out := runToExit(t, nil, "--port", freePort(t), "--data-dir", dataDir)
	if code != 1 {
		t.Fatalf("the start exited %d:\n%s", code, out)
	}
	for _, want := range []string{fmt.Sprintf("version %d", latest+1), fmt.Sprintf("up to %d", latest), "Install that release", kept} {
		if !strings.Contains(out, want) {
			t.Errorf("the refusal lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "no migration found") {
		t.Errorf("the refusal is golang-migrate's:\n%s", out)
	}
}

// A start that finds no database but the one a restore replaced and did
// not put back refuses, naming it and the command that restores it, and
// creates no empty database in its place.
func TestBinary_DoesNotStartAnEmptyDatabaseInPlaceOfAReplacedOne(t *testing.T) {
	ctx := context.Background()
	dataDir := tempDir(t)
	db := filepath.Join(dataDir, datadir.DatabaseFile)
	replaced := db + ".replaced-20261119T093000Z"
	if err := storage.Migrate(ctx, storage.SQLiteURL(replaced)); err != nil {
		t.Fatal(err)
	}
	code, out := runToExit(t, nil, "--port", freePort(t), "--data-dir", dataDir)
	if code != 1 || !strings.Contains(out, "does not start") || !strings.Contains(out, "flightdeck restore "+replaced) {
		t.Fatalf("the start exited %d:\n%s", code, out)
	}
	if _, err := os.Stat(db); err == nil {
		t.Error("the refused start created an empty database")
	}
}

// fillRuns writes runs with events into the SQLite database at path.
func fillRuns(t *testing.T, path string) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, storage.SQLiteURL(path))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49)
			INSERT INTO sessions (session_id, flavor, agent_type, state)
			SELECT printf('%08x-0000-4000-8000-%012x', i, i), 'f', 'coding', 'closed' FROM n`,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
			INSERT INTO events (id, session_id, flavor, event_type, occurred_at)
			SELECT printf('%08x-0000-4000-8000-%012x', 100000 + i, 100000 + i),
			       printf('%08x-0000-4000-8000-%012x', i / 20, i / 20), 'f', 'post_call',
			       strftime('%Y-%m-%dT%H:%M:%fZ', '2026-11-01', '+' || i || ' seconds')
			FROM n`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
}

// statisticsRows counts the planner statistics the SQLite database at
// path holds, 0 when it has none. The file is opened read-only and
// immutable: a copy kept before a migration must stay as it was
// recorded.
func statisticsRows(t *testing.T, path string) int {
	t.Helper()
	db, err := sql.Open("flightdeck-sqlite", "file:"+path+"?mode=ro&immutable=1")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var tables int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_stat1'`).Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if tables == 0 {
		return 0
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_stat1`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
