package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestBackup_WritesACheckedPrivateCopyAndNeverOverwrites(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 5)
	target := filepath.Join(t.TempDir(), "copy.db")
	c, err := Backup(context.Background(), db, target)
	if err != nil {
		t.Fatal(err)
	}
	if c.Path != target || c.File.Sessions != 5 || c.Bytes == 0 {
		t.Errorf("Backup = %+v", c)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("the copy's mode is %v (%v), want 0600", info.Mode().Perm(), err)
		}
	}
	before := files(t, filepath.Dir(target))
	if _, err := Backup(context.Background(), db, target); !errors.Is(err, errTaken) {
		t.Errorf("a second backup to the same file: %v, want it refused", err)
	}
	sameFiles(t, filepath.Dir(target), before)
}

// A backup of a database a server holds open copies what is still in
// its write-ahead log too.
func TestBackup_OfAnOpenDatabaseHoldsItsLog(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	open := newDatabase(t, db, 7)
	defer func() { _ = open.Close() }()
	c, err := Backup(context.Background(), db, filepath.Join(t.TempDir(), "copy.db"))
	if err != nil || c.File.Sessions != 7 {
		t.Fatalf("Backup of an open database: %+v, %v", c, err)
	}
}

func TestBackup_RefusesTheDatabaseItselfAndLeavesNothingOnFailure(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "flightdeck.db")
	closedDatabase(t, db, 1)
	before := files(t, dir)
	if _, err := Backup(context.Background(), db, db); err == nil {
		t.Error("a backup onto the database itself was written")
	}
	sameFiles(t, dir, before)

	notDB := filepath.Join(t.TempDir(), "notes.db")
	_ = os.WriteFile(notDB, []byte(strings.Repeat("text\n", 1000)), 0o600)
	out := t.TempDir()
	if _, err := Backup(context.Background(), notDB, filepath.Join(out, "copy.db")); err == nil {
		t.Error("a backup of a file that is not a database was written")
	}
	if entries, _ := os.ReadDir(out); len(entries) != 0 {
		t.Errorf("a failed backup left %d files", len(entries))
	}
}

func TestDefaultTarget_TakesTheNextNameInTheSameSecond(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "backups")
	now := time.Date(2026, 11, 19, 8, 0, 0, 0, time.UTC)
	first, err := DefaultTarget(dir, now)
	if err != nil || filepath.Base(first) != "flightdeck-20261119T080000Z.db" {
		t.Fatalf("DefaultTarget = %s, %v", first, err)
	}
	if info, err := os.Stat(dir); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o700) {
		t.Errorf("the backups directory: %v, %v", info, err)
	}
	_ = os.WriteFile(first, nil, 0o600)
	second, _ := DefaultTarget(dir, now)
	if filepath.Base(second) != "flightdeck-20261119T080000Z-2.db" {
		t.Errorf("the second name in the same second is %s", second)
	}
}
