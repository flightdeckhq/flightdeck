//go:build windows

package storage

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// lockRange is the byte range the lock covers: one byte past the
// file's end, which no reader of the empty file touches.
func lockRange() *windows.Overlapped {
	return &windows.Overlapped{OffsetHigh: 1}
}

// tryLockFile takes an exclusive lock on f without waiting and reports
// whether it got it.
func tryLockFile(f *os.File) (bool, error) {
	err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, lockRange())
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, windows.ERROR_LOCK_VIOLATION), errors.Is(err, windows.ERROR_IO_PENDING):
		return false, nil
	default:
		return false, err
	}
}

func unlockFile(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, lockRange())
}
