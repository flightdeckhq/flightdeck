//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd || windows)

package datadir

import "os"

// On a system with neither flock nor LockFileEx the lock file is
// written but excludes nobody; the binary is released for Linux, macOS
// and Windows, which have one or the other.
func lockFile(*os.File) error { return nil }

func unlockFile(*os.File) error { return nil }
