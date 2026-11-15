//go:build windows

package connect

import "golang.org/x/sys/windows"

// stillActive is the exit code GetExitCodeProcess reports for a process
// that has not exited (STILL_ACTIVE).
const stillActive = 259

// processAlive reports whether a process with that pid still runs.
func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}
