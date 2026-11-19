//go:build windows

package backup

import "golang.org/x/sys/windows"

// freeBytes is the space the user may still write on the volume of dir
// (its quota counted); ok is false when it cannot be read.
func freeBytes(dir string) (uint64, bool) {
	path, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, false
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(path, &free, &total, &totalFree); err != nil {
		return 0, false
	}
	return free, true
}
