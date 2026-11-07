package storage

import (
	"encoding/json"
	"fmt"
	"strings"
)

// TruncUnit is a unit DateTrunc truncates to.
type TruncUnit string

const (
	TruncHour  TruncUnit = "hour"
	TruncDay   TruncUnit = "day"
	TruncWeek  TruncUnit = "week" // weeks start on Monday, as in Postgres
	TruncMonth TruncUnit = "month"
)

// Dialect renders the SQL constructs that differ between Postgres and
// SQLite. Everything else a store writes is the common subset: $n
// placeholders, CAST(x AS TEXT), ON CONFLICT ... DO UPDATE SET ... =
// EXCLUDED.x, RETURNING, COALESCE, CASE, window functions, recursive
// CTEs. Each method takes and returns SQL text; arguments named expr,
// ts or pattern are SQL expressions (a column, a literal or a $n
// placeholder), never user input.
//
// Where a store's SQL differs beyond these helpers it keeps two query
// sets (queries_postgres.go, queries_sqlite.go) and picks one by
// Backend; the helpers are not a templating language.
type Dialect interface {
	// Backend names the dialect.
	Backend() Backend

	// Placeholder is the n-th (1-based) positional parameter. Both
	// backends bind "$n" by ordinal (modernc matches $NNN to the NNN-th
	// argument), so the common SQL writes $1, $2, ... directly; the
	// method exists so the rule is stated once and testable.
	Placeholder(n int) string

	// Now is the current time as a timestamp expression.
	Now() string

	// AddInterval is ts shifted by seconds (a number or $n; negative
	// moves back), as a timestamp expression.
	AddInterval(ts, seconds string) string

	// DateTrunc truncates ts to unit. On SQLite the result is text in
	// TimeLayout; on Postgres a timestamptz. Both group and compare
	// identically and scan through Time.
	DateTrunc(unit TruncUnit, ts string) string

	// ILike matches expr against a LIKE pattern without regard to ASCII
	// case: lower(expr) LIKE lower(pattern) ESCAPE '\' on both backends,
	// so the escaping rules agree. Neither backend folds non-ASCII
	// letters here: SQLite's lower() is ASCII-only, and Postgres is made
	// to match it rather than depend on the database locale.
	ILike(expr, pattern string) string

	// InArray tests expr for membership in the array bound at param (a
	// $n placeholder whose value came from ArrayArg): "expr = ANY($n)"
	// on Postgres, "expr IN (SELECT value FROM json_each($n))" on SQLite.
	InArray(expr, param string) string

	// ArrayArg is the argument value InArray's parameter takes for
	// values: the []string itself on Postgres (bound as text[]), its
	// JSON encoding on SQLite.
	ArrayArg(values []string) any

	// JSONText reads the value at path (object keys, outermost first)
	// of the JSON column col: col->'a'->>'b' on Postgres,
	// json_extract(col, '$.a.b') on SQLite. Postgres yields text for
	// every scalar; SQLite yields the JSON value's own type, so the
	// helper is for string-valued keys. Postgres returns the text of a
	// nested object or array too; SQLite returns its minified JSON.
	JSONText(col string, path ...string) string

	// Upsert is the ON CONFLICT clause of an INSERT: on a conflict over
	// conflictCols, set each of updateCols to the EXCLUDED value, or DO
	// NOTHING when updateCols is empty. Identical on both backends.
	Upsert(conflictCols, updateCols []string) string

	// Returning is a RETURNING clause over cols. Identical on both
	// backends.
	Returning(cols ...string) string
}

// DialectFor returns the dialect of a backend.
func DialectFor(b Backend) Dialect {
	if b == SQLite {
		return sqliteDialect{}
	}
	return postgresDialect{}
}

// commonDialect holds the methods whose SQL is the same on both backends.
type commonDialect struct{}

func (commonDialect) Placeholder(n int) string { return fmt.Sprintf("$%d", n) }

func (commonDialect) ILike(expr, pattern string) string {
	return fmt.Sprintf(`lower(%s) LIKE lower(%s) ESCAPE '\'`, expr, pattern)
}

func (commonDialect) Upsert(conflictCols, updateCols []string) string {
	var b strings.Builder
	b.WriteString("ON CONFLICT (")
	b.WriteString(strings.Join(conflictCols, ", "))
	b.WriteString(")")
	if len(updateCols) == 0 {
		b.WriteString(" DO NOTHING")
		return b.String()
	}
	b.WriteString(" DO UPDATE SET ")
	for i, c := range updateCols {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(c)
		b.WriteString(" = EXCLUDED.")
		b.WriteString(c)
	}
	return b.String()
}

func (commonDialect) Returning(cols ...string) string {
	return "RETURNING " + strings.Join(cols, ", ")
}

// --- Postgres ---------------------------------------------------------

type postgresDialect struct{ commonDialect }

func (postgresDialect) Backend() Backend { return Postgres }

func (postgresDialect) Now() string { return "NOW()" }

func (postgresDialect) AddInterval(ts, seconds string) string {
	return fmt.Sprintf("(%s + (%s) * INTERVAL '1 second')", ts, seconds)
}

func (postgresDialect) DateTrunc(unit TruncUnit, ts string) string {
	return fmt.Sprintf("date_trunc('%s', %s)", unit, ts)
}

func (postgresDialect) InArray(expr, param string) string {
	return fmt.Sprintf("%s = ANY(%s)", expr, param)
}

func (postgresDialect) ArrayArg(values []string) any {
	if values == nil {
		return []string{}
	}
	return values
}

func (postgresDialect) JSONText(col string, path ...string) string {
	if len(path) == 0 {
		return fmt.Sprintf("(%s)::text", col)
	}
	var b strings.Builder
	b.WriteString(col)
	for i, key := range path {
		if i == len(path)-1 {
			b.WriteString("->>")
		} else {
			b.WriteString("->")
		}
		b.WriteString(sqlQuote(key))
	}
	return b.String()
}

// --- SQLite -----------------------------------------------------------

type sqliteDialect struct{ commonDialect }

// sqliteTimeFormat is TimeLayout as a strftime format.
const sqliteTimeFormat = "%Y-%m-%dT%H:%M:%fZ"

func (sqliteDialect) Backend() Backend { return SQLite }

func (sqliteDialect) Now() string {
	return fmt.Sprintf("strftime('%s', 'now')", sqliteTimeFormat)
}

func (sqliteDialect) AddInterval(ts, seconds string) string {
	return fmt.Sprintf("strftime('%s', %s, (%s) || ' seconds')", sqliteTimeFormat, ts, seconds)
}

func (sqliteDialect) DateTrunc(unit TruncUnit, ts string) string {
	switch unit {
	case TruncHour:
		return fmt.Sprintf("strftime('%%Y-%%m-%%dT%%H:00:00.000Z', %s)", ts)
	case TruncDay:
		return fmt.Sprintf("strftime('%%Y-%%m-%%dT00:00:00.000Z', %s)", ts)
	case TruncWeek:
		// Back six days, then forward to the next Monday (weekday 1):
		// the Monday on or before ts.
		return fmt.Sprintf("strftime('%%Y-%%m-%%dT00:00:00.000Z', %s, '-6 days', 'weekday 1')", ts)
	case TruncMonth:
		return fmt.Sprintf("strftime('%%Y-%%m-01T00:00:00.000Z', %s)", ts)
	}
	panic(fmt.Sprintf("storage: unknown truncation unit %q", unit))
}

func (sqliteDialect) InArray(expr, param string) string {
	return fmt.Sprintf("%s IN (SELECT value FROM json_each(%s))", expr, param)
}

func (sqliteDialect) ArrayArg(values []string) any {
	if values == nil {
		values = []string{}
	}
	// json.Marshal of a []string cannot fail.
	data, _ := json.Marshal(values)
	return string(data)
}

func (sqliteDialect) JSONText(col string, path ...string) string {
	if len(path) == 0 {
		return fmt.Sprintf("json(%s)", col)
	}
	var p strings.Builder
	p.WriteString("$")
	for _, key := range path {
		p.WriteString(".")
		p.WriteString(key)
	}
	return fmt.Sprintf("json_extract(%s, %s)", col, sqlQuote(p.String()))
}

// sqlQuote renders s as a single-quoted SQL string literal. The helpers
// take key names from code, never from user input; the quoting keeps a
// key with an apostrophe from breaking the statement all the same.
func sqlQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
