package storage

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"modernc.org/sqlite"
)

// SQLSTATE codes of a Postgres connection attempt that fails the same
// way however often it is repeated.
const (
	// pgClassInvalidAuthorization is the class of 28000 (no pg_hba.conf
	// entry, the role may not log in) and 28P01 (wrong password).
	pgClassInvalidAuthorization = "28"
	// pgInvalidCatalogName is 3D000: the database does not exist.
	pgInvalidCatalogName = "3D000"
)

// SQLite primary result codes of an open that another attempt may get
// past: the file is locked by another connection for the moment.
const (
	sqliteBusy   = 5 // SQLITE_BUSY
	sqliteLocked = 6 // SQLITE_LOCKED
)

// PermanentOpenError reports whether err, returned by Open, is one that
// opening again cannot fix, so a caller that retries a database that is
// still starting (OpenRetry) gives up at once instead of waiting out
// its budget:
//
//   - a URL Open can never accept: an unsupported scheme, a sqlite URL
//     that names no file, a Postgres URL that does not parse;
//   - Postgres refusing the credentials (SQLSTATE class 28: wrong
//     password, no such role, no pg_hba.conf entry) or the database
//     name (3D000, the database does not exist);
//   - any SQLite failure other than the file being locked for the
//     moment: a missing directory, a file that is not a database or
//     may not be opened. A file is not a server that comes up later.
//
// A refused or timed-out connection, a name that does not resolve yet,
// a server that answers "starting up" or "too many connections", and a
// cancelled or expired context are not permanent.
func PermanentOpenError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, ErrUnsupportedURL) || errors.Is(err, ErrSQLiteNeedsFile) || errors.Is(err, ErrInvalidURL) {
		return true
	}
	var parseErr *pgconn.ParseConfigError
	if errors.As(err, &parseErr) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return strings.HasPrefix(pgErr.Code, pgClassInvalidAuthorization) || pgErr.Code == pgInvalidCatalogName
	}
	var sqErr *sqlite.Error
	if errors.As(err, &sqErr) {
		switch sqErr.Code() & 0xff {
		case sqliteBusy, sqliteLocked:
			return false
		}
		return true
	}
	return false
}

// ErrorClass describes a database error for a log line without any of
// the data it was about. A Postgres error is named by its SQLSTATE code
// and the table and constraint it names, never by its message, detail
// or context, which quote the rejected value (a `\u0000` escape in
// jsonb, a value that failed a cast), after the text of the layers that
// wrapped it. Every other error is returned as its own text: SQLite's
// constraint and type errors name the constraint or column and never
// the value, and a timeout or a lost connection carries no data.
func ErrorClass(err error) string {
	if err == nil {
		return ""
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err.Error()
	}
	prefix := strings.TrimSuffix(err.Error(), pgErr.Error())
	class := prefix + "postgres error SQLSTATE " + pgErr.Code
	if pgErr.TableName != "" {
		class += " table " + pgErr.TableName
	}
	if pgErr.ConstraintName != "" {
		class += " constraint " + pgErr.ConstraintName
	}
	return class
}
