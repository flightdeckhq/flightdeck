package storage

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"modernc.org/sqlite"
)

// SQLite primary result codes (the low byte of an extended code) that
// mean the statement's data was refused rather than the statement
// failing for a transient reason.
const (
	sqliteTooBig     = 18 // SQLITE_TOOBIG: a string or blob exceeds the size limit
	sqliteConstraint = 19 // SQLITE_CONSTRAINT: NOT NULL, CHECK, UNIQUE, FOREIGN KEY
	sqliteMismatch   = 20 // SQLITE_MISMATCH: a value of the wrong type for the column
)

// IsDataError reports whether err is the database refusing the data a
// statement carried, so the same statement would fail the same way on
// every retry: invalid data (a NUL byte in Postgres text, a value of
// the wrong type), a broken constraint (NOT NULL, CHECK, UNIQUE,
// FOREIGN KEY) or a size limit. A dropped connection, a timeout, a
// deadlock or a serialization failure is not a data error and is worth
// retrying. On Postgres these are SQLSTATE classes 22 (data exception),
// 23 (integrity constraint violation) and 54 (program limit exceeded);
// on SQLite the TOOBIG, CONSTRAINT and MISMATCH result codes.
func IsDataError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if len(pgErr.Code) < 2 {
			return false
		}
		switch pgErr.Code[:2] {
		case "22", "23", "54":
			return true
		}
		return false
	}
	var sqErr *sqlite.Error
	if errors.As(err, &sqErr) {
		switch sqErr.Code() & 0xff {
		case sqliteTooBig, sqliteConstraint, sqliteMismatch:
			return true
		}
	}
	return false
}
