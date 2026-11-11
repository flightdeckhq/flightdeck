//go:build windows

package datadir

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// LockSupported reports that Acquire excludes a second process on this
// platform.
const LockSupported = true

// lockOffsetHigh places the locked byte at offset 4 GiB, far past the
// PID the holder writes at offset 0. Windows file locks are mandatory:
// a locked range cannot be read by another process, and the process
// that is refused the lock reads the PID to name the holder. Windows
// allows locking a range beyond the end of the file.
const lockOffsetHigh = 1

func lockRange() *windows.Overlapped {
	return &windows.Overlapped{OffsetHigh: lockOffsetHigh}
}

// lockFile takes an exclusive lock on one byte of f without waiting.
func lockFile(f *os.File) error {
	err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, lockRange())
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
		return errLocked
	}
	return err
}

func unlockFile(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, lockRange())
}
