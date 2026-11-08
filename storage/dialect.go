package storage

import (
	"encoding/json"
	"fmt"
	"strings"
)

// TruncUnit is a unit DateTrunc truncates to.
type TruncUnit string

const (
	// TruncHour zeroes minutes, seconds and fractions.
	TruncHour TruncUnit = "hour"
	// TruncDay is midnight UTC of the timestamp's day.
	TruncDay TruncUnit = "day"
	// TruncWeek is midnight UTC of the Monday on or before the
	// timestamp (weeks start on Monday, as in Postgres).
	TruncWeek TruncUnit = "week"
	// TruncMonth is midnight UTC of the first of the month.
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

	// DateTrunc truncates ts to unit in UTC, whatever the session time
	// zone. On SQLite the result is text in TimeLayout; on Postgres a
	// timestamptz. Both group and compare identically and scan through
	// Time. ts is a timestamp expression: a column or a function; a
	// bare placeholder has no type on Postgres and needs
	// CAST($n AS TIMESTAMPTZ).
	DateTrunc(unit TruncUnit, ts string) string

	// ILike matches expr against a LIKE pattern without regard to ASCII
	// case: lower(expr) LIKE lower(pattern) ESCAPE '\' on both backends,
	// so the escaping rules agree. Neither backend folds non-ASCII
	// letters: SQLite's lower() is ASCII-only, and on Postgres both
	// sides are folded under the "C" collation so the database locale
	// cannot make 'ÉCOLE' match 'école' there and not on SQLite.
	ILike(expr, pattern string) string

	// InArray tests expr for membership in the array bound at param (a
	// $n placeholder whose value came from ArrayArg): "expr = ANY($n)"
	// on Postgres, "expr IN (SELECT value FROM json_each($n))" on SQLite.
	InArray(expr, param string) string

	// InUUIDArray is InArray for a uuid column: on Postgres the bound
	// text array is cast to uuid[] so the comparison uses the column's
	// type and index instead of casting every row to text; on SQLite,
	// where UUIDs are text, it is InArray. The values come from
	// ArrayArg as for InArray.
	InUUIDArray(expr, param string) string

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

	// Percentile is the continuous percentile aggregate of expr at
	// fraction (a SQL numeric literal such as "0.95"): PERCENTILE_CONT
	// WITHIN GROUP on Postgres, the percentile_cont function the
	// storage driver registers on SQLite, with the same interpolation
	// and NULL handling. A FILTER clause has no SQLite spelling: pass a
	// CASE that yields NULL for the rows to leave out.
	Percentile(fraction, expr string) string

	// SecondsBetween is the signed number of seconds from b to a (a - b)
	// as a floating-point expression, exact to the millisecond, the
	// precision SQLite timestamps carry.
	SecondsBetween(a, b string) string

	// DateOf is the calendar date (UTC) of the timestamp expression ts;
	// on Postgres a date, on SQLite 'YYYY-MM-DD' text. Both scan
	// through Time.
	DateOf(ts string) string

	// JSONTypeOf is the JSON type name of the value at path of col (or
	// of col itself with no path), in Postgres' vocabulary on both
	// engines: object, array, string, number, boolean, null; NULL when
	// the path is absent.
	JSONTypeOf(col string, path ...string) string

	// JSONIsTrue is a boolean expression: the value at path is the JSON
	// boolean true or the string "true". NULL when the path is absent.
	JSONIsTrue(col string, path ...string) string

	// JSONBoolText is the value at path as text, with a JSON boolean
	// rendered as 'true' / 'false' on both engines (JSONText on SQLite
	// yields 1 / 0 for booleans). For keys that hold a boolean or a
	// string; the expression is not indexable on SQLite.
	JSONBoolText(col string, path ...string) string

	// JSONNumber is the value at path as a number (NULL when absent),
	// for keys that hold a JSON number.
	JSONNumber(col string, path ...string) string

	// JSONArray is the JSON array at path of col, or an empty array when
	// the path is absent or holds a non-array, so JSONArrayElements over
	// it never fails on a malformed document.
	JSONArray(col string, path ...string) string

	// JSONArrayElements is a FROM item that yields one row per element
	// of the JSON array expression arrayExpr, as alias with the element
	// in alias.value (a JSON value on both engines: read a string
	// element with JSONElementText, an object's key with
	// JSONText(alias + ".value", key)). It may reference a table that
	// precedes it in the FROM clause on both engines, in a cross join or
	// on the right of a LEFT JOIN ... ON TRUE.
	JSONArrayElements(arrayExpr, alias string) string

	// JSONElementText is a string element of JSONArrayElements' alias
	// as text.
	JSONElementText(alias string) string

	// Least and Greatest are the smaller and the larger of two
	// non-NULL expressions (LEAST / GREATEST on Postgres, the scalar
	// MIN / MAX on SQLite).
	Least(a, b string) string
	Greatest(a, b string) string
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

// ILike folds both sides under the "C" collation: Postgres' lower()
// follows the collation, and under "C" it folds ASCII letters only, as
// SQLite's lower() does. The casts give a bare placeholder a type.
func (postgresDialect) ILike(expr, pattern string) string {
	return fmt.Sprintf(`lower(CAST(%s AS TEXT) COLLATE "C") LIKE lower(CAST(%s AS TEXT) COLLATE "C") ESCAPE '\'`, expr, pattern)
}

func (postgresDialect) AddInterval(ts, seconds string) string {
	return fmt.Sprintf("(%s + (%s) * INTERVAL '1 second')", ts, seconds)
}

// DateTrunc names the zone, so a session whose time zone is not UTC
// still truncates to UTC boundaries, as SQLite's strftime does.
func (postgresDialect) DateTrunc(unit TruncUnit, ts string) string {
	return fmt.Sprintf("date_trunc('%s', %s, 'UTC')", unit, ts)
}

func (postgresDialect) InArray(expr, param string) string {
	return fmt.Sprintf("%s = ANY(%s)", expr, param)
}

func (postgresDialect) InUUIDArray(expr, param string) string {
	return fmt.Sprintf("%s = ANY(CAST(%s AS uuid[]))", expr, param)
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

// jsonbPath renders col->'a'->'b' (a jsonb value, not text).
func jsonbPath(col string, path []string) string {
	var b strings.Builder
	b.WriteString(col)
	for _, key := range path {
		b.WriteString("->")
		b.WriteString(sqlQuote(key))
	}
	return b.String()
}

func (postgresDialect) Percentile(fraction, expr string) string {
	return fmt.Sprintf("PERCENTILE_CONT(%s) WITHIN GROUP (ORDER BY %s)", fraction, expr)
}

func (postgresDialect) SecondsBetween(a, b string) string {
	return fmt.Sprintf("EXTRACT(EPOCH FROM (%s - %s))", a, b)
}

func (postgresDialect) DateOf(ts string) string {
	return fmt.Sprintf("CAST(%s AS DATE)", ts)
}

func (postgresDialect) JSONTypeOf(col string, path ...string) string {
	return fmt.Sprintf("jsonb_typeof(%s)", jsonbPath(col, path))
}

func (d postgresDialect) JSONIsTrue(col string, path ...string) string {
	return fmt.Sprintf("(%s = 'true')", d.JSONText(col, path...))
}

func (d postgresDialect) JSONBoolText(col string, path ...string) string {
	return d.JSONText(col, path...)
}

func (d postgresDialect) JSONNumber(col string, path ...string) string {
	return fmt.Sprintf("CAST(%s AS NUMERIC)", d.JSONText(col, path...))
}

func (postgresDialect) JSONArray(col string, path ...string) string {
	p := jsonbPath(col, path)
	return fmt.Sprintf("(CASE WHEN jsonb_typeof(%s) = 'array' THEN %s ELSE '[]'::jsonb END)", p, p)
}

func (postgresDialect) JSONArrayElements(arrayExpr, alias string) string {
	return fmt.Sprintf("jsonb_array_elements(%s) AS %s(value)", arrayExpr, alias)
}

func (postgresDialect) JSONElementText(alias string) string {
	return fmt.Sprintf("(%s.value #>> '{}')", alias)
}

func (postgresDialect) Least(a, b string) string    { return fmt.Sprintf("LEAST(%s, %s)", a, b) }
func (postgresDialect) Greatest(a, b string) string { return fmt.Sprintf("GREATEST(%s, %s)", a, b) }

// --- SQLite -----------------------------------------------------------

type sqliteDialect struct{ commonDialect }

// sqliteTimeFormat is TimeLayout as a strftime format.
const sqliteTimeFormat = "%Y-%m-%dT%H:%M:%fZ"

func (sqliteDialect) Backend() Backend { return SQLite }

// ILike: SQLite's lower() folds ASCII only; LIKE itself is
// case-sensitive on every connection (case_sensitive_like is on).
func (sqliteDialect) ILike(expr, pattern string) string {
	return fmt.Sprintf(`lower(%s) LIKE lower(%s) ESCAPE '\'`, expr, pattern)
}

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

func (d sqliteDialect) InUUIDArray(expr, param string) string {
	return d.InArray(expr, param)
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
	return fmt.Sprintf("json_extract(%s, %s)", col, jsonPathLiteral(path))
}

// jsonPathLiteral renders path as the quoted '$.a.b' literal.
func jsonPathLiteral(path []string) string {
	var p strings.Builder
	p.WriteString("$")
	for _, key := range path {
		p.WriteString(".")
		p.WriteString(key)
	}
	return sqlQuote(p.String())
}

// sqliteJSONType is json_type(col, '$.path') (json_type(col) with no
// path), in SQLite's vocabulary.
func sqliteJSONType(col string, path []string) string {
	if len(path) == 0 {
		return fmt.Sprintf("json_type(%s)", col)
	}
	return fmt.Sprintf("json_type(%s, %s)", col, jsonPathLiteral(path))
}

func (sqliteDialect) Percentile(fraction, expr string) string {
	return fmt.Sprintf("percentile_cont(%s, %s)", expr, fraction)
}

// SecondsBetween: julianday is a double with about a tenth of a
// millisecond of precision at today's dates, and both operands carry
// milliseconds, so rounding to the millisecond recovers the exact
// difference.
func (sqliteDialect) SecondsBetween(a, b string) string {
	return fmt.Sprintf("ROUND((julianday(%s) - julianday(%s)) * 86400.0, 3)", a, b)
}

func (sqliteDialect) DateOf(ts string) string {
	return fmt.Sprintf("date(%s)", ts)
}

// JSONTypeOf maps SQLite's type names (true, false, integer, real, text)
// onto Postgres' (boolean, number, string).
func (sqliteDialect) JSONTypeOf(col string, path ...string) string {
	t := sqliteJSONType(col, path)
	return fmt.Sprintf("(CASE %s WHEN 'true' THEN 'boolean' WHEN 'false' THEN 'boolean'"+
		" WHEN 'integer' THEN 'number' WHEN 'real' THEN 'number' WHEN 'text' THEN 'string' ELSE %s END)", t, t)
}

func (d sqliteDialect) JSONIsTrue(col string, path ...string) string {
	return fmt.Sprintf("(%s = 'true' OR %s = 'true')", sqliteJSONType(col, path), d.JSONText(col, path...))
}

func (d sqliteDialect) JSONBoolText(col string, path ...string) string {
	return fmt.Sprintf("(CASE %s WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(%s AS TEXT) END)",
		sqliteJSONType(col, path), d.JSONText(col, path...))
}

func (d sqliteDialect) JSONNumber(col string, path ...string) string {
	return fmt.Sprintf("CAST(%s AS NUMERIC)", d.JSONText(col, path...))
}

func (d sqliteDialect) JSONArray(col string, path ...string) string {
	value := col
	if len(path) > 0 {
		value = d.JSONText(col, path...)
	}
	return fmt.Sprintf("(CASE WHEN %s = 'array' THEN %s ELSE '[]' END)", sqliteJSONType(col, path), value)
}

func (sqliteDialect) JSONArrayElements(arrayExpr, alias string) string {
	return fmt.Sprintf("json_each(%s) AS %s", arrayExpr, alias)
}

func (sqliteDialect) JSONElementText(alias string) string {
	return fmt.Sprintf("%s.value", alias)
}

func (sqliteDialect) Least(a, b string) string    { return fmt.Sprintf("MIN(%s, %s)", a, b) }
func (sqliteDialect) Greatest(a, b string) string { return fmt.Sprintf("MAX(%s, %s)", a, b) }

// sqlQuote renders s as a single-quoted SQL string literal. The helpers
// take key names from code, never from user input; the quoting keeps a
// key with an apostrophe from breaking the statement all the same.
func sqlQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
