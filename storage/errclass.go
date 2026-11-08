package storage

import (
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

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
