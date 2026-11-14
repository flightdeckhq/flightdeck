//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package storage

import (
	"errors"
	"os"
	"syscall"
)

// tryLockFile takes an exclusive flock on f without waiting and
// reports whether it got it. flock locks belong to the open file, so a
// second open of the same path, in this process or another, is refused
// while f holds it.
func tryLockFile(f *os.File) (bool, error) {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		switch {
		case err == nil:
			return true, nil
		case errors.Is(err, syscall.EINTR):
			continue
		case errors.Is(err, syscall.EWOULDBLOCK):
			return false, nil
		default:
			return false, err
		}
	}
}

func unlockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
