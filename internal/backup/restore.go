package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// The names a restore gives files beside the database <db>:
//
//	<db>.restoring-<stamp>         the backup's copy, until it is <db>
//	<db>.restore                   the marker of a restore under way
//	<db>.replaced-<stamp>[-wal|-shm] the database the restore replaced
const (
	restoringInfix = ".restoring-"
	replacedInfix  = ".replaced-"
	markerSuffix   = ".restore"
)

// sqliteSidecars are the files SQLite keeps beside a database in WAL
// mode, paired with it by name: a log left under the database's name
// would be applied to whatever file takes that name.
var sqliteSidecars = []string{"-wal", "-shm"}

// maxMarkerBytes bounds what is read of a marker: two file names.
const maxMarkerBytes = 4 << 10

// marker is what <db>.restore records, the base names of the two files
// that let a later start finish or undo a restore that stopped halfway.
type marker struct {
	// Staged is the backup's checked copy (<db>.restoring-<stamp>).
	Staged string `json:"staged"`
	// Replaced is the name the database takes (<db>.replaced-<stamp>),
	// its -wal and -shm with the same suffixes.
	Replaced string `json:"replaced"`
}

// Restored is what a restore did.
type Restored struct {
	// File is what the check read of the backup.
	File storage.SQLiteFile
	// Replaced are the files the database before the restore now has,
	// the database first; empty when there was none.
	Replaced []string
}

// step is called between the steps of a restore with the step's name;
// the tests make it fail (the restore is undone) or stop the restore
// there as a process that dies would (errStop).
var step = func(string) error { return nil }

// errStop, from step, ends a restore at once with nothing undone: what a
// process killed at that point leaves.
var errStop = errors.New("stopped here")

// rename is os.Rename for every rename of a restore and of the recovery;
// the tests make it fail, as a file held open does on Windows.
var rename = os.Rename

// Restore replaces the SQLite database at db with a copy of the one at
// source. The caller holds the data dir's lock and db's lock, checked
// source (CheckFull) and made sure it is not db. In db's directory it:
//
//  1. copies source into <db>.restoring-<stamp> (VACUUM INTO, so a backup
//     with a write-ahead log beside it is copied whole and never written
//     to) and checks the copy;
//  2. writes the marker <db>.restore;
//  3. renames db's -wal, -shm and db itself to <db>.replaced-<stamp> with
//     the same suffixes, free names, so the replaced database keeps its
//     own log and that log is never applied to the restored file;
//  4. renames the copy to db, checks it, and removes the marker.
//
// A failure before step 3 removes the copy, and one in steps 3 and 4
// renames back what moved: the error then says the database is as it
// was. A process that stops between steps 2 and 4 leaves the marker,
// which RecoverInterrupted reads at the next start.
func Restore(ctx context.Context, source, db string, now time.Time) (Restored, error) {
	dir := filepath.Dir(db)
	staged := filepath.Join(dir, filepath.Base(db)+restoringInfix+stamp(now))
	if exists(staged) {
		return Restored{}, fmt.Errorf("%s is there already; nothing changed", staged)
	}
	f, err := os.OpenFile(staged, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Restored{}, fmt.Errorf("create %s: %w; nothing changed", staged, err)
	}
	_ = f.Close()
	unstage := func() { _ = os.Remove(staged) }
	if err := storage.SQLiteSnapshot(ctx, source, staged); err != nil {
		unstage()
		return Restored{}, fmt.Errorf("copy the backup next to the database: %w; nothing changed", err)
	}
	checked, err := storage.CheckSQLiteFile(ctx, staged, storage.CheckFull)
	if err != nil {
		unstage()
		return Restored{}, fmt.Errorf("the copy of the backup does not check out: %w; nothing changed", err)
	}
	if err := syncFile(staged); err != nil {
		unstage()
		return Restored{}, fmt.Errorf("%w; nothing changed", err)
	}
	if err := stepOr(unstage, "staged"); err != nil {
		return Restored{}, err
	}

	replaced, err := freeName(filepath.Base(db)+replacedInfix+stamp(now), "", func(n string) bool {
		for _, suffix := range append([]string{""}, sqliteSidecars...) {
			if exists(filepath.Join(dir, n+suffix)) {
				return true
			}
		}
		return false
	})
	if err != nil {
		unstage()
		return Restored{}, fmt.Errorf("%w; nothing changed", err)
	}
	m := marker{Staged: filepath.Base(staged), Replaced: replaced}
	if err := writeMarker(db, m); err != nil {
		unstage()
		return Restored{}, fmt.Errorf("%w; nothing changed", err)
	}
	if err := stepOr(func() { unstage(); removeMarker(db) }, "marker"); err != nil {
		return Restored{}, err
	}

	// Step 3: the logs first, then the database, so that at no moment a
	// start finds the database without the log that belongs to it.
	var moved [][2]string
	// undo renames back what moved, the last first, and only once every
	// file is back removes the copy and the marker: when a rename back
	// fails (a file held open on Windows), both stay, and the next start
	// or restore reads the marker and finishes putting the database back.
	undo := func() error {
		for i := len(moved) - 1; i >= 0; i-- {
			if err := rename(moved[i][1], moved[i][0]); err != nil {
				return fmt.Errorf("rename %s back to %s: %w", moved[i][1], moved[i][0], err)
			}
		}
		unstage()
		removeMarker(db)
		_ = syncDir(dir)
		return nil
	}
	failed := func(what string, err error) (Restored, error) {
		if uerr := undo(); uerr != nil {
			return Restored{}, fmt.Errorf("%s: %w; putting the database back failed too (%v). %s and the copy stay: the next "+
				"start or restore reads them and finishes putting the database back, and until then no start serves an "+
				"empty database in its place", what, err, uerr, db+markerSuffix)
		}
		return Restored{}, fmt.Errorf("%s: %w; the database is as it was", what, err)
	}
	for _, suffix := range append(append([]string{}, sqliteSidecars...), "") {
		from := db + suffix
		if !exists(from) {
			continue
		}
		to := filepath.Join(dir, replaced+suffix)
		if err := rename(from, to); err != nil {
			return failed("move "+from+" aside", err)
		}
		moved = append(moved, [2]string{from, to})
		if err := step("moved" + suffix); errors.Is(err, errStop) {
			return Restored{}, err
		} else if err != nil {
			return failed("after moving "+from, err)
		}
	}

	// Step 4.
	if err := rename(staged, db); err != nil {
		return failed("put the copy in place", err)
	}
	// From here the copy is db: undoing renames it back to the staged
	// name first. Should that fail, the renames of undo put the replaced
	// database back over it, which is the undo still.
	if err := step("swapped"); errors.Is(err, errStop) {
		return Restored{}, err
	} else if err != nil {
		_ = rename(db, staged)
		return failed("after putting the copy in place", err)
	}
	if _, err := storage.CheckSQLiteFile(ctx, db, storage.CheckOpens); err != nil {
		_ = rename(db, staged)
		return failed("the restored database does not open", err)
	}
	removeMarker(db)
	_ = syncDir(dir)
	r := Restored{File: checked}
	for _, pair := range moved {
		if pair[0] == db {
			r.Replaced = append([]string{pair[1]}, r.Replaced...)
		} else {
			r.Replaced = append(r.Replaced, pair[1])
		}
	}
	return r, nil
}

// stepOr runs the hook of a step before anything was moved: a failure
// runs cleanup and says nothing changed; errStop returns as it is.
func stepOr(cleanup func(), name string) error {
	err := step(name)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errStop):
		return err
	}
	cleanup()
	return fmt.Errorf("after %s: %w; nothing changed", name, err)
}

func writeMarker(db string, m marker) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	path := db + markerSuffix
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	_, werr := f.Write(append(data, '\n'))
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(path)
		return fmt.Errorf("write %s: %w", path, werr)
	}
	return syncDir(filepath.Dir(db))
}

func removeMarker(db string) { _ = os.Remove(db + markerSuffix) }

// readMarker returns the marker beside db, and false when there is none.
// A marker whose names are not the ones a restore writes for db is an
// error: nothing is renamed on its say.
func readMarker(db string) (marker, bool, error) {
	f, err := os.Open(db + markerSuffix)
	if errors.Is(err, fs.ErrNotExist) {
		return marker{}, false, nil
	}
	if err != nil {
		return marker{}, false, err
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxMarkerBytes))
	if err != nil {
		return marker{}, false, err
	}
	var m marker
	if err := json.Unmarshal(data, &m); err != nil {
		// A restore writes the marker whole and flushes it before it moves
		// anything, so a marker cut short was being written when the
		// restore stopped, and nothing has moved.
		return marker{}, false, fmt.Errorf("%s, the marker of a restore, does not parse (%v): the restore stopped while it was "+
			"writing it, before it moved any file, so the database is as it was. Remove it (%s) and start again",
			db+markerSuffix, err, db+markerSuffix)
	}
	base := filepath.Base(db)
	if filepath.Base(m.Staged) != m.Staged || filepath.Base(m.Replaced) != m.Replaced ||
		!strings.HasPrefix(m.Staged, base+restoringInfix) || !strings.HasPrefix(m.Replaced, base+replacedInfix) {
		return marker{}, false, fmt.Errorf("%s names files that are not a restore's (%q and %q), so nothing is renamed on its say: "+
			"remove it (%s) once the database's files are as you want them", db+markerSuffix, m.Staged, m.Replaced, db+markerSuffix)
	}
	return m, true, nil
}

// LostDatabase reports a database a restore moved aside and did not put
// back: there is no db, but a <db>.replaced-* is there. A start that
// created db then would serve a new, empty database while the real one
// sits under another name, so it refuses instead, with the files found
// and the command that puts one back. nil when db is there or no
// replaced database is.
func LostDatabase(db string) error {
	if exists(db) {
		return nil
	}
	dir := filepath.Dir(db)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var found []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, filepath.Base(db)+replacedInfix) && !strings.HasSuffix(name, "-wal") &&
			!strings.HasSuffix(name, "-shm") && e.Type().IsRegular() {
			found = append(found, filepath.Join(dir, name))
		}
	}
	if len(found) == 0 {
		return nil
	}
	return fmt.Errorf("there is no database at %s, but a restore left the one it replaced: %s. Flightdeck would start on a "+
		"new, empty database in its place, so it does not start. To serve that database, run flightdeck restore %s with this "+
		"start's --data-dir; to start with an empty database instead, move those files (with their -wal and -shm) out of %s",
		db, strings.Join(found, ", "), found[len(found)-1], dir)
}

// RecoverInterrupted finishes or undoes a restore of db that stopped
// halfway, as its marker records; the caller holds db's locks. With the
// backup's copy still there the restore had not swapped the files: the
// replaced database is put back under db's names and the copy removed.
// With the copy gone it is db, already checked: the restore is done. The
// message says which, "" when there was nothing to do.
func RecoverInterrupted(db string) (string, error) {
	m, ok, err := readMarker(db)
	if err != nil {
		return "", err
	}
	removeOrphanCopies(db, m.Staged)
	if !ok {
		return "", nil
	}
	dir := filepath.Dir(db)
	staged := filepath.Join(dir, m.Staged)
	replaced := filepath.Join(dir, m.Replaced)
	if !exists(staged) && exists(db) {
		removeMarker(db)
		_ = syncDir(dir)
		return fmt.Sprintf("a restore of %s had finished but not removed its marker; it is done, and the database it "+
			"replaced is %s", db, replaced), nil
	}
	for _, suffix := range append(append([]string{}, sqliteSidecars...), "") {
		from, to := replaced+suffix, db+suffix
		if !exists(from) || exists(to) {
			continue
		}
		if err := rename(from, to); err != nil {
			return "", fmt.Errorf("putting back the database a restore was replacing: %s: %w; %s stays, and the next start "+
				"or restore tries again", from, err, db+markerSuffix)
		}
	}
	if exists(staged) {
		if err := os.Remove(staged); err != nil {
			return "", fmt.Errorf("removing the copy of an interrupted restore: %w", err)
		}
	}
	removeMarker(db)
	_ = syncDir(dir)
	return fmt.Sprintf("a restore of %s was interrupted before it finished; it is undone, and the database is the one "+
		"from before it", db), nil
}

// removeOrphanCopies removes the backup copies of restores that stopped
// before they wrote their marker (<db>.restoring-* other than keep): no
// marker names them, nothing was moved for them, and the caller's locks
// say no restore is running.
func removeOrphanCopies(db, keep string) {
	dir := filepath.Dir(db)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	prefix := filepath.Base(db) + restoringInfix
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) && e.Name() != keep && e.Type().IsRegular() {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
