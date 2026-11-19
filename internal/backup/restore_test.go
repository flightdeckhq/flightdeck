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
	return append(steps, "moved", "swapped")
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
			note, err := RecoverInterrupted(db)
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
			for _, pattern := range []string{db + restoringInfix + "*", db + markerSuffix} {
				if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
					t.Errorf("after a stop at %s and the recovery, %v is left", at, matches)
				}
			}
			if at != "swapped" {
				if matches, _ := filepath.Glob(db + replacedInfix + "*"); len(matches) > 0 {
					t.Errorf("an undone restore left %v", matches)
				}
			}
			// A second recovery has nothing to do.
			if note, err := RecoverInterrupted(db); note != "" || err != nil {
				t.Errorf("a second recovery: %q, %v", note, err)
			}
		})
	}
}

func TestRecoverInterrupted_RenamesNothingOnAMarkerItDidNotWrite(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 2)
	victim := filepath.Join(filepath.Dir(db), "elsewhere.db")
	_ = os.WriteFile(victim, []byte("keep"), 0o600)
	for _, content := range []string{
		`{"staged":"flightdeck.db.restoring-x","replaced":"../../etc/passwd"}`,
		`{"staged":"elsewhere.db","replaced":"flightdeck.db.replaced-x"}`,
		`not json`,
	} {
		_ = os.WriteFile(db+markerSuffix, []byte(content), 0o600)
		before := files(t, filepath.Dir(db))
		if _, err := RecoverInterrupted(db); err == nil {
			t.Errorf("a marker %s was acted on", content)
		}
		sameFiles(t, filepath.Dir(db), before)
	}
}
