package datadir

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestCreatePrivate_CreatesAnEmptyPrivateFileAndKeepsAnExistingOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flightdeck.db")
	if err := CreatePrivate(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 0 {
		t.Fatalf("new file has %d bytes, want none", info.Size())
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %04o, want 0600", info.Mode().Perm())
	}

	if err := os.WriteFile(path, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CreatePrivate(path); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); string(data) != "existing" {
		t.Fatalf("an existing file was changed: %q", data)
	}

	if err := CreatePrivate(filepath.Join(t.TempDir(), "missing", "flightdeck.db")); err == nil {
		t.Fatal("a file in a directory that does not exist must be refused")
	}
}

func TestAcquire_ExcludesASecondHolderUntilReleased(t *testing.T) {
	path := filepath.Join(t.TempDir(), LockFile)
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("lock file mode %04o, want 0600", info.Mode().Perm())
	}
	if data, _ := os.ReadFile(path); strings.TrimSpace(string(data)) != strconv.Itoa(os.Getpid()) {
		t.Fatalf("lock file holds %q, want this process's pid %d", data, os.Getpid())
	}

	// The lock belongs to the open file, so a second open is refused
	// even from the same process, and the error names the holder.
	_, err = Acquire(path)
	var inUse *InUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("second Acquire: %v, want an *InUseError", err)
	}
	if inUse.Path != path || inUse.PID != os.Getpid() {
		t.Fatalf("%+v, want path %q and pid %d", inUse, path, os.Getpid())
	}
	if !strings.Contains(inUse.Error(), strconv.Itoa(os.Getpid())) {
		t.Fatalf("message %q does not name the holder", inUse.Error())
	}

	first.Release()
	first.Release() // a second Release is a no-op
	second, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire after Release: %v", err)
	}
	second.Release()
}

// A lock file left behind by a process that is gone (the file exists,
// nobody holds the lock) does not stop the next start, whatever PID it
// names.
func TestAcquire_TakesOverALockFileNobodyHolds(t *testing.T) {
	path := filepath.Join(t.TempDir(), LockFile)
	if err := os.WriteFile(path, []byte("999999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := Acquire(path)
	if err != nil {
		t.Fatalf("a stale lock file refused the start: %v", err)
	}
	defer l.Release()
	if data, _ := os.ReadFile(path); strings.TrimSpace(string(data)) != strconv.Itoa(os.Getpid()) {
		t.Fatalf("lock file holds %q after the takeover", data)
	}
}

func TestAcquire_ReportsAnUnusablePath(t *testing.T) {
	_, err := Acquire(filepath.Join(t.TempDir(), "missing", LockFile))
	var inUse *InUseError
	if err == nil || errors.As(err, &inUse) {
		t.Fatalf("err = %v, want an open error that is not InUseError", err)
	}
}

func TestInUseError_WithoutAPID(t *testing.T) {
	msg := (&InUseError{Path: "/x/flightdeck.lock"}).Error()
	if !strings.Contains(msg, "/x/flightdeck.lock") || strings.Contains(msg, "pid") {
		t.Fatalf("%q", msg)
	}
}

// caseInsensitive reports whether dir is on a filesystem that looks
// names up without regard to case (the default on macOS and Windows).
func caseInsensitive(t *testing.T, dir string) bool {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "case-probe"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := os.Stat(filepath.Join(dir, "CASE-PROBE"))
	return err == nil
}

// On a filesystem that ignores case, two spellings of a path that
// differ only in case are one file, so they are one lock file and the
// second holder is refused whichever spelling it uses: the lock needs
// no path comparison of its own. The test runs where the temp dir is
// on such a filesystem (macOS, Windows) and skips elsewhere. It does
// not hold on WSL's 9p mount of a Windows drive, where flock follows
// the spelling; that mount cannot hold a data dir at all.
func TestAcquire_SpellingsThatDifferInCaseAreOneLockWhereTheFilesystemIgnoresCase(t *testing.T) {
	dir := t.TempDir()
	if !caseInsensitive(t, dir) {
		t.Skip("the temp dir is on a case-sensitive filesystem")
	}
	first, err := Acquire(filepath.Join(dir, "flightdeck.db.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	for _, spelling := range []string{"FLIGHTDECK.DB.LOCK", "Flightdeck.db.lock", "flightdeck.DB.lock"} {
		second, err := Acquire(filepath.Join(dir, spelling))
		var inUse *InUseError
		if !errors.As(err, &inUse) {
			if second != nil {
				second.Release()
			}
			t.Fatalf("Acquire(%s) while flightdeck.db.lock is held: %v, want an *InUseError", spelling, err)
		}
		if inUse.PID != os.Getpid() {
			t.Errorf("Acquire(%s): holder pid %d, want %d", spelling, inUse.PID, os.Getpid())
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	locks := 0
	for _, e := range entries {
		if strings.EqualFold(e.Name(), "flightdeck.db.lock") {
			locks++
		}
	}
	if locks != 1 {
		t.Fatalf("%d lock files for one name spelled four ways, want 1", locks)
	}
}

func TestHolder_SaysWhoHoldsALockAndWritesNothing(t *testing.T) {
	if !LockSupported {
		t.Skip("this platform has no file lock")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, LockFile)

	pid, held, err := Holder(path)
	if err != nil || held || pid != 0 {
		t.Fatalf("Holder of a missing file = %d, %v, %v; want not held", pid, held, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("Holder created the lock file (%v)", err)
	}

	lock, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, held, err = Holder(path)
	if err != nil || !held || pid != os.Getpid() {
		t.Fatalf("Holder of a held lock = %d, %v, %v; want held by pid %d", pid, held, err, os.Getpid())
	}
	lock.Release()

	// Released: the file still names the last holder, which LockPID
	// reads and Holder does not take for a holder.
	if err := os.WriteFile(path, []byte("12345\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	pid, held, err = Holder(path)
	if err != nil || held || pid != 0 {
		t.Fatalf("Holder of a released lock = %d, %v, %v; want not held", pid, held, err)
	}
	if data, _ := os.ReadFile(path); string(data) != "12345\n" {
		t.Fatalf("Holder changed the lock file to %q", data)
	}
	if got := LockPID(path); got != 12345 {
		t.Fatalf("LockPID = %d, want 12345", got)
	}
	if got := LockPID(filepath.Join(dir, "missing")); got != 0 {
		t.Fatalf("LockPID of a missing file = %d, want 0", got)
	}
	// Holder gave its moment of the lock back: Acquire succeeds.
	again, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire after Holder: %v", err)
	}
	again.Release()
}
