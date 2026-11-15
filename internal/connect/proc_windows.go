//go:build windows

package connect

import (
	"errors"
	"os/exec"
	"strconv"

	"golang.org/x/sys/windows"
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

// stillActive is the exit code GetExitCodeProcess reports for a process
// that has not exited (STILL_ACTIVE).
const stillActive = 259

// processAlive reports whether a process with that pid still runs: one
// that can be opened and has not exited. A process that has exited but
// whose handle another process still holds is not running.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// Access denied means the process is there and belongs to
		// someone this process may not query.
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}
