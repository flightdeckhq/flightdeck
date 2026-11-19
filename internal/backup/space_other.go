//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd || windows)

package backup

// freeBytes cannot read the free space on this system: the copy before a
// migration is then taken whatever the space.
func freeBytes(string) (uint64, bool) { return 0, false }
