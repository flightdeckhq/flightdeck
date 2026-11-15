//go:build windows

package connect

import (
	"os/exec"
	"strconv"
)

// killTreeOnCancel makes cmd's cancellation (the step's timeout, or
// Ctrl+C on the command) end the CLI's whole process tree: `claude` is
// often claude.cmd, which runs under cmd.exe, and killing cmd.exe alone
// would leave the CLI and its git children running. taskkill /T ends
// the tree, /F without waiting for it to agree; the process itself is
// killed as well should taskkill fail.
func killTreeOnCancel(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		pid := strconv.Itoa(cmd.Process.Pid)
		if err := exec.Command("taskkill", "/T", "/F", "/PID", pid).Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
