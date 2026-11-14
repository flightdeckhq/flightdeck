package storage

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// symlinkDepthLimit bounds how many dangling symbolic links
// resolveSQLitePath follows by hand; the kernel itself gives up at forty.
const symlinkDepthLimit = 40

// ResolveSQLitePath returns the real path of the SQLite database file at
// path: absolute, with its symbolic links resolved. It is the one name of
// a SQLite file in Flightdeck. The migration lock is keyed on it, and the
// flightdeck binary opens the database by it (and names its own
// one-process lock after it), so the file the lock guards is the file
// that is migrated and served, whichever name reached it.
//
// The links resolved are those of the file when it exists; otherwise
// those of its directory, where the file is about to be created, after
// following a chain of links that point at a file not created yet. Each
// relative link target is taken from its link's physical directory, as
// the kernel takes it. A chain longer than the kernel's limit, or a
// loop, is an error. A hard link is a second real path for one file;
// no path resolves it.
func ResolveSQLitePath(path string) (string, error) {
	return resolveSQLitePath(path, symlinkDepthLimit)
}

// resolveSQLitePath is ResolveSQLitePath with at most depth dangling
// links still to follow.
func resolveSQLitePath(path string, depth int) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if info, lerr := os.Lstat(abs); lerr == nil && info.Mode()&fs.ModeSymlink != 0 {
		if depth <= 0 {
			return "", fmt.Errorf("%s: too many symbolic links", abs)
		}
		target, rerr := os.Readlink(abs)
		if rerr != nil {
			return "", rerr
		}
		if !filepath.IsAbs(target) {
			// The kernel resolves a relative target against the link's
			// physical directory, not the path it was reached by: through
			// lnk -> real/sub, the target ../../other/db of real/sub/db is
			// <base>/other/db, while a lexical join of lnk/db's directory
			// would give the directory above <base>.
			linkDir, derr := filepath.EvalSymlinks(filepath.Dir(abs))
			if derr != nil {
				return "", derr
			}
			target = filepath.Join(linkDir, target)
		}
		return resolveSQLitePath(target, depth-1)
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		// The os error names the directory that is missing.
		return "", err
	}
	return filepath.Join(dir, filepath.Base(abs)), nil
}
