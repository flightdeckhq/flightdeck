package storage

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

// A dangling link's relative target is taken from the link's physical
// directory. lnk -> real/sub and real/sub/db -> ../../other/db: the
// kernel puts lnk/db at <base>/other/db. A lexical join of lnk/db's
// directory would give <root>/other/db, one level above <base>, which
// here exists as a decoy that must not be chosen.
func TestSQLiteRealPath_ARelativeTargetThroughALinkedDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symbolic link needs a privilege on Windows")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(root, "base")
	for _, dir := range []string{filepath.Join(base, "real", "sub"), filepath.Join(base, "other"), filepath.Join(root, "other")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	decoy := filepath.Join(root, "other", "db")
	if err := os.WriteFile(decoy, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("real", "sub"), filepath.Join(base, "lnk")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", "other", "db"), filepath.Join(base, "real", "sub", "db")); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(base, "other", "db")
	for _, name := range []string{filepath.Join(base, "lnk", "db"), filepath.Join(base, "real", "sub", "db"), want} {
		got, err := sqliteRealPath(name, symlinkDepthLimit)
		if err != nil || got != want {
			t.Errorf("sqliteRealPath(%s) = %q, %v; want %q (not the decoy %s)", name, got, err, want, decoy)
		}
	}
	// And the lock follows it: the link's name and the target's exclude
	// each other.
	requireExcluded(t, filepath.Join(base, "lnk", "db"), want)
}

// A chain of dangling links, each relative to its own directory, ends at
// the file the last one names; a loop is an error, not a hang.
func TestSQLiteRealPath_AChainOfDanglingLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symbolic link needs a privilege on Windows")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(base, "a", "b"), 0o700); err != nil {
		t.Fatal(err)
	}
	// first -> a/second, a/second -> b/third, a/b/third -> ../../final.db
	links := map[string]string{
		filepath.Join(base, "first"):           filepath.Join("a", "second"),
		filepath.Join(base, "a", "second"):     filepath.Join("b", "third"),
		filepath.Join(base, "a", "b", "third"): filepath.Join("..", "..", "final.db"),
	}
	for link, target := range links {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	got, err := sqliteRealPath(filepath.Join(base, "first"), symlinkDepthLimit)
	if want := filepath.Join(base, "final.db"); err != nil || got != want {
		t.Fatalf("sqliteRealPath = %q, %v; want %q", got, err, want)
	}
	// A chain longer than the limit is refused.
	if _, err := sqliteRealPath(filepath.Join(base, "first"), 1); err == nil || !strings.Contains(err.Error(), "too many symbolic links") {
		t.Fatalf("a chain over the limit: err = %v", err)
	}
	// A loop: loop1 -> loop2 -> loop1.
	if err := os.Symlink("loop2", filepath.Join(base, "loop1")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("loop1", filepath.Join(base, "loop2")); err != nil {
		t.Fatal(err)
	}
	if _, err := sqliteRealPath(filepath.Join(base, "loop1"), symlinkDepthLimit); err == nil {
		t.Fatal("a loop of links resolved")
	}
}
