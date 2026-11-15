//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package datadir

import (
	"fmt"
	"os"
	"syscall"
)

// currentUID is this process's user; a test sets another.
var currentUID = os.Getuid

// openInstance opens the instance file at path in the data dir dir and
// returns it only when it can be trusted, checked on the file opened:
// a final component that is a link is refused at the open (O_NOFOLLOW),
// and a pipe opens without waiting for a writer (O_NONBLOCK). The file
// must then be a regular file with one link (a hard link to a file
// elsewhere is someone else's file), owned by this user and not
// writable by group or others; the data dir must be owned by this user
// and not writable by group or others, so nobody else can replace the
// file either.
func openInstance(path, dir string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, openNotExist(path, err)
	}
	if err := trustInstance(f, path, dir); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func trustInstance(f *os.File, path, dir string) error {
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is %w", path, errNotRegular)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("stat %s: no owner and link count", path)
	}
	switch {
	case uint64(st.Nlink) != 1:
		return fmt.Errorf("%s has %d links; it must be the data dir's own file", path, st.Nlink)
	case int(st.Uid) != currentUID():
		return fmt.Errorf("%s belongs to another user (uid %d)", path, st.Uid)
	case info.Mode().Perm()&0o022 != 0:
		return fmt.Errorf("%s can be written by other users (mode %04o)", path, info.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("stat %s: %w", dir, err)
	}
	dirSt, ok := dirInfo.Sys().(*syscall.Stat_t)
	switch {
	case !ok:
		return fmt.Errorf("stat %s: no owner", dir)
	case int(dirSt.Uid) != currentUID():
		return fmt.Errorf("data dir %s belongs to another user (uid %d)", dir, dirSt.Uid)
	case dirInfo.Mode().Perm()&0o022 != 0:
		return fmt.Errorf("data dir %s can be written by other users (mode %04o)", dir, dirInfo.Mode().Perm())
	}
	return nil
}
