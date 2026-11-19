package backup

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/cli"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

// The exit statuses of `flightdeck backup` and `flightdeck restore`.
const (
	// ExitOK: backed up, or restored.
	ExitOK = 0
	// ExitFailed: a step failed or the file was refused; nothing changed
	// unless the message says otherwise.
	ExitFailed = 1
	// ExitUsage: an unknown flag, a missing or extra argument.
	ExitUsage = 2
	// ExitInUse: restore found a flightdeck holding the database.
	ExitInUse = 3
	// ExitPostgres: the database is Postgres, which pg_dump and psql back
	// up and restore; the message has the command.
	ExitPostgres = 4
)

// IO is what one run of a command reads and writes.
type IO struct {
	Stdout io.Writer
	Stderr io.Writer
	// Getenv reads the server's variables (FLIGHTDECK_DATA_DIR and the
	// database's), as the server does.
	Getenv func(string) string
	// Now is the clock of the names written.
	Now func() time.Time
	// ServiceHint, given the PID that holds the data dir, returns what
	// stops the installed service when that PID is the service, and ""
	// otherwise; nil asks nothing.
	ServiceHint func(ctx context.Context, pid int) string
}

// Main runs `flightdeck backup` or `flightdeck restore` (command) with
// args, the words after it, and returns the exit status.
func Main(ctx context.Context, command string, args []string, rt IO) int {
	if rt.Now == nil {
		rt.Now = time.Now
	}
	switch command {
	case cli.BackupCommand:
		return backupMain(ctx, args, rt)
	case cli.RestoreCommand:
		return restoreMain(ctx, args, rt)
	}
	_, _ = fmt.Fprintf(rt.Stderr, "flightdeck: no command %q\n", command)
	return ExitUsage
}

func fail(rt IO, command string, status int, format string, a ...any) int {
	_, _ = fmt.Fprintf(rt.Stderr, "flightdeck "+command+": "+format+"\n", a...)
	return status
}

// database is the database a command works on.
type database struct {
	// path is the SQLite file, absolute and with its links resolved: the
	// file the server would open with the same flags.
	path string
	// dataDir is the data dir, absolute.
	dataDir string
	// postgres is set, to the URL with its password masked, when the
	// database is Postgres.
	postgres string
}

// databaseOf finds the database the server would open with opts: the
// SQLite file in the data dir, or the file --database-url names, by the
// path the server resolves it to.
func databaseOf(opts cli.Options) (database, error) {
	dataDir, err := filepath.Abs(opts.DataDir)
	if err != nil {
		return database{}, fmt.Errorf("data dir %q: %w", opts.DataDir, err)
	}
	path := filepath.Join(dataDir, datadir.DatabaseFile)
	if opts.DatabaseURL != "" {
		backend, err := storage.BackendOf(opts.DatabaseURL)
		if err != nil {
			return database{}, err
		}
		if backend == storage.Postgres {
			return database{dataDir: dataDir, postgres: storage.MaskURL(opts.DatabaseURL)}, nil
		}
		if path, err = filepath.Abs(storage.SQLitePath(opts.DatabaseURL)); err != nil {
			return database{}, err
		}
	}
	resolved, err := storage.ResolveSQLitePath(path)
	if err != nil {
		return database{}, fmt.Errorf("the database %s: %w", path, err)
	}
	return database{path: resolved, dataDir: dataDir}, nil
}

// parse reads a command's line: the server's flags, of which the data
// dir and the database are read, and at most one file.
func parse(rt IO, command, usage string, args []string) (cli.Options, int, bool) {
	opts, err := cli.ParseCommand(args, rt.Getenv, rt.Stderr, cli.Command{
		Name:    "flightdeck " + command,
		Flags:   func(*flag.FlagSet) {},
		Usage:   func(w io.Writer) { _, _ = io.WriteString(w, usage) },
		MaxArgs: 1,
	})
	switch {
	case errors.Is(err, cli.ErrHelp):
		return cli.Options{}, ExitOK, false
	case err != nil:
		return cli.Options{}, fail(rt, command, ExitUsage, "%v", err), false
	}
	return opts, 0, true
}

// useTempDir names the data dir's tmp for SQLite's temporary files when
// it is there (the server makes it), so a copy in a container whose root
// file system is read-only writes nothing outside the data dir.
func useTempDir(dataDir string) {
	tmp := filepath.Join(dataDir, "tmp")
	if info, err := os.Stat(tmp); err == nil && info.IsDir() {
		storage.SetSQLiteTempDir(tmp)
	}
}

const backupUsage = `Usage: flightdeck backup [<file>] [flags]

Copies the SQLite database Flightdeck keeps (the file in --data-dir, else in
$FLIGHTDECK_DATA_DIR or the default data dir; or the one --database-url names)
to <file>, or with no <file> to <data dir>/backups/flightdeck-<UTC time>.db. A
<file> that is a directory gets that name inside it. It runs while Flightdeck
runs or not, and never writes over a file that exists. The copy is checked
(PRAGMA integrity_check) before the command says it is done; keep it on
another disk or another machine. flightdeck restore <file> puts it back.

On Postgres it changes nothing and prints the pg_dump command to use.

Exit status: 0 backed up; 1 a step failed, and nothing was written; 2 a usage
error; 4 the database is Postgres.

Flags (the server's; the data dir and the database flags are read):
`

func backupMain(ctx context.Context, args []string, rt IO) int {
	const command = "backup"
	opts, code, ok := parse(rt, command, backupUsage, args)
	if !ok {
		return code
	}
	db, err := databaseOf(opts)
	if err != nil {
		return fail(rt, command, ExitUsage, "%v", err)
	}
	if db.postgres != "" {
		return fail(rt, command, ExitPostgres, "the database is Postgres (%s), which pg_dump backs up while Flightdeck runs: "+
			"pg_dump --no-owner -d '<database url>' > flightdeck.sql (guides/self-hosting.md has the restore). Nothing was written", db.postgres)
	}
	if _, err := os.Stat(db.path); err != nil {
		return fail(rt, command, ExitFailed, "there is no SQLite database at %s, so nothing to back up: give the --data-dir "+
			"(or --database-url) Flightdeck runs with", db.path)
	}
	useTempDir(db.dataDir)
	var target string
	switch {
	case len(opts.Args) == 0:
		target, err = DefaultTarget(filepath.Join(db.dataDir, datadir.BackupsDir), rt.Now())
	default:
		target, err = filepath.Abs(opts.Args[0])
		if info, serr := os.Stat(target); err == nil && serr == nil && info.IsDir() {
			target, err = DefaultTarget(target, rt.Now())
		}
	}
	if err != nil {
		return fail(rt, command, ExitFailed, "%v", err)
	}
	c, err := Backup(ctx, db.path, target)
	if err != nil {
		return fail(rt, command, ExitFailed, "%v. Nothing was written", err)
	}
	_, _ = fmt.Fprintf(rt.Stdout, "Backed up %s to %s: schema version %d, %d sessions, %d events, %s, checked.\n",
		db.path, c.Path, c.File.Version, c.File.Sessions, c.File.Events, human(uint64(c.Bytes)))
	_, _ = fmt.Fprintf(rt.Stdout, "Keep a copy on another disk or another machine; flightdeck restore %s puts it back.\n", c.Path)
	return ExitOK
}

const restoreUsage = `Usage: flightdeck restore <file> [flags]

Replaces the SQLite database Flightdeck keeps (the file in --data-dir, else in
$FLIGHTDECK_DATA_DIR or the default data dir; or the one --database-url names)
with the backup in <file>. Flightdeck must be stopped: restore refuses while a
flightdeck holds the database. It checks the backup first and refuses one that
is not a Flightdeck database, is damaged, or comes from a newer release. The
database it replaces is kept, with its write-ahead log, as
flightdeck.db.replaced-<UTC time> beside it; nothing is deleted. If a step
fails, the database is put back as it was. A backup from an older release is
migrated forward by the next start.

On Postgres it changes nothing and prints the psql command to use.

Exit status: 0 restored; 1 a step failed or the backup was refused, and the
database is as it was; 2 a usage error; 3 a flightdeck holds the database;
4 the database is Postgres.

Flags (the server's; the data dir and the database flags are read):
`

func restoreMain(ctx context.Context, args []string, rt IO) int {
	const command = "restore"
	opts, code, ok := parse(rt, command, restoreUsage, args)
	if !ok {
		return code
	}
	if len(opts.Args) != 1 {
		_, _ = io.WriteString(rt.Stderr, restoreUsage)
		return fail(rt, command, ExitUsage, "name the backup to restore: flightdeck restore <file>")
	}
	// A restore into a data dir that is not there yet makes it, as the
	// server does at its first start, so its database's path resolves.
	var layout datadir.Layout
	if backend, _ := storage.BackendOf(opts.DatabaseURL); opts.DatabaseURL == "" || backend == storage.SQLite {
		l, err := datadir.Ensure(opts.DataDir)
		if err != nil {
			return fail(rt, command, ExitFailed, "%v. Nothing changed", err)
		}
		layout = l
	}
	db, err := databaseOf(opts)
	if err != nil {
		return fail(rt, command, ExitFailed, "%v. Nothing changed", err)
	}
	if db.postgres != "" {
		return fail(rt, command, ExitPostgres, "the database is Postgres (%s), which psql restores from a pg_dump file into a "+
			"new database: psql -v ON_ERROR_STOP=1 -1 -d '<restore url>' < flightdeck.sql (guides/self-hosting.md has every step). "+
			"Nothing changed", db.postgres)
	}
	source, err := filepath.Abs(opts.Args[0])
	if err != nil {
		return fail(rt, command, ExitUsage, "%v", err)
	}
	if info, err := os.Stat(source); errors.Is(err, fs.ErrNotExist) {
		return fail(rt, command, ExitFailed, "the backup %s is not there. Nothing changed", source)
	} else if err != nil {
		return fail(rt, command, ExitFailed, "the backup %s cannot be read: %s. Nothing changed", source, clause(err))
	} else if !info.Mode().IsRegular() {
		return fail(rt, command, ExitFailed, "the backup %s is not a file. Nothing changed", source)
	}

	for _, lock := range []string{layout.Lock, db.path + datadir.DatabaseLockSuffix} {
		l, err := datadir.Acquire(lock)
		if err != nil {
			return inUse(ctx, rt, err, db.path)
		}
		defer l.Release()
	}
	if _, err := datadir.PrepareTmp(layout.Tmp); err == nil {
		storage.SetSQLiteTempDir(layout.Tmp)
	}
	if note, err := RecoverInterrupted(db.path); err != nil {
		return fail(rt, command, ExitFailed, "%v", err)
	} else if note != "" {
		_, _ = fmt.Fprintln(rt.Stdout, strings.ToUpper(note[:1])+note[1:]+".")
	}
	if reason := notABackup(source, db.path); reason != "" {
		return fail(rt, command, ExitFailed, "%s is %s, not a backup of it. Nothing changed", source, reason)
	}
	f, err := storage.CheckSQLiteFile(ctx, source, storage.CheckFull)
	if err != nil {
		return fail(rt, command, ExitFailed, "%s", refusal(source, err))
	}
	latest, err := storage.LatestVersion(storage.SQLite)
	if err != nil {
		return fail(rt, command, ExitFailed, "%v", err)
	}
	switch {
	case f.Dirty:
		return fail(rt, command, ExitFailed, "the backup %s was taken while a migration to schema version %d had not finished, "+
			"so it may be half migrated; restore another one. Nothing changed", source, f.Version)
	case f.Version > latest:
		return fail(rt, command, ExitFailed, "the backup %s has schema version %d, and this release of Flightdeck knows versions up "+
			"to %d: a newer release wrote it. Install that release or a newer one, then restore it. Nothing changed",
			source, f.Version, latest)
	}
	r, err := Restore(ctx, source, db.path, rt.Now())
	if err != nil {
		return fail(rt, command, ExitFailed, "%v", err)
	}
	w := rt.Stdout
	_, _ = fmt.Fprintf(w, "Restored %s into %s: schema version %d, %d sessions, %d events.\n",
		source, db.path, r.File.Version, r.File.Sessions, r.File.Events)
	if r.File.Version < latest {
		_, _ = fmt.Fprintf(w, "It is from an older release: the next start migrates it to version %d, and keeps a copy first.\n", latest)
	}
	if len(r.Replaced) > 0 {
		_, _ = fmt.Fprintf(w, "The database it replaced is %s; remove it once Flightdeck shows what you expect.\n",
			strings.Join(r.Replaced, ", "))
	} else {
		_, _ = fmt.Fprintln(w, "There was no database there before.")
	}
	_, _ = fmt.Fprintln(w, "Start Flightdeck on this data dir (flightdeck service install, if it ran as a service).")
	return ExitOK
}

// notABackup says what source is when it is a file of the database
// itself (by name, or the same file through a link), or one a restore
// keeps beside it while it runs; "" otherwise. A database a restore
// replaced (<db>.replaced-…) is a backup like any other.
func notABackup(source, db string) string {
	switch {
	case same(source, db):
		return "the database itself"
	case same(source, db+"-wal"), same(source, db+"-shm"):
		return "a file SQLite keeps beside the database"
	case filepath.Dir(source) == filepath.Dir(db) &&
		(strings.HasPrefix(filepath.Base(source), filepath.Base(db)+restoringInfix) || filepath.Base(source) == filepath.Base(db)+markerSuffix):
		return "a file of a restore under way"
	}
	return ""
}

// refusal says why a file cannot be restored.
func refusal(source string, err error) string {
	var damaged *storage.DamagedError
	switch {
	case errors.Is(err, storage.ErrNotSQLite):
		return source + " is not a SQLite database. Nothing changed"
	case errors.As(err, &damaged):
		return fmt.Sprintf("%s is damaged (%s): it may have been cut short while it was copied. Nothing changed",
			source, strings.Join(damaged.Problems, "; "))
	case errors.Is(err, storage.ErrNoSchema):
		return source + " is a SQLite database but not a Flightdeck one: it has no Flightdeck schema. Nothing changed"
	}
	return fmt.Sprintf("%s cannot be read: %s. Nothing changed", source, clause(err))
}

// clause is err's message as a clause of a sentence: without the
// period Windows ends its system messages with.
func clause(err error) string {
	return strings.TrimRight(err.Error(), ". ")
}

// inUse turns a lock another process holds into the message: its PID,
// and when it is the installed service, the commands that stop and
// start it.
func inUse(ctx context.Context, rt IO, err error, db string) int {
	var held *datadir.InUseError
	if !errors.As(err, &held) {
		return fail(rt, "restore", ExitFailed, "%v. Nothing changed", err)
	}
	who := "a flightdeck"
	if held.PID > 0 {
		who = fmt.Sprintf("a flightdeck (pid %d)", held.PID)
	}
	msg := fmt.Sprintf("%s holds %s, and restore replaces the database only while none does: stop it (Ctrl+C in its terminal), "+
		"then run this again. Nothing changed", who, db)
	if rt.ServiceHint != nil && held.PID > 0 {
		if hint := rt.ServiceHint(ctx, held.PID); hint != "" {
			msg = fmt.Sprintf("%s holds %s: it is the Flightdeck service, and restore replaces the database only while it is "+
				"stopped. %s. Nothing changed", who, db, hint)
		}
	}
	return fail(rt, "restore", ExitInUse, "%s", msg)
}
