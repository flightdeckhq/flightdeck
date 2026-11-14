package storage

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// realTempDir is a test's temp dir with its symbolic links resolved (it
// is itself behind a link on some systems).
func realTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// One database reached by different names is one database: a link to
// the file, a link to its directory, a link to a link and a relative
// link all resolve to the real path, a link to a file not created yet
// resolves to where SQLite will create it, and a relative name is made
// absolute.
func TestResolveSQLitePath_NamesOfOneFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symbolic link needs a privilege on Windows")
	}
	base := realTempDir(t)
	realData := filepath.Join(base, "d1")
	if err := os.Mkdir(realData, 0o700); err != nil {
		t.Fatal(err)
	}
	realDB := filepath.Join(realData, "flightdeck.db")
	if err := os.WriteFile(realDB, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	link := func(target, name string) string {
		t.Helper()
		path := filepath.Join(base, name)
		if err := os.Symlink(target, path); err != nil {
			t.Fatal(err)
		}
		return path
	}
	fileLink := link(realDB, "sym.db")
	dirLink := link(realData, "d1-link")
	chained := link(fileLink, "sym-of-sym.db")
	relative := link(filepath.Join("d1", "flightdeck.db"), "relative.db")

	for name, path := range map[string]string{
		"a link to the file":      fileLink,
		"a link to its directory": filepath.Join(dirLink, "flightdeck.db"),
		"a link to a link":        chained,
		"a relative link":         relative,
		"the real path":           realDB,
	} {
		if got, err := ResolveSQLitePath(path); err != nil || got != realDB {
			t.Errorf("%s: ResolveSQLitePath(%s) = %q, %v; want the real file %s", name, path, got, err, realDB)
		}
	}

	// A link to a file that does not exist yet resolves to where SQLite
	// will create it, not to the link; so does a file not created yet in
	// a linked directory.
	fresh := filepath.Join(realData, "fresh.db")
	dangling := link(fresh, "dangling.db")
	for _, path := range []string{dangling, filepath.Join(dirLink, "fresh.db")} {
		if got, err := ResolveSQLitePath(path); err != nil || got != fresh {
			t.Errorf("ResolveSQLitePath(%s) = %q, %v; want %s", path, got, err, fresh)
		}
	}

	// A relative name is taken from the working directory.
	t.Chdir(dirLink)
	if got, err := ResolveSQLitePath("flightdeck.db"); err != nil || got != realDB {
		t.Errorf("a relative name: %q, %v; want %s", got, err, realDB)
	}

	// A link that points at itself is refused, not followed forever.
	loop := link(filepath.Join(base, "loop.db"), "loop.db")
	if _, err := ResolveSQLitePath(loop); err == nil {
		t.Error("a link to itself was accepted")
	}
	// A database in a directory that does not exist is refused, and the
	// error names that directory.
	missing := filepath.Join(base, "no such dir")
	if _, err := ResolveSQLitePath(filepath.Join(missing, "x.db")); err == nil || !strings.Contains(err.Error(), missing) {
		t.Errorf("a database in a missing directory: %v, want an error naming %s", err, missing)
	}
}

// A dangling link's relative target is taken from the link's physical
// directory. lnk -> real/sub and real/sub/db -> ../../other/db: the
// kernel puts lnk/db at <base>/other/db. A lexical join of lnk/db's
// directory would give <root>/other/db, one level above <base>, which
// here exists as a decoy that must not be chosen.
func TestResolveSQLitePath_ARelativeTargetThroughALinkedDirectory(t *testing.T) {
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
		got, err := ResolveSQLitePath(name)
		if err != nil || got != want {
			t.Errorf("ResolveSQLitePath(%s) = %q, %v; want %q (not the decoy %s)", name, got, err, want, decoy)
		}
	}
	// And the lock follows it: the link's name and the target's exclude
	// each other.
	requireExcluded(t, filepath.Join(base, "lnk", "db"), want)
}

// A chain of dangling links, each relative to its own directory, ends at
// the file the last one names; a loop is an error, not a hang.
func TestResolveSQLitePath_AChainOfDanglingLinks(t *testing.T) {
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
	got, err := ResolveSQLitePath(filepath.Join(base, "first"))
	if want := filepath.Join(base, "final.db"); err != nil || got != want {
		t.Fatalf("ResolveSQLitePath = %q, %v; want %q", got, err, want)
	}
	// A chain longer than the limit is refused.
	if _, err := resolveSQLitePath(filepath.Join(base, "first"), 1); err == nil || !strings.Contains(err.Error(), "too many symbolic links") {
		t.Fatalf("a chain over the limit: err = %v", err)
	}
	// A loop: loop1 -> loop2 -> loop1.
	if err := os.Symlink("loop2", filepath.Join(base, "loop1")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("loop1", filepath.Join(base, "loop2")); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveSQLitePath(filepath.Join(base, "loop1")); err == nil {
		t.Fatal("a loop of links resolved")
	}
}
