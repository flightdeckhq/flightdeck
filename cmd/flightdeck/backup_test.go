package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"

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
	h, err := storage.Open(ctx, storage.SQLiteURL(db))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.ExecContext(ctx, `UPDATE schema_migrations SET version = ?`, latest+1); err != nil {
		t.Fatal(err)
	}
	_ = h.Close()
	kept := filepath.Join(dataDir, datadir.BackupsDir, "before-v0.11.0-20261101T000000Z.db")
	if err := os.MkdirAll(filepath.Dir(kept), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(kept, nil, 0o600); err != nil {
		t.Fatal(err)
	}
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
