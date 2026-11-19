package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"strconv"
	"strings"

	"modernc.org/sqlite"
)

// The SQL of `flightdeck backup` and `flightdeck restore`: a snapshot of
// a SQLite database into another file, and the check of a file that is
// to be trusted as a Flightdeck database. Both open the database
// read-only, through a connection of their own, so a server writing to
// it at the same time is neither blocked nor changed, and a file given
// to be checked is never written to.

// ErrNotSQLite is returned for a file SQLite does not recognise as a
// database (SQLite's "file is not a database").
var ErrNotSQLite = errors.New("not a SQLite database")

// ErrNoSchema is returned for a SQLite database with no Flightdeck
// schema: no schema_migrations table, or no migration recorded in it.
var ErrNoSchema = errors.New("not a Flightdeck database (it has no Flightdeck schema)")

// DamagedError reports a SQLite database that does not read back whole:
// what PRAGMA integrity_check found, or the error a read failed with (a
// truncated file is the usual case).
type DamagedError struct {
	// Problems are the first lines integrity_check printed, or the error.
	Problems []string
}

func (e *DamagedError) Error() string {
	return "damaged: " + strings.Join(e.Problems, "; ")
}

// maxIntegrityProblems bounds how many of integrity_check's lines a
// DamagedError keeps: the first few say what is wrong, and a damaged
// file can produce thousands.
const maxIntegrityProblems = 5

// SQLiteFile is what CheckSQLiteFile read of a database file.
type SQLiteFile struct {
	// Version is the schema version schema_migrations records.
	Version uint
	// Dirty is true when that migration did not finish.
	Dirty bool
	// Sessions and Events count the rows of the two tables.
	Sessions, Events int64
}

// CheckLevel is how much CheckSQLiteFile reads.
type CheckLevel int

const (
	// CheckOpens reads the schema version and the counts: the file is a
	// Flightdeck database that opens.
	CheckOpens CheckLevel = iota
	// CheckFull also runs PRAGMA integrity_check, which reads every page.
	CheckFull
)

// sqliteReadOnlyDSN is the DSN of a read-only connection to the SQLite
// file at path: it never creates the file or changes it, and on a
// database in WAL mode it reads what the write-ahead log holds as well,
// beside a server that writes. It sets no journal mode, which a writer
// would record in the file. With SetSQLiteTempDir it names that
// directory for SQLite's temporary files.
func sqliteReadOnlyDSN(path string) string {
	q := url.Values{}
	q.Set("mode", "ro")
	q["_pragma"] = []string{fmt.Sprintf("busy_timeout(%d)", sqliteBusyTimeoutMillis)}
	if tempDir := sqliteTempDirPragma(); tempDir != "" {
		q["_pragma"] = append(q["_pragma"], tempDir)
	}
	return sqliteFileURI(path) + "?" + q.Encode()
}

func openReadOnly(path string) (*sql.DB, error) {
	h, err := sql.Open(sqliteDriverName, sqliteReadOnlyDSN(path))
	if err != nil {
		return nil, fmt.Errorf("storage: open %s: %w", path, err)
	}
	h.SetMaxOpenConns(1)
	return h, nil
}

// SQLiteSnapshot writes a copy of the SQLite database at src into dst
// with VACUUM INTO: one read transaction on a read-only connection, so
// the copy is the database as of one moment, the write-ahead log's
// committed transactions included, compacted, and in rollback-journal
// mode (one file). dst must not exist or must be an empty file, which
// keeps the mode it was created with. A src SQLite does not recognise
// is ErrNotSQLite.
func SQLiteSnapshot(ctx context.Context, src, dst string) error {
	h, err := openReadOnly(src)
	if err != nil {
		return err
	}
	defer func() { _ = h.Close() }()
	if _, err := h.ExecContext(ctx, "VACUUM INTO ?", dst); err != nil {
		return classifySQLiteFileError(err)
	}
	return nil
}

// CheckSQLiteFile opens the SQLite file at path read-only and reads what
// trusting it as a Flightdeck database needs: that SQLite recognises it
// (ErrNotSQLite), that it has a Flightdeck schema (ErrNoSchema) and its
// version, the count of sessions and events, and with CheckFull that
// PRAGMA integrity_check finds nothing (DamagedError). A read that fails
// partway is a DamagedError too.
func CheckSQLiteFile(ctx context.Context, path string, level CheckLevel) (SQLiteFile, error) {
	h, err := openReadOnly(path)
	if err != nil {
		return SQLiteFile{}, err
	}
	defer func() { _ = h.Close() }()
	var tables int
	if err := h.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master`).Scan(&tables); err != nil {
		return SQLiteFile{}, classifySQLiteFileError(err)
	}
	if level == CheckFull {
		if err := integrityCheck(ctx, h); err != nil {
			return SQLiteFile{}, err
		}
	}
	var hasTable int
	if err := h.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).Scan(&hasTable); err != nil {
		return SQLiteFile{}, classifySQLiteFileError(err)
	}
	if hasTable == 0 {
		return SQLiteFile{}, ErrNoSchema
	}
	var f SQLiteFile
	var version int64
	err = h.QueryRowContext(ctx, `SELECT version, dirty FROM schema_migrations LIMIT 1`).Scan(&version, &f.Dirty)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return SQLiteFile{}, ErrNoSchema
	case err != nil:
		return SQLiteFile{}, classifySQLiteFileError(err)
	case version <= 0:
		return SQLiteFile{}, ErrNoSchema
	}
	f.Version = uint(version)
	for _, c := range []struct {
		table string
		into  *int64
	}{{"sessions", &f.Sessions}, {"events", &f.Events}} {
		if err := h.QueryRowContext(ctx, `SELECT count(*) FROM `+c.table).Scan(c.into); err != nil {
			return SQLiteFile{}, classifySQLiteFileError(err)
		}
	}
	return f, nil
}

func integrityCheck(ctx context.Context, h *sql.DB) error {
	rows, err := h.QueryContext(ctx, `PRAGMA integrity_check`)
	if err != nil {
		return classifySQLiteFileError(err)
	}
	defer func() { _ = rows.Close() }()
	var problems []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return classifySQLiteFileError(err)
		}
		if line != "ok" && len(problems) < maxIntegrityProblems {
			problems = append(problems, line)
		}
	}
	if err := rows.Err(); err != nil {
		return classifySQLiteFileError(err)
	}
	if len(problems) > 0 {
		return &DamagedError{Problems: problems}
	}
	return nil
}

// SQLite primary result codes that say something about a file rather
// than about the call.
const (
	sqliteCorrupt = 11 // SQLITE_CORRUPT: damaged, or truncated
	sqliteFull    = 13 // SQLITE_FULL: the disk (or the quota) is full
	sqliteNotADB  = 26 // SQLITE_NOTADB: not a SQLite database
)

// ErrDiskFull is returned when a copy stopped because the disk it
// writes to is full.
var ErrDiskFull = errors.New("the disk is full")

// classifySQLiteFileError turns SQLite's errors about a file into the
// kinds above, by their primary result code: SQLITE_NOTADB is
// ErrNotSQLite, SQLITE_CORRUPT (a damaged or truncated database) a
// DamagedError and SQLITE_FULL ErrDiskFull. Any other error is returned
// as it is.
func classifySQLiteFileError(err error) error {
	var sqErr *sqlite.Error
	if !errors.As(err, &sqErr) {
		return err
	}
	switch sqErr.Code() & sqlitePrimaryCodeMask {
	case sqliteNotADB:
		return ErrNotSQLite
	case sqliteCorrupt:
		return &DamagedError{Problems: []string{err.Error()}}
	case sqliteFull:
		return fmt.Errorf("%w: %v", ErrDiskFull, err)
	}
	return err
}

// LatestVersion returns the newest migration version embedded for b: the
// schema version this binary migrates a database to.
func LatestVersion(b Backend) (uint, error) {
	fsys, err := MigrationsFS(b)
	if err != nil {
		return 0, err
	}
	names, err := fs.Glob(fsys, "*.up.sql")
	if err != nil {
		return 0, fmt.Errorf("storage: migrations of %s: %w", b, err)
	}
	var latest uint
	for _, name := range names {
		digits, _, _ := strings.Cut(name, "_")
		v, err := strconv.ParseUint(digits, 10, 32)
		if err != nil {
			return 0, fmt.Errorf("storage: migration file %s has no version", name)
		}
		latest = max(latest, uint(v))
	}
	if latest == 0 {
		return 0, fmt.Errorf("storage: no migrations embedded for %s", b)
	}
	return latest, nil
}
