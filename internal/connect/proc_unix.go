//go:build !windows

package connect

import (
	"errors"
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

// processAlive reports whether a process with that pid still runs. A
// process of another user, which this one may not signal, runs too. A
// pid of 0 or below names a process group, not a process: never alive.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
