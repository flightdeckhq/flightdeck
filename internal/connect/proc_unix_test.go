//go:build !windows

package connect

import "syscall"

// processAlive reports whether a process with that pid still runs.
func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
