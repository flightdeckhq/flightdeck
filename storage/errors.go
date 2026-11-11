package storage

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// sqlitePrimaryCodeMask keeps the primary result code of a SQLite
// error: an extended code (SQLITE_CONSTRAINT_UNIQUE, SQLITE_BUSY_SNAPSHOT)
// carries its primary code in the low byte.
const sqlitePrimaryCodeMask = 0xff

// SQLite primary result codes that mean the statement's data was
// refused rather than the statement failing for a transient reason.
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
		switch sqErr.Code() & sqlitePrimaryCodeMask {
		case sqliteTooBig, sqliteConstraint, sqliteMismatch:
			return true
		}
	}
	return false
}

// IsUniqueViolation reports whether err is the database refusing a row
// because a unique constraint or primary key already holds its key:
// SQLSTATE 23505 on Postgres, SQLITE_CONSTRAINT_UNIQUE or
// SQLITE_CONSTRAINT_PRIMARYKEY on SQLite. A store that races another
// writer for a singleton row (the global MCP policy) or a unique scope
// treats it as "already there" instead of failing. No driver error type
// leaves this package: stores call this instead of inspecting the error.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	var sqErr *sqlite.Error
	if errors.As(err, &sqErr) {
		switch sqErr.Code() {
		case sqlite3.SQLITE_CONSTRAINT_UNIQUE, sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY:
			return true
		}
	}
	return false
}
