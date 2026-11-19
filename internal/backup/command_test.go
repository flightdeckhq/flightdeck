package backup

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

type cmdRun struct {
	stdout, stderr bytes.Buffer
	env            map[string]string
	hint           func(context.Context, int) string
}

func (c *cmdRun) main(command string, args ...string) int {
	c.stdout.Reset()
	c.stderr.Reset()
	// A command names its data dir's tmp as SQLite's temporary directory,
	// a setting of the process: in the binary each command is a process
	// of its own, here the next test must not inherit a directory that is
	// removed with this test's.
	defer storage.SetSQLiteTempDir("")
	return Main(context.Background(), command, args, IO{
		Stdout:      &c.stdout,
		Stderr:      &c.stderr,
		Getenv:      func(k string) string { return c.env[k] },
		Now:         func() time.Time { return testNow },
		ServiceHint: c.hint,
	})
}

func (c *cmdRun) output() string { return c.stdout.String() + c.stderr.String() }

// databaseFiles are the files of the database in dir: what a refused
// restore must leave as it found it (the lock files and the directories
// the command makes for itself aside).
func databaseFiles(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for name, sum := range files(t, dir) {
		if strings.HasPrefix(name, datadir.DatabaseFile) && !strings.HasSuffix(name, ".lock") {
			out[name] = sum
		}
	}
	return out
}

func sameDatabaseFiles(t *testing.T, dir string, before map[string]string) {
	t.Helper()
	after := databaseFiles(t, dir)
	if len(after) != len(before) {
		t.Errorf("the database's files changed: before %v, after %v", names(before), names(after))
		return
	}
	for name, sum := range before {
		if after[name] != sum {
			t.Errorf("%s changed", name)
		}
	}
}

func TestBackupCommand_WritesToTheDataDirOrTheFileGiven(t *testing.T) {
	data := t.TempDir()
	closedDatabase(t, filepath.Join(data, datadir.DatabaseFile), 3)
	var c cmdRun
	if code := c.main("backup", "--data-dir", data); code != ExitOK {
		t.Fatalf("backup exited %d:\n%s", code, c.output())
	}
	want := filepath.Join(data, "backups", "flightdeck-20261119T093000Z.db")
	if !strings.Contains(c.stdout.String(), want) || !strings.Contains(c.stdout.String(), "3 sessions") {
		t.Errorf("the output does not name %s and its sessions:\n%s", want, c.output())
	}
	if sessionsIn(t, want) != 3 {
		t.Error("the default backup does not hold the sessions")
	}
	// The variable names the data dir as the server reads it, and the file
	// may come before or after the flags; a directory gets the default
	// name inside it.
	out := t.TempDir()
	c.env = map[string]string{"FLIGHTDECK_DATA_DIR": data}
	if code := c.main("backup", out); code != ExitOK {
		t.Fatalf("backup to a directory exited %d:\n%s", code, c.output())
	}
	if _, err := os.Stat(filepath.Join(out, "flightdeck-20261119T093000Z.db")); err != nil {
		t.Errorf("a backup to a directory: %v", err)
	}
	if code := c.main("backup", filepath.Join(out, "named.db"), "--data-dir", data); code != ExitOK || sessionsIn(t, filepath.Join(out, "named.db")) != 3 {
		t.Errorf("a backup with the file before the flags exited %d:\n%s", code, c.output())
	}
	if code := c.main("backup", filepath.Join(out, "named.db"), "--data-dir", data); code != ExitFailed ||
		!strings.Contains(c.stderr.String(), "already exists") {
		t.Errorf("a backup over an existing file exited %d:\n%s", code, c.output())
	}
	if code := c.main("backup", "a.db", "b.db", "--data-dir", data); code != ExitUsage {
		t.Errorf("two files exited %d", code)
	}
	if code := c.main("backup", "--data-dir", t.TempDir()); code != ExitFailed || !strings.Contains(c.stderr.String(), "no SQLite database") {
		t.Errorf("a data dir with no database exited %d:\n%s", code, c.output())
	}
}

func TestCommands_RefuseAPostgresDatabaseWithTheCommandToUse(t *testing.T) {
	var c cmdRun
	url := "postgres://fd:secretpw@db.internal:5432/fd"
	for command, want := range map[string]string{"backup": "pg_dump", "restore": "psql"} {
		args := []string{"--database-url", url}
		if command == "restore" {
			args = append(args, filepath.Join(t.TempDir(), "x.sql"))
		}
		if code := c.main(command, args...); code != ExitPostgres || !strings.Contains(c.stderr.String(), want) ||
			strings.Contains(c.output(), "secretpw") {
			t.Errorf("%s on Postgres exited %d:\n%s", command, code, c.output())
		}
	}
}

// A restore while a flightdeck holds either of the database's locks
// changes nothing, names the PID, and names the service's commands when
// the service is what holds it.
func TestRestoreCommand_RefusesWhileAFlightdeckHoldsTheDatabase(t *testing.T) {
	data := t.TempDir()
	db := filepath.Join(data, datadir.DatabaseFile)
	closedDatabase(t, db, 3)
	backup := filepath.Join(t.TempDir(), "backup.db")
	closedDatabase(t, backup, 1)
	before := databaseFiles(t, data)
	for _, lock := range []string{filepath.Join(data, datadir.LockFile), db + datadir.DatabaseLockSuffix} {
		held, err := datadir.Acquire(lock)
		if err != nil {
			t.Fatal(err)
		}
		c := cmdRun{hint: func(_ context.Context, pid int) string {
			if pid == os.Getpid() {
				return "Stop it with flightdeck service remove"
			}
			return ""
		}}
		code := c.main("restore", backup, "--data-dir", data)
		held.Release()
		if code != ExitInUse || !strings.Contains(c.stderr.String(), "pid") || !strings.Contains(c.stderr.String(), "flightdeck service remove") {
			t.Errorf("a restore while %s is held exited %d:\n%s", filepath.Base(lock), code, c.output())
		}
		sameDatabaseFiles(t, data, before)
	}
}

// What is not a backup of this database is refused before anything is
// moved: the database itself, a file SQLite keeps beside it, a file that
// is not SQLite, a truncated one, one of another schema, one a newer
// release wrote, one whose migration did not finish.
func TestRestoreCommand_RefusesWhatIsNotABackupAndChangesNothing(t *testing.T) {
	ctx := context.Background()
	data := t.TempDir()
	db := filepath.Join(data, datadir.DatabaseFile)
	crashedDatabase(t, db, 4)
	dir := t.TempDir()
	good := filepath.Join(dir, "good.db")
	closedDatabase(t, good, 2)
	whole, _ := os.ReadFile(good)
	latest, _ := storage.LatestVersion(storage.SQLite)
	write := func(name string, content []byte) string {
		path := filepath.Join(dir, name)
		_ = os.WriteFile(path, content, 0o600)
		return path
	}
	newer := filepath.Join(dir, "newer.db")
	nh := newDatabase(t, newer, 0)
	if _, err := nh.ExecContext(ctx, `UPDATE schema_migrations SET version = ?`, latest+1); err != nil {
		t.Fatal(err)
	}
	_ = nh.Close()
	dirty := filepath.Join(dir, "dirty.db")
	dh := newDatabase(t, dirty, 0)
	if _, err := dh.ExecContext(ctx, `UPDATE schema_migrations SET dirty = 1`); err != nil {
		t.Fatal(err)
	}
	_ = dh.Close()
	other := filepath.Join(dir, "other.db")
	oh, err := storage.Open(ctx, storage.SQLiteURL(other))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = oh.ExecContext(ctx, `CREATE TABLE notes (x TEXT)`)
	_ = oh.Close()

	for name, tc := range map[string]struct{ source, want string }{
		"the database itself": {db, "the database itself"},
		"its write-ahead log": {db + "-wal", "a file SQLite keeps beside the database"},
		"not SQLite":          {write("notes.txt", bytes.Repeat([]byte("not a database\n"), 500)), "is not a SQLite database"},
		"truncated":           {write("truncated.db", whole[:len(whole)/2]), "is damaged"},
		"another schema":      {other, "not a Flightdeck one"},
		"newer":               {newer, "a newer release wrote it"},
		"dirty":               {dirty, "had not finished"},
		"missing":             {filepath.Join(dir, "missing.db"), "is not there"},
	} {
		before := databaseFiles(t, data)
		var c cmdRun
		code := c.main("restore", tc.source, "--data-dir", data)
		if code != ExitFailed || !strings.Contains(c.stderr.String(), tc.want) || !strings.Contains(c.stderr.String(), "Nothing changed") {
			t.Errorf("%s: exited %d:\n%s", name, code, c.output())
		}
		sameDatabaseFiles(t, data, before)
	}
	if code := (&cmdRun{}).main("restore", "--data-dir", data); code != ExitUsage {
		t.Errorf("restore with no file exited %d", code)
	}
}

// A data dir reached through a symbolic link is restored in the
// directory the link points to, where the server's database is, and the
// replaced database is kept there.
func TestRestoreCommand_ThroughALinkedDataDir(t *testing.T) {
	real := t.TempDir()
	closedDatabase(t, filepath.Join(real, datadir.DatabaseFile), 6)
	link := filepath.Join(t.TempDir(), "data")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symbolic links are not available here:", err)
	}
	backup := filepath.Join(t.TempDir(), "backup.db")
	closedDatabase(t, backup, 2)
	var c cmdRun
	if code := c.main("restore", backup, "--data-dir", link); code != ExitOK {
		t.Fatalf("restore through a linked data dir exited %d:\n%s", code, c.output())
	}
	realDB, _ := filepath.EvalSymlinks(filepath.Join(real, datadir.DatabaseFile))
	if sessionsIn(t, realDB) != 2 || sessionsIn(t, realDB+".replaced-20261119T093000Z") != 6 {
		t.Errorf("the restore did not happen in the linked directory:\n%s", c.output())
	}
	if !strings.Contains(c.stdout.String(), "The database it replaced is "+realDB+".replaced-20261119T093000Z") {
		t.Errorf("the output does not name the replaced database:\n%s", c.output())
	}
}

// An interrupted restore found by the next restore is undone first, and
// said so.
func TestRestoreCommand_UndoesAnInterruptedRestoreFirst(t *testing.T) {
	data := t.TempDir()
	db := filepath.Join(data, datadir.DatabaseFile)
	closedDatabase(t, db, 4)
	backup := filepath.Join(t.TempDir(), "backup.db")
	closedDatabase(t, backup, 2)
	withStep(t, func(name string) error {
		if name == "moved" {
			return errStop
		}
		return nil
	})
	if _, err := Restore(context.Background(), backup, db, testNow); err == nil {
		t.Fatal("the restore did not stop")
	}
	withStep(t, func(string) error { return nil })
	var c cmdRun
	if code := c.main("restore", backup, "--data-dir", data); code != ExitOK {
		t.Fatalf("the next restore exited %d:\n%s", code, c.output())
	}
	if !strings.Contains(c.stdout.String(), "was interrupted before it finished; it is undone") {
		t.Errorf("the next restore does not say it undid the interrupted one:\n%s", c.output())
	}
	if sessionsIn(t, db) != 2 || sessionsIn(t, db+".replaced-20261119T093000Z") != 4 {
		t.Errorf("after the second restore:\n%s", c.output())
	}
}
