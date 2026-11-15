//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd)

package datadir

import (
	"fmt"
	"os"
)

// openInstance opens the instance file at path and returns it only when
// it is a regular file that is not a link (on Windows a symbolic link
// or a junction is not a regular file to Lstat), and the file opened is
// the file looked at, so one swapped in between is refused.
//
// That is all that is checked here. Windows keeps no mode bits, and the
// file's and the data dir's access lists are not read: the default data
// dir, %LOCALAPPDATA%\flightdeck, is the user's alone, while a
// --data-dir elsewhere (under C:\, which grants Authenticated Users
// Modify on what is created in it) may be writable by other users of
// the machine, and is trusted as it is. Neither the owner nor the link
// count is compared.
func openInstance(path, _ string) (*os.File, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, openNotExist(path, err)
	}
	if !before.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is %w", path, errNotRegular)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, openNotExist(path, err)
	}
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		_ = f.Close()
		return nil, fmt.Errorf("%s changed while it was opened", path)
	}
	return f, nil
}
