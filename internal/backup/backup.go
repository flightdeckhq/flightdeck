// Package backup copies the binary's SQLite database out and back:
// `flightdeck backup`, `flightdeck restore`, and the copy a start keeps
// before it migrates. Every copy is SQLite's VACUUM INTO through a
// read-only connection (storage.SQLiteSnapshot), checked before it is
// trusted, and given its final name only once it is whole; nothing a
// user had is overwritten or deleted. ARCHITECTURE.md (Deployment >
// Backing up and restoring; Storage > Migrations) is the contract.
package backup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// stampLayout is the UTC timestamp in the names of the files this
// package writes: it sorts in time order as text, and has no character a
// file system or a shell treats specially.
const stampLayout = "20060102T150405Z"

func stamp(t time.Time) string { return t.UTC().Format(stampLayout) }

// maxNameTries bounds the search for a free name when one is taken in
// the same second (-2, -3, …): far more copies than a person makes in a
// second, and a loop that cannot run away.
const maxNameTries = 1000

// freeName returns the first of base+ext, base-2+ext, … for which taken
// reports false.
func freeName(base, ext string, taken func(string) bool) (string, error) {
	for i := 1; i <= maxNameTries; i++ {
		name := base + ext
		if i > 1 {
			name = base + "-" + strconv.Itoa(i) + ext
		}
		if !taken(name) {
			return name, nil
		}
	}
	return "", fmt.Errorf("no free name like %s%s after %d tries", base, ext, maxNameTries)
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil || !errors.Is(err, fs.ErrNotExist)
}

// Copy is a copy written and checked.
type Copy struct {
	// Path is where it is.
	Path string
	// File is what the check read of it.
	File storage.SQLiteFile
	// Bytes is its size.
	Bytes int64
}

// writeCopy copies the SQLite database at db to target and returns what
// the check read of the copy. The copy is written into an empty file,
// mode 0600, created beside target, checked at level, flushed to disk,
// and only then given target's name, by a hard link that fails when the
// name is taken: an existing file is never overwritten, and target never
// names half a copy. A failure removes what was written.
func writeCopy(ctx context.Context, db, target string, level storage.CheckLevel) (Copy, error) {
	dir := filepath.Dir(target)
	partial, err := createPartial(dir, filepath.Base(target))
	if err != nil {
		return Copy{}, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(partial)
		}
	}()
	if err := storage.SQLiteSnapshot(ctx, db, partial); err != nil {
		return Copy{}, fmt.Errorf("copy %s: %w", db, err)
	}
	f, err := storage.CheckSQLiteFile(ctx, partial, level)
	if err != nil {
		return Copy{}, fmt.Errorf("the copy does not check out: %w", err)
	}
	if err := syncFile(partial); err != nil {
		return Copy{}, err
	}
	if err := publish(partial, target); err != nil {
		return Copy{}, err
	}
	keep = true
	_ = syncDir(dir)
	info, err := os.Stat(target)
	if err != nil {
		return Copy{}, err
	}
	return Copy{Path: target, File: f, Bytes: info.Size()}, nil
}

// createPartial creates an empty file, mode 0600, in dir for a copy that
// will be named base: a name of its own (a dot, the base, a random
// part), made with O_EXCL so it is never a file that was there.
func createPartial(dir, base string) (string, error) {
	var random [6]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("a name for the copy: %w", err)
	}
	path := filepath.Join(dir, "."+base+".partial-"+hex.EncodeToString(random[:]))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, fs.ErrPermission) {
		return "", notWritable(dir)
	}
	if err != nil {
		return "", fmt.Errorf("create a file for the copy in %s: %w", dir, err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("create a file for the copy in %s: %w", dir, err)
	}
	return path, nil
}

// errTaken is a target name that is already a file.
var errTaken = errors.New("already exists")

// publish gives the finished copy at partial the name target without
// replacing anything: a hard link, which the file system refuses when
// target exists, then the partial name removed. Where hard links are not
// supported (FAT, exFAT, some network shares) it checks the name and
// renames.
func publish(partial, target string) error {
	err := os.Link(partial, target)
	switch {
	case err == nil:
		return os.Remove(partial)
	case errors.Is(err, fs.ErrExist):
		return fmt.Errorf("%s %w; give another file name, or remove it first", target, errTaken)
	}
	if exists(target) {
		return fmt.Errorf("%s %w; give another file name, or remove it first", target, errTaken)
	}
	if err := os.Rename(partial, target); err != nil {
		return fmt.Errorf("name the copy %s: %w", target, err)
	}
	return nil
}

func syncFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("flush %s: %w", path, err)
	}
	err = f.Sync()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("flush %s: %w", path, err)
	}
	return nil
}

// syncDir flushes a directory's entries, so a rename in it survives a
// power loss. Windows refuses to flush a directory (NTFS records a
// rename in its journal), so there it does nothing.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = d.Sync()
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	return err
}

// notWritable is the error of a directory this process may not create a
// file in: its path, its owner and mode, the user flightdeck runs as, and
// what gives that user the directory. A backups/ another user made (a
// root container's install -D on a volume) is the usual case.
func notWritable(dir string) error {
	who, fix := runningAs(dir)
	owner := ""
	if info, err := os.Stat(dir); err == nil {
		if o := ownerOf(info); o != "" {
			owner = ": " + o
		}
	}
	return fmt.Errorf("%s cannot be written by %s%s; give it to that user (%s)", dir, who, owner, fix)
}

// mkdirPrivate creates dir and its parents, mode 0700, as backups/ is
// made; a parent the process may not write in is named as notWritable
// names it.
func mkdirPrivate(dir string) error {
	err := os.MkdirAll(dir, 0o700)
	var pathErr *fs.PathError
	if errors.Is(err, fs.ErrPermission) && errors.As(err, &pathErr) {
		return notWritable(filepath.Dir(pathErr.Path))
	}
	if err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	return nil
}

// DefaultTarget is the file `flightdeck backup` writes with no file
// given: backups/flightdeck-<UTC timestamp>.db under dir, with -2, -3 …
// when the second's name is taken. dir is created, mode 0700.
func DefaultTarget(dir string, now time.Time) (string, error) {
	if err := mkdirPrivate(dir); err != nil {
		return "", err
	}
	name, err := freeName("flightdeck-"+stamp(now), ".db", func(n string) bool { return exists(filepath.Join(dir, n)) })
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

// Backup writes a copy of the SQLite database at db to target, checked
// whole (PRAGMA integrity_check). It takes no lock of the server's and
// may run while the server writes.
func Backup(ctx context.Context, db, target string) (Copy, error) {
	if _, err := os.Stat(db); err != nil {
		return Copy{}, fmt.Errorf("the database %s: %w", db, err)
	}
	if same(db, target) {
		return Copy{}, fmt.Errorf("%s is the database itself", target)
	}
	return writeCopy(ctx, db, target, storage.CheckFull)
}

// same reports whether a and b name one file: the same path, or the
// same file through a link (os.SameFile).
func same(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ai, aerr := os.Stat(a)
	bi, berr := os.Stat(b)
	return aerr == nil && berr == nil && os.SameFile(ai, bi)
}
