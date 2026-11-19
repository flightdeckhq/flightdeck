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
//	<db>.restoring-<stamp>           the backup's copy, until it is <db>
//	<db>.restore                     the marker of a restore under way
//	<db>.restore.next                the marker's next state, until it is the marker
//	<db>.replaced-<stamp>[-wal|-shm] the database the restore replaced
const (
	restoringInfix = ".restoring-"
	replacedInfix  = ".replaced-"
	markerSuffix   = ".restore"
	nextSuffix     = ".next"
)

// The states a marker records: how far its restore got.
const (
	// stateMoving: the copy is staged under its own name and the
	// database's files are being moved aside.
	stateMoving = "moving"
	// stateSwapping: the files are aside, and the copy is being given the
	// database's name, or has it and has not been checked.
	stateSwapping = "swapping"
	// stateUndoing: the restore failed after the swap and is putting the
	// database back; a copy under the database's name is to be moved back.
	stateUndoing = "undoing"
)

// sqliteSidecars are the files SQLite keeps beside a database in WAL
// mode, paired with it by name: a log left under the database's name
// would be applied to whatever file takes that name.
var sqliteSidecars = []string{"-wal", "-shm"}

// maxMarkerBytes bounds what is read of a marker: two file names and a
// state.
const maxMarkerBytes = 4 << 10

// marker is what <db>.restore records: the base names of the two files
// that let a later start finish or undo a restore that stopped halfway,
// and how far it got. A marker is removed once the restored database has
// been checked, so a marker there is a restore not known to be good.
type marker struct {
	// Staged is the backup's checked copy (<db>.restoring-<stamp>).
	Staged string `json:"staged"`
	// Replaced is the name the database takes (<db>.replaced-<stamp>),
	// its -wal and -shm with the same suffixes.
	Replaced string `json:"replaced"`
	// State is stateMoving, stateSwapping or stateUndoing.
	State string `json:"state"`
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

// rename is os.Rename for every rename of a database file by a restore
// and by the recovery; the tests make it fail, as a file held open does
// on Windows.
var rename = os.Rename

// Restore replaces the SQLite database at db with a copy of the one at
// source. The caller holds the data dir's lock and db's lock, checked
// source (CheckFull) and made sure it is not db. In db's directory it:
//
//  1. copies source into <db>.restoring-<stamp> (VACUUM INTO, so a backup
//     with a write-ahead log beside it is copied whole and never written
//     to) and checks the copy;
//  2. writes the marker <db>.restore, state stateMoving;
//  3. renames db's -wal, -shm and db itself to <db>.replaced-<stamp> with
//     the same suffixes, free names, so the replaced database keeps its
//     own log and that log is never applied to the restored file;
//  4. records stateSwapping, renames the copy to db, checks that it
//     opens, and removes the marker.
//
// A failure before step 3 removes the copy, and one in steps 3 and 4
// renames back what moved, the last first (after the swap, having
// recorded stateUndoing): the error then says the database is as it was.
// A rename back that fails stops the undo there, so nothing is renamed
// over a file, and leaves the marker. A process that stops between steps
// 2 and 4 leaves the marker too; RecoverInterrupted reads it at the next
// start.
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
	m := marker{Staged: filepath.Base(staged), Replaced: replaced, State: stateMoving}
	if err := writeMarker(db, m); err != nil {
		unstage()
		return Restored{}, fmt.Errorf("%w; nothing changed", err)
	}
	if err := stepOr(func() { removeMarker(db); unstage() }, "marker"); err != nil {
		return Restored{}, err
	}

	// Step 3: the logs first, then the database, so that at no moment a
	// start finds the database without the log that belongs to it.
	var moved [][2]string
	// swapped is set once the copy has db's name.
	swapped := false
	// undo renames back what moved, the last first, and stops at the first
	// rename that fails: every name it renames to is one a rename of the
	// restore freed, so nothing is renamed over a file. Only once every
	// file is back does it remove the marker, then the copy (a copy left
	// without its marker is one the next start removes); when a rename
	// fails the marker stays, and the next start or restore reads it.
	undo := func() error {
		for i := len(moved) - 1; i >= 0; i-- {
			if err := rename(moved[i][1], moved[i][0]); err != nil {
				return fmt.Errorf("rename %s back to %s: %w", moved[i][1], moved[i][0], err)
			}
		}
		removeMarker(db)
		unstage()
		_ = syncDir(dir)
		return nil
	}
	failed := func(what string, err error) (Restored, error) {
		var unrecorded error
		if swapped {
			// Recorded first: a marker that still said stateSwapping would
			// have the next start keep the copy, should it open then.
			unrecorded = setState(db, &m, stateUndoing)
			if serr := step("undoing"); errors.Is(serr, errStop) {
				return Restored{}, serr
			}
		}
		uerr := undo()
		if uerr == nil {
			return Restored{}, fmt.Errorf("%s: %w; the database is as it was", what, err)
		}
		next := "the next start or restore reads it and finishes putting the database back, and until then no start " +
			"serves the restored copy or an empty database in its place"
		if unrecorded != nil {
			next = fmt.Sprintf("recording that the restore is being undone failed as well (%v), so the marker still says the "+
				"copy took the database's name unchecked: the next start or restore checks %s, keeps it only if it opens, "+
				"and otherwise puts the database back", unrecorded, db)
		}
		return Restored{}, fmt.Errorf("%s: %w; putting the database back failed too (%v). %s stays: %s",
			what, err, uerr, db+markerSuffix, next)
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
	if err := setState(db, &m, stateSwapping); err != nil {
		return failed("record the swap", err)
	}
	if err := step("swapping"); errors.Is(err, errStop) {
		return Restored{}, err
	} else if err != nil {
		return failed("after recording the swap", err)
	}
	if err := rename(staged, db); err != nil {
		return failed("put the copy in place", err)
	}
	moved = append(moved, [2]string{staged, db})
	swapped = true
	if err := step("swapped"); errors.Is(err, errStop) {
		return Restored{}, err
	} else if err != nil {
		return failed("after putting the copy in place", err)
	}
	if _, err := storage.CheckSQLiteFile(ctx, db, storage.CheckOpens); err != nil {
		return failed("the restored database does not open", err)
	}
	removeMarker(db)
	_ = syncDir(dir)
	r := Restored{File: checked}
	for _, pair := range moved {
		switch pair[0] {
		case staged:
		case db:
			r.Replaced = append([]string{pair[1]}, r.Replaced...)
		default:
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

// writeMarker writes db's first marker, under a name no file may have,
// and flushes it with its directory.
func writeMarker(db string, m marker) error {
	if err := writeMarkerFile(db+markerSuffix, m, os.O_EXCL); err != nil {
		return err
	}
	return syncDir(filepath.Dir(db))
}

// setState records state in db's marker: m with that state is written
// whole to <db>.restore.next, flushed, and renamed over the marker, so
// the marker holds the state before or this one, never part of either.
func setState(db string, m *marker, state string) error {
	next := *m
	next.State = state
	tmp := db + markerSuffix + nextSuffix
	if err := writeMarkerFile(tmp, next, os.O_TRUNC); err != nil {
		return err
	}
	if err := os.Rename(tmp, db+markerSuffix); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("record the state %s in %s: %w", state, db+markerSuffix, err)
	}
	m.State = state
	return syncDir(filepath.Dir(db))
}

// writeMarkerFile writes m to path, mode 0600, and flushes it; flag is
// added to O_CREATE|O_WRONLY. A failure removes what was written.
func writeMarkerFile(path string, m marker, flag int) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|flag, 0o600)
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
	return nil
}

func removeMarker(db string) { _ = os.Remove(db + markerSuffix) }

// readMarker returns the marker beside db, and false when there is none.
// A marker whose names are not the ones a restore writes for db, or whose
// state is not one a restore records, is an error: nothing is renamed on
// its say.
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
		// A restore writes its first marker whole and flushes it before it
		// moves anything, and every later state whole under another name
		// first, so a marker cut short was the first being written when the
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
	switch m.State {
	case stateMoving, stateSwapping, stateUndoing:
	default:
		return marker{}, false, fmt.Errorf("%s records a state a restore does not (%q), so nothing is renamed on its say: "+
			"remove it (%s) once the database's files are as you want them", db+markerSuffix, m.State, db+markerSuffix)
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
// halfway, as its marker records; the caller holds db's locks. While the
// marker is there the copy leaves its staging name only by taking db's,
// once stateSwapping is on disk (setState flushes it before the rename),
// and the database is never renamed back over it, so in those later
// states a missing copy with a db there means db is the copy:
//
//   - stateMoving, or the copy under its staging name: it never took db's
//     name. The replaced database is put back under the names that are
//     free and the copy removed: the restore is undone.
//   - stateSwapping, the copy at db: the swap happened and was never
//     checked. db is checked now: when it opens the restore is done; when
//     it does not, stateUndoing is recorded and the restore undone as
//     below. An unchecked swap is never taken for a finished restore.
//   - stateUndoing, the copy at db: the restore gave up after the swap.
//     The copy is renamed back to its staging name, the replaced database
//     put back, the copy removed.
//
// A rename that fails returns an error with the marker as it is, and the
// next start or restore tries again. The message says what was done, ""
// when there was nothing to do.
func RecoverInterrupted(ctx context.Context, db string) (string, error) {
	// A state written but not renamed over the marker: the marker's own
	// state stands.
	_ = os.Remove(db + markerSuffix + nextSuffix)
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
	stays := db + markerSuffix + " stays, and the next start or restore tries again"
	note := fmt.Sprintf("a restore of %s was interrupted before it finished; it is undone, and the database's files are "+
		"the ones from before it", db)
	if m.State != stateMoving && !exists(staged) && exists(db) {
		if m.State == stateUndoing {
			note = fmt.Sprintf("a restore of %s failed after it put the backup's copy in place and was putting the database "+
				"back when it stopped; it is undone, and the database's files are the ones from before it", db)
		} else {
			_, cerr := storage.CheckSQLiteFile(ctx, db, storage.CheckOpens)
			if cerr == nil {
				removeMarker(db)
				_ = syncDir(dir)
				return fmt.Sprintf("a restore of %s had put the backup's copy in place when it stopped, and the copy opens: "+
					"the restore is done, and the database it replaced is %s", db, replaced), nil
			}
			if err := setState(db, &m, stateUndoing); err != nil {
				return "", fmt.Errorf("a restore of %s put the backup's copy in place and stopped before it checked it, and "+
					"the copy does not open (%s); recording that the restore is to be undone failed: %w; %s",
					db, clause(cerr), err, stays)
			}
			note = fmt.Sprintf("a restore of %s had put the backup's copy in place when it stopped, before it checked it, and "+
				"the copy does not open (%s); it is undone, and the database's files are the ones from before it",
				db, clause(cerr))
		}
		if err := rename(db, staged); err != nil {
			return "", fmt.Errorf("moving the restored copy %s back to %s, out of the way of the database a restore "+
				"replaced: %w; %s", db, staged, err, stays)
		}
	}
	for _, suffix := range append(append([]string{}, sqliteSidecars...), "") {
		from, to := replaced+suffix, db+suffix
		if !exists(from) || exists(to) {
			continue
		}
		if err := rename(from, to); err != nil {
			return "", fmt.Errorf("putting back the database a restore was replacing: %s: %w; %s", from, err, stays)
		}
	}
	// The marker first: a copy it no longer names is one the next start
	// removes, should removing it here fail.
	removeMarker(db)
	_ = os.Remove(staged)
	_ = syncDir(dir)
	return note, nil
}

// removeOrphanCopies removes the backup copies of restores that stopped
// before they wrote their marker, or after they removed it
// (<db>.restoring-* other than keep): no marker names them, nothing was
// moved for them, and the caller's locks say no restore is running.
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
