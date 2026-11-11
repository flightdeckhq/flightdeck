//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package datadir

import (
	"errors"
	"os"
	"syscall"
)

// lockFile takes an exclusive flock on f without waiting. flock locks
// belong to the open file, so a second open of the same path, in this
// process or another, is refused while f holds it.
func lockFile(f *os.File) error {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, syscall.EINTR):
			continue
		case errors.Is(err, syscall.EWOULDBLOCK):
			return errLocked
		default:
			return err
		}
	}
}

func unlockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
