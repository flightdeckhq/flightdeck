package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

var testNow = time.Date(2026, 11, 19, 9, 30, 0, 0, time.UTC)

// restoreSetup is a data dir whose database was killed with 10 sessions
// (its last ones only in its -wal), and a backup of 3 sessions elsewhere
// as `flightdeck backup` writes one: a VACUUM INTO copy, one file in
// rollback-journal mode.
func restoreSetup(t *testing.T) (db, source string) {
	t.Helper()
	db = filepath.Join(t.TempDir(), "flightdeck.db")
	crashedDatabase(t, db, 10)
	live := filepath.Join(t.TempDir(), "live.db")
	closedDatabase(t, live, 3)
	source = filepath.Join(t.TempDir(), "backup.db")
	if err := storage.SQLiteSnapshot(context.Background(), live, source); err != nil {
		t.Fatal(err)
	}
	return db, source
}

func TestRestore_ReplacesTheDatabaseAndKeepsTheOneItReplacedWithItsLog(t *testing.T) {
	db, source := restoreSetup(t)
	backupBefore := files(t, filepath.Dir(source))
	r, err := Restore(context.Background(), source, db, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if got := sessionsIn(t, db); got != 3 {
		t.Errorf("the restored database holds %d sessions, want the backup's 3", got)
	}
	replaced := db + ".replaced-20261119T093000Z"
	if len(r.Replaced) != len(crashedFiles()) || r.Replaced[0] != replaced {
		t.Fatalf("Replaced = %q, want %s first, with its -wal and -shm", r.Replaced, replaced)
	}
	// The replaced database opens as it was, its log paired with it by
	// name: all 10 sessions, the ones only in the log included.
	if got := sessionsIn(t, replaced); got != 10 {
		t.Errorf("the replaced database holds %d sessions, want 10", got)
	}
	// The old log is never left under the database's name, where SQLite
	// would apply it to the restored file.
	for _, leftover := range []string{db + "-wal", db + markerSuffix} {
		if _, err := os.Stat(leftover); err == nil {
			t.Errorf("%s is there after the restore", leftover)
		}
	}
	if matches, _ := filepath.Glob(db + restoringInfix + "*"); len(matches) > 0 {
		t.Errorf("the restore's copy is left: %v", matches)
	}
	sameFiles(t, filepath.Dir(source), backupBefore)
	if info, err := os.Stat(db); err != nil || (info.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/') {
		t.Errorf("the restored database's mode is %v (%v), want private", info.Mode().Perm(), err)
	}
}

// Two restores within one second each keep the database they replaced:
// the second takes the next free name, and the first's files are as they
// were.
func TestRestore_TwoRestoresInOneSecondKeepBothReplacedDatabases(t *testing.T) {
	db, source := restoreSetup(t)
	if _, err := Restore(context.Background(), source, db, testNow); err != nil {
		t.Fatal(err)
	}
	first := db + ".replaced-20261119T093000Z"
	firstSum := files(t, filepath.Dir(db))[filepath.Base(first)]
	other := filepath.Join(t.TempDir(), "other.db")
	closedDatabase(t, other, 5)
	r, err := Restore(context.Background(), other, db, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if r.Replaced[0] != first+"-2" {
		t.Errorf("the second restore's replaced database is %s, want %s", r.Replaced[0], first+"-2")
	}
	if got := files(t, filepath.Dir(db))[filepath.Base(first)]; got != firstSum {
		t.Error("the second restore changed the first one's replaced database")
	}
	if sessionsIn(t, first) != 10 || sessionsIn(t, first+"-2") != 3 || sessionsIn(t, db) != 5 {
		t.Errorf("the three databases hold %d, %d and %d sessions, want 10, 3 and 5",
			sessionsIn(t, first), sessionsIn(t, first+"-2"), sessionsIn(t, db))
	}
}

func TestRestore_IntoADataDirWithNoDatabase(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	source := filepath.Join(t.TempDir(), "backup.db")
	closedDatabase(t, source, 4)
	r, err := Restore(context.Background(), source, db, testNow)
	if err != nil || len(r.Replaced) != 0 || sessionsIn(t, db) != 4 {
		t.Fatalf("Restore into an empty data dir: %+v, %v", r, err)
	}
}

// A backup whose last transactions are in its own -wal beside it (a copy
// taken by hand of a live database) is restored whole. Its database and
// its log are not written to; SQLite reads a WAL-mode file through its
// shared-memory index (-shm), which it may update.
func TestRestore_ABackupWithALogBesideItIsRestoredWhole(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 1)
	source := filepath.Join(t.TempDir(), "hot.db")
	crashedDatabase(t, source, 6)
	before := files(t, filepath.Dir(source))
	if _, err := Restore(context.Background(), source, db, testNow); err != nil {
		t.Fatal(err)
	}
	if got := sessionsIn(t, db); got != 6 {
		t.Errorf("restored %d of the backup's 6 sessions", got)
	}
	after := files(t, filepath.Dir(source))
	for _, name := range []string{"hot.db", "hot.db-wal"} {
		if after[name] != before[name] {
			t.Errorf("restoring from %s changed it", name)
		}
	}
}

func TestRestore_ADamagedBackupChangesNothing(t *testing.T) {
	db, source := restoreSetup(t)
	whole, _ := os.ReadFile(source)
	if err := os.WriteFile(source, whole[:len(whole)/3], 0o600); err != nil {
		t.Fatal(err)
	}
	before := files(t, filepath.Dir(db))
	if _, err := Restore(context.Background(), source, db, testNow); err == nil || !strings.Contains(err.Error(), "nothing changed") {
		t.Fatalf("Restore of a truncated backup: %v", err)
	}
	sameFiles(t, filepath.Dir(db), before)
}

// restoreSteps are the steps of a restore of restoreSetup's database, in
// order, as the step hook names them: a moved file's step runs only when
// the crashed database has that file (crashedFiles).
func restoreSteps() []string {
	steps := []string{"staged", "marker"}
	for _, suffix := range crashedFiles()[1:] {
		steps = append(steps, "moved"+suffix)
	}
	return append(steps, "moved", "swapping", "swapped")
}

// A step that fails puts everything back: the data dir is file for file
// as it was.
func TestRestore_AFailureAtAnyStepPutsTheDatabaseBack(t *testing.T) {
	for _, at := range restoreSteps() {
		t.Run(at, func(t *testing.T) {
			db, source := restoreSetup(t)
			before := files(t, filepath.Dir(db))
			withStep(t, func(name string) error {
				if name == at {
					return errors.New("sabotage")
				}
				return nil
			})
			_, err := Restore(context.Background(), source, db, testNow)
			if err == nil || (!strings.Contains(err.Error(), "as it was") && !strings.Contains(err.Error(), "nothing changed")) {
				t.Fatalf("a restore that failed at %s: %v", at, err)
			}
			sameFiles(t, filepath.Dir(db), before)
			if got := sessionsIn(t, db); got != 10 {
				t.Errorf("the database holds %d sessions after the failed restore, want its 10", got)
			}
		})
	}
}

// A process that stops at any step (a crash, a power loss) leaves what
// the next start, which runs RecoverInterrupted, turns into a usable
// database: the one from before the restore, with every session its log
// held, or the restored one, never none and never an empty one.
func TestRestore_AProcessStoppedAtAnyStepLeavesADatabaseAStartCanUse(t *testing.T) {
	for _, at := range restoreSteps() {
		t.Run(at, func(t *testing.T) {
			db, source := restoreSetup(t)
			withStep(t, func(name string) error {
				if name == at {
					return errStop
				}
				return nil
			})
			if _, err := Restore(context.Background(), source, db, testNow); !errors.Is(err, errStop) {
				t.Fatalf("the restore did not stop at %s: %v", at, err)
			}
			withStep(t, func(string) error { return nil })
			note, err := RecoverInterrupted(context.Background(), db)
			if err != nil {
				t.Fatal(err)
			}
			want := int64(10)
			if at == "swapped" {
				want = 3
			}
			if got := sessionsIn(t, db); got != want {
				t.Errorf("after a stop at %s and the next start, the database holds %d sessions, want %d (note %q)", at, got, want, note)
			}
			if at != "staged" && note == "" {
				t.Errorf("the recovery after a stop at %s says nothing", at)
			}
			noRestoreLeft(t, db, at != "swapped")
			// A second recovery has nothing to do.
			if note, err := RecoverInterrupted(context.Background(), db); note != "" || err != nil {
				t.Errorf("a second recovery: %q, %v", note, err)
			}
		})
	}
}

// withRename makes the restore's renames go through hook for the test.
func withRename(t *testing.T, hook func(from, to string) error) {
	t.Helper()
	saved := rename
	rename = hook
	t.Cleanup(func() { rename = saved })
}

// A rename back that fails while a failed restore is being undone (a file
// held open, as on Windows) leaves the marker and the copy in place: the
// error says so, a start in that state refuses rather than create an
// empty database where the database is missing, and the next start or
// restore finishes putting the database back.
func TestRestore_AFailedRenameBackLeavesTheMarkerForTheNextStart(t *testing.T) {
	for _, at := range restoreSteps()[2:] {
		t.Run(at, func(t *testing.T) {
			db, source := restoreSetup(t)
			withStep(t, func(name string) error {
				if name == at {
					return errors.New("sabotage")
				}
				return nil
			})
			failedOnce := false
			withRename(t, func(from, to string) error {
				if strings.Contains(from, replacedInfix) && !failedOnce {
					failedOnce = true
					return errors.New("the file is in use")
				}
				return os.Rename(from, to)
			})
			_, err := Restore(context.Background(), source, db, testNow)
			if err == nil || !strings.Contains(err.Error(), "stays: the next start or restore reads it and finishes putting the database back") ||
				!failedOnce {
				t.Fatalf("a restore whose undo failed at %s: %v", at, err)
			}
			if _, err := os.Stat(db + markerSuffix); err != nil {
				t.Fatalf("the marker is gone after a failed undo: %v", err)
			}
			if _, err := os.Stat(db); err != nil {
				if lost := LostDatabase(db); lost == nil || !strings.Contains(lost.Error(), "flightdeck restore") {
					t.Errorf("the database is missing, and a start would not refuse: %v", lost)
				}
			}
			withRename(t, os.Rename)
			withStep(t, func(string) error { return nil })
			if _, err := RecoverInterrupted(context.Background(), db); err != nil {
				t.Fatal(err)
			}
			if got := sessionsIn(t, db); got != 10 {
				t.Errorf("after the next start the database holds %d sessions, want its 10", got)
			}
			noRestoreLeft(t, db, true)
		})
	}
}

// noRestoreLeft fails when a file of a restore is left beside db: its
// copy, its marker or the marker's next state, and when undone is set,
// a replaced database.
func noRestoreLeft(t *testing.T, db string, undone bool) {
	t.Helper()
	patterns := []string{db + restoringInfix + "*", db + markerSuffix, db + markerSuffix + nextSuffix}
	if undone {
		patterns = append(patterns, db+replacedInfix+"*")
	}
	for _, pattern := range patterns {
		if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
			t.Errorf("after the recovery %v is left", matches)
		}
	}
}

// markerState is the state the marker beside db records.
func markerState(t *testing.T, db string) string {
	t.Helper()
	m, ok, err := readMarker(db)
	if err != nil || !ok {
		t.Fatalf("the marker beside %s: %v (there: %v)", db, err, ok)
	}
	return m.State
}

// spoil makes the restored copy at db one that does not open, as a copy
// damaged after its check would be.
func spoil(t *testing.T, db string) {
	t.Helper()
	if err := os.WriteFile(db, []byte("not a database any more"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The restored copy does not open, moving it back off the database's name
// fails, and so would putting the replaced database back: the undo stops
// at the first failure, so nothing is renamed over the copy (on Unix a
// rename replaces its target), and the marker records that the restore
// is being undone. The next start puts the database back; it never keeps
// the copy that failed its check.
func TestRestore_ACopyThatFailsItsCheckAndCannotBeMovedBackIsUndoneByTheNextStart(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		recorded, replacedIsHeld bool
	}{
		{"the undo recorded, the replaced database held too", true, true},
		{"the undo recorded, only the copy held", true, false},
		{"recording the undo fails too", false, true},
	} {
		recorded := tc.recorded
		t.Run(tc.name, func(t *testing.T) {
			db, source := restoreSetup(t)
			withStep(t, func(name string) error {
				if name == "swapped" {
					spoil(t, db)
					if !recorded {
						// The marker's next state cannot be written where a
						// directory has its name.
						if err := os.Mkdir(db+markerSuffix+nextSuffix, 0o700); err != nil {
							t.Fatal(err)
						}
					}
				}
				return nil
			})
			overCopy := false
			withRename(t, func(from, to string) error {
				switch {
				case from == db && strings.Contains(to, restoringInfix):
					return errors.New("the copy is in use")
				case strings.Contains(from, replacedInfix) && tc.replacedIsHeld:
					return errors.New("the replaced database is in use")
				}
				if to == db && exists(db) {
					overCopy = true
				}
				return os.Rename(from, to)
			})
			_, err := Restore(context.Background(), source, db, testNow)
			want := "stays: the next start or restore reads it and finishes putting the database back"
			state := stateUndoing
			if !recorded {
				want = "keeps it only if it opens, and otherwise puts the database back"
				state = stateSwapping
			}
			if err == nil || !strings.Contains(err.Error(), "does not open") || !strings.Contains(err.Error(), want) {
				t.Fatalf("a restore whose copy did not open and whose undo failed: %v", err)
			}
			if overCopy {
				t.Error("the undo renamed a file over the restored copy")
			}
			if got := markerState(t, db); got != state {
				t.Errorf("the marker records %q, want %q", got, state)
			}
			if !recorded {
				_ = os.Remove(db + markerSuffix + nextSuffix)
			}

			withRename(t, os.Rename)
			withStep(t, func(string) error { return nil })
			note, err := RecoverInterrupted(context.Background(), db)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(note, "undone") {
				t.Errorf("the recovery says %q", note)
			}
			if got := sessionsIn(t, db); got != 10 {
				t.Errorf("after the next start the database holds %d sessions, want its 10", got)
			}
			noRestoreLeft(t, db, true)
		})
	}
}

// A process that stopped right after the swap leaves a copy no one has
// checked: the next start keeps it only if it opens, and puts the
// replaced database back when it does not.
func TestRecoverInterrupted_NeverTakesAnUncheckedSwapForAFinishedRestore(t *testing.T) {
	db, source := restoreSetup(t)
	withStep(t, func(name string) error {
		if name == "swapped" {
			return errStop
		}
		return nil
	})
	if _, err := Restore(context.Background(), source, db, testNow); !errors.Is(err, errStop) {
		t.Fatalf("the restore did not stop after the swap: %v", err)
	}
	if got := markerState(t, db); got != stateSwapping {
		t.Errorf("the marker of a restore stopped after its swap records %q", got)
	}
	spoil(t, db)
	withStep(t, func(string) error { return nil })
	note, err := RecoverInterrupted(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "does not open") || !strings.Contains(note, "undone") {
		t.Errorf("the recovery says %q", note)
	}
	if got := sessionsIn(t, db); got != 10 {
		t.Errorf("after the next start the database holds %d sessions, want its 10", got)
	}
	noRestoreLeft(t, db, true)
}

// A process that stopped while it undid a failed swap: the marker says
// so, and the next start finishes putting the database back.
func TestRestore_AProcessStoppedWhileUndoingLeavesTheUndoToTheNextStart(t *testing.T) {
	db, source := restoreSetup(t)
	withStep(t, func(name string) error {
		switch name {
		case "swapped":
			return errors.New("sabotage")
		case "undoing":
			return errStop
		}
		return nil
	})
	if _, err := Restore(context.Background(), source, db, testNow); !errors.Is(err, errStop) {
		t.Fatalf("the restore did not stop while undoing: %v", err)
	}
	if got := markerState(t, db); got != stateUndoing {
		t.Errorf("the marker records %q", got)
	}
	// The copy opens: the marker, not a check, decides that it goes.
	if got := sessionsIn(t, db); got != 3 {
		t.Fatalf("the copy holds %d sessions", got)
	}
	withStep(t, func(string) error { return nil })
	note, err := RecoverInterrupted(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "was putting the database back") {
		t.Errorf("the recovery says %q", note)
	}
	if got := sessionsIn(t, db); got != 10 {
		t.Errorf("after the next start the database holds %d sessions, want its 10", got)
	}
	noRestoreLeft(t, db, true)
}

// A state written to the marker's next file but not yet renamed over the
// marker is dropped: the marker's own state is the one acted on.
func TestRecoverInterrupted_DropsAStateNotYetRecorded(t *testing.T) {
	db, source := restoreSetup(t)
	withStep(t, func(name string) error {
		if name == "moved" {
			return errStop
		}
		return nil
	})
	if _, err := Restore(context.Background(), source, db, testNow); !errors.Is(err, errStop) {
		t.Fatalf("the restore did not stop: %v", err)
	}
	if err := os.WriteFile(db+markerSuffix+nextSuffix, []byte(`{"staged":"flightdeck.db.rest`), 0o600); err != nil {
		t.Fatal(err)
	}
	withStep(t, func(string) error { return nil })
	if _, err := RecoverInterrupted(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	if got := sessionsIn(t, db); got != 10 {
		t.Errorf("after the next start the database holds %d sessions, want its 10", got)
	}
	noRestoreLeft(t, db, true)
}

// A start that finds no database but one a restore replaced refuses,
// naming it and the command that puts it back, instead of creating an
// empty database in its place.
func TestLostDatabase_RefusesToStartAnEmptyDatabaseInPlaceOfAReplacedOne(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "flightdeck.db")
	if err := LostDatabase(db); err != nil {
		t.Errorf("an empty data dir: %v", err)
	}
	replaced := db + replacedInfix + "20261119T093000Z"
	closedDatabase(t, replaced, 1)
	_ = os.WriteFile(replaced+"-wal", nil, 0o600)
	err := LostDatabase(db)
	if err == nil || !strings.Contains(err.Error(), "flightdeck restore "+replaced) || strings.Contains(err.Error(), replaced+"-wal,") {
		t.Errorf("no database and a replaced one: %v", err)
	}
	closedDatabase(t, db, 1)
	if err := LostDatabase(db); err != nil {
		t.Errorf("a database beside a replaced one: %v", err)
	}
}

func TestRecoverInterrupted_AMarkerCutShortSaysNothingMoved(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 2)
	_ = os.WriteFile(db+markerSuffix, []byte(`{"staged":"flightdeck.db.rest`), 0o600)
	_, err := RecoverInterrupted(context.Background(), db)
	if err == nil || !strings.Contains(err.Error(), "before it moved any file") || !strings.Contains(err.Error(), "Remove it ("+db+markerSuffix+")") {
		t.Errorf("a marker cut short: %v", err)
	}
}

func TestRecoverInterrupted_RenamesNothingOnAMarkerItDidNotWrite(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 2)
	victim := filepath.Join(filepath.Dir(db), "elsewhere.db")
	_ = os.WriteFile(victim, []byte("keep"), 0o600)
	for _, content := range []string{
		`{"staged":"flightdeck.db.restoring-x","replaced":"../../etc/passwd","state":"moving"}`,
		`{"staged":"elsewhere.db","replaced":"flightdeck.db.replaced-x","state":"undoing"}`,
		`{"staged":"flightdeck.db.restoring-x","replaced":"flightdeck.db.replaced-x"}`,
		`{"staged":"flightdeck.db.restoring-x","replaced":"flightdeck.db.replaced-x","state":"done"}`,
		`not json`,
	} {
		_ = os.WriteFile(db+markerSuffix, []byte(content), 0o600)
		before := files(t, filepath.Dir(db))
		if _, err := RecoverInterrupted(context.Background(), db); err == nil {
			t.Errorf("a marker %s was acted on", content)
		}
		sameFiles(t, filepath.Dir(db), before)
	}
}
