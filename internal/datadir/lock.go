package datadir

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
)

// Lock is an exclusive hold on a lock file, taken with the operating
// system's advisory file lock (flock on Unix, LockFileEx on Windows).
// The kernel drops the lock when the process ends, however it ends, so
// a crash or a kill -9 never leaves a stale lock behind: the file may
// remain, and the next start takes the lock on it. A PID file could not
// promise that.
type Lock struct {
	f *os.File
}

// InUseError is returned by Acquire when another process holds the lock.
type InUseError struct {
	// Path is the lock file.
	Path string
	// PID is the process that wrote the lock file, or 0 when the file
	// could not be read (the holder writes its PID after it has the
	// lock, so a reader racing a starting holder may find none).
	PID int
}

func (e *InUseError) Error() string {
	if e.PID > 0 {
		return fmt.Sprintf("%s is locked by another process (pid %d)", e.Path, e.PID)
	}
	return fmt.Sprintf("%s is locked by another process", e.Path)
}

// Acquire takes the lock on path, creating the file (mode 0600) when it
// does not exist, and writes this process's PID into it so that a
// process refused later can name the holder. It never waits: when
// another process holds the lock it returns an *InUseError at once.
// Release, or the end of the process, gives the lock up.
func Acquire(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock file %s: %w", path, err)
	}
	if err := lockFile(f); err != nil {
		inUse := errors.Is(err, errLocked)
		pid := 0
		if inUse {
			pid = readPID(f)
		}
		_ = f.Close()
		if inUse {
			return nil, &InUseError{Path: path, PID: pid}
		}
		return nil, fmt.Errorf("lock %s: %w (the directory must be on a filesystem that supports file locks, such as a local disk)", path, err)
	}
	// The PID is for the message only; the lock is what excludes. A
	// failed write leaves the lock held and the file empty.
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	return &Lock{f: f}, nil
}

// Release gives the lock up and closes the file. The file itself stays:
// removing it would let a process that opened it a moment earlier lock
// a file no later process can see.
func (l *Lock) Release() {
	if l == nil || l.f == nil {
		return
	}
	_ = unlockFile(l.f)
	_ = l.f.Close()
	l.f = nil
}

// pidMaxDigits bounds how much of a lock file is read for the holder's
// PID: a PID is at most ten decimal digits on every supported system.
const pidMaxDigits = 10

func readPID(f *os.File) int {
	buf := make([]byte, pidMaxDigits+1)
	n, _ := f.ReadAt(buf, 0)
	pid, err := strconv.Atoi(string(bytes.TrimSpace(buf[:n])))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// errLocked is what lockFile returns when another process holds the lock.
var errLocked = errors.New("locked by another process")
