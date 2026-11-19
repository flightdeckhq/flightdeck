//go:build unix

package backup

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

// A backups/ the server's user cannot write in (one a root container's
// install -D made on a volume) is named with its owner and mode, and the
// user and the command that fix it, by flightdeck backup and in the
// warning of a start whose copy before a migration was skipped for it.
func TestABackupsDirThatCannotBeWrittenIsNamedWithItsOwner(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes in any directory")
	}
	data := t.TempDir()
	db := filepath.Join(data, datadir.DatabaseFile)
	closedDatabase(t, db, 2)
	backups := filepath.Join(data, datadir.BackupsDir)
	if err := os.Mkdir(backups, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(backups, 0o700) })
	uid := strconv.Itoa(os.Getuid())
	want := []string{
		backups + " cannot be written by the user flightdeck runs as (uid " + uid + ")",
		"it belongs to uid " + uid + " (gid " + strconv.Itoa(os.Getgid()) + "), mode dr-xr-xr-x",
		"chown " + uid + ":" + strconv.Itoa(os.Getgid()) + " " + backups + ", as root",
	}

	var c cmdRun
	if code := c.main("backup", "--data-dir", data); code != ExitFailed {
		t.Fatalf("a backup into a directory it cannot write exited %d:\n%s", code, c.output())
	}
	for _, w := range append(want, "Nothing was written") {
		if !strings.Contains(c.stderr.String(), w) {
			t.Errorf("flightdeck backup does not say %q:\n%s", w, c.output())
		}
	}

	b := BeforeMigration(context.Background(), db, backups, "v0.12.0", testNow)
	if b.Copy.Path != "" || !strings.HasPrefix(b.Skipped, "no copy was taken before migrating: "+want[0]) {
		t.Errorf("the copy before a migration: %+v", b)
	}
	for _, w := range want[1:] {
		if !strings.Contains(b.Skipped, w) {
			t.Errorf("the start-up warning does not say %q: %s", w, b.Skipped)
		}
	}
	if entries, _ := os.ReadDir(backups); len(entries) != 0 {
		t.Errorf("files were left in %s: %v", backups, entries)
	}

	// A data dir in which backups/ cannot be made is named the same way.
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.Mkdir(locked, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })
	if _, err := DefaultTarget(filepath.Join(locked, datadir.BackupsDir), testNow); err == nil ||
		!strings.HasPrefix(err.Error(), locked+" cannot be written by the user flightdeck runs as") {
		t.Errorf("a backups directory that cannot be made: %v", err)
	}
}
