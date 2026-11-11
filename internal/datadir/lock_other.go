//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd || windows)

package datadir

import "os"

// LockSupported reports that Acquire excludes nobody on this platform:
// it has neither flock nor LockFileEx, so the lock file is written (the
// holder's PID is in it) and a second process is not refused. The
// binary still starts, and says so in a warning: it is released for
// Linux, macOS and Windows, which have a lock, and refusing to run
// where someone built it for another system would take the program
// away to guard against a mistake that system cannot detect.
const LockSupported = false

func lockFile(*os.File) error { return nil }

func unlockFile(*os.File) error { return nil }
