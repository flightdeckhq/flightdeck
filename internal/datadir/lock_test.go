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
