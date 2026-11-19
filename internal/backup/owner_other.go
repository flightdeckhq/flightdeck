//go:build !unix

package backup

import "io/fs"

// ownerOf has no owner to name where files have no uid (Windows keeps an
// access list, which the message points to instead).
func ownerOf(fs.FileInfo) string { return "" }

// runningAs names the user this process runs as, and what gives it dir.
func runningAs(string) (who, fix string) {
	return "the user flightdeck runs as", "the directory's Security properties"
}
