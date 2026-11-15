//go:build !windows

package connect

import (
	"math"
	"os/exec"
	"syscall"
)

// killTreeOnCancel starts cmd in a process group of its own and makes
// its cancellation (the step's timeout, or Ctrl+C on the command) kill
// the whole group: the CLI and every child it started, such as a git
// clone that would otherwise outlive the step and keep its output open.
func killTreeOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// The group's id is the CLI's pid, as Setpgid made it the leader.
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// processAlive reports whether a process of this user with that pid
// still runs: one this process may signal. A process of another user,
// which refuses the signal (EPERM), is not one this user started, so it
// is not alive here. A pid out of 1 to math.MaxInt32 is never alive:
// 0 and below name process groups, and a larger value wraps in the
// system call to one of them or to another process.
func processAlive(pid int) bool {
	if pid < 1 || pid > math.MaxInt32 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}
