//go:build unix

package backup

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// ownerOf says who owns a directory and its mode, for the message about
// one this process cannot write in: "it belongs to uid 0 (gid 0), mode
// drwxr-xr-x".
func ownerOf(info fs.FileInfo) string {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("it belongs to uid %d (gid %d), mode %s", st.Uid, st.Gid, info.Mode())
	}
	return fmt.Sprintf("its mode is %s", info.Mode())
}

// runningAs names the user this process runs as, and what gives it dir:
// "the user flightdeck runs as (uid 65532)", "chown 65532:65532 <dir>,
// as root".
func runningAs(dir string) (who, fix string) {
	return fmt.Sprintf("the user flightdeck runs as (uid %d)", os.Getuid()),
		fmt.Sprintf("chown %d:%d %s, as root", os.Getuid(), os.Getgid(), dir)
}
