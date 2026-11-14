package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// pathLockWait is how long a second migrator is given while the first
// holds the lock under another name for the same file: it must still be
// waiting when this ends.
const pathLockWait = 300 * time.Millisecond

// requireExcluded takes the migration lock through first, then asks for
// it through second, which names the same database file, and requires
// the second to wait rather than be granted it.
func requireExcluded(t *testing.T, first, second string) {
	t.Helper()
	release, err := lockSQLiteMigrations(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), pathLockWait)
	defer cancel()
	again, err := lockSQLiteMigrations(ctx, second)
	if err == nil {
		again()
		t.Fatalf("the migration lock was granted through %s while held through %s: two migrators would run", second, first)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the wait to end with its context", err)
	}
}

func TestLockSQLiteMigrations_ASymbolicLinkIsTheSameDatabase(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symbolic link needs a privilege on Windows")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "target.db")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.db")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	requireExcluded(t, target, link)
	requireExcluded(t, link, target)
	// A link to the directory, as when the data dir itself is a link.
	linkedDir := filepath.Join(t.TempDir(), "data")
	if err := os.Symlink(dir, linkedDir); err != nil {
		t.Fatal(err)
	}
	requireExcluded(t, target, filepath.Join(linkedDir, "target.db"))
	// One lock file, beside the target database.
	if _, err := os.Stat(target + migrateLockSuffix); err != nil {
		t.Fatalf("no lock file beside the target database: %v", err)
	}
	if _, err := os.Lstat(link + migrateLockSuffix); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a lock file was created beside the link (lstat: %v)", err)
	}
}

// A link to a database that does not exist yet: the first migration
// creates it at the link's target.
func TestLockSQLiteMigrations_ALinkToADatabaseNotYetCreated(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symbolic link needs a privilege on Windows")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "target.db")
	link := filepath.Join(dir, "link.db")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	requireExcluded(t, link, target)
}

// A hard link has no path to resolve. In one process the lock still
// recognises the file; across processes the lock files differ (see
// Migrate's doc comment).
func TestLockSQLiteMigrations_AHardLinkInTheSameProcess(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.db")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	hard := filepath.Join(dir, "hard.db")
	if err := os.Link(target, hard); err != nil {
		t.Skipf("no hard links here: %v", err)
	}
	requireExcluded(t, target, hard)
	requireExcluded(t, hard, target)
}

func TestLockSQLiteMigrations_TwoFilesDoNotWaitForEachOther(t *testing.T) {
	dir := t.TempDir()
	release, err := lockSQLiteMigrations(context.Background(), filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), lockTestTimeout)
	defer cancel()
	other, err := lockSQLiteMigrations(ctx, filepath.Join(dir, "b.db"))
	if err != nil {
		t.Fatalf("a second database's lock waited for the first's: %v", err)
	}
	other()
}
