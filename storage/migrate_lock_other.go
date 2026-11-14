//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd || windows)

package storage

import "os"

// tryLockFile takes no lock: this platform has no file lock. The
// migrations of one process are still serialised by its mutex. No
// target the release builds (linux, darwin and windows, on amd64 and
// arm64) uses this file; it keeps the module building elsewhere.
func tryLockFile(*os.File) (bool, error) { return true, nil }

func unlockFile(*os.File) error { return nil }
