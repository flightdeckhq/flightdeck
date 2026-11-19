//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package backup

import "golang.org/x/sys/unix"

// freeBytes is the space an unprivileged process may still write on the
// file system of dir; ok is false when it cannot be read.
func freeBytes(dir string) (uint64, bool) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), true //nolint:unconvert // the field types differ between systems
}
