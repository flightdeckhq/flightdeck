package storage

import (
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"

	"modernc.org/sqlite"
)

// SQL functions the SQLite connections carry so the stores' SQL spells
// them the same way on both engines:
//
//   - regexp_like(text, pattern) and regexp_replace(text, pattern,
//     replacement), as Postgres 15+ defines them (the stack runs
//     Postgres 16): a match of the first occurrence, with \1..\9 and \&
//     in the replacement. Patterns come from code, never from request
//     input, and are RE2 expressions that mean the same under
//     Postgres' regex engine.
//   - percentile_cont(value, fraction), the continuous percentile the
//     Postgres ordered-set aggregate PERCENTILE_CONT(fraction) WITHIN
//     GROUP (ORDER BY value) computes, with the same interpolation and
//     the same NULL handling (NULL values are skipped; no value gives
//     NULL), so Dialect.Percentile renders one aggregate on each
//     engine and a p50 or p95 agrees to the bit.
//   - gen_random_uuid(), a random version-4 UUID in canonical form.
//
// They are registered on modernc's default driver, the one the wrapped
// flightdeck-sqlite driver opens connections through, before any
// connection is opened.

// defaultSQLiteDriver returns modernc's default driver, the instance
// RegisterFunction attaches functions to. sql.Open opens no connection,
// so this only reads the registry.
func defaultSQLiteDriver() *sqlite.Driver {
	db, err := sql.Open("sqlite", "")
	if err != nil {
		panic(fmt.Sprintf("storage: modernc sqlite driver not registered: %v", err))
	}
	defer func() { _ = db.Close() }()
	d, ok := db.Driver().(*sqlite.Driver)
	if !ok {
		panic(fmt.Sprintf("storage: driver %q is %T, want *sqlite.Driver", "sqlite", db.Driver()))
	}
	return d
}

func registerSQLiteFunctions() {
	sqlite.MustRegisterFunction("regexp_like", &sqlite.FunctionImpl{
		NArgs:         2,
		Deterministic: true,
		Scalar:        sqliteRegexpLike,
	})
	sqlite.MustRegisterFunction("regexp_replace", &sqlite.FunctionImpl{
		NArgs:         3,
		Deterministic: true,
		Scalar:        sqliteRegexpReplace,
	})
	sqlite.MustRegisterFunction("percentile_cont", &sqlite.FunctionImpl{
		NArgs: 2,
		MakeAggregate: func(sqlite.FunctionContext) (sqlite.AggregateFunction, error) {
			return &percentileAgg{}, nil
		},
	})
	sqlite.MustRegisterFunction("gen_random_uuid", &sqlite.FunctionImpl{
		NArgs:  0,
		Scalar: sqliteGenRandomUUID,
	})
}

// sqliteGenRandomUUID is Postgres' gen_random_uuid(): a random
// version-4 UUID in the canonical lower-case hyphenated form the
// schema's CHECKs demand, so SQL that generates an id (test seeds, a
// store that needs the id before the INSERT) spells the same on both
// engines.
func sqliteGenRandomUUID(*sqlite.FunctionContext, []driver.Value) (driver.Value, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, fmt.Errorf("storage: gen_random_uuid: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// regexCache holds the compiled patterns; a store's patterns are a
// handful of constants, so the cache never grows past them.
var regexCache sync.Map // string -> *regexp.Regexp

func compileCached(pattern string) (*regexp.Regexp, error) {
	if re, ok := regexCache.Load(pattern); ok {
		return re.(*regexp.Regexp), nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("storage: regexp %q: %w", pattern, err)
	}
	regexCache.Store(pattern, re)
	return re, nil
}

// sqlText reads a TEXT or BLOB argument as a string; ok is false for
// NULL (a NULL argument makes the function return NULL, as on Postgres).
func sqlText(v driver.Value) (s string, ok bool, err error) {
	switch x := v.(type) {
	case nil:
		return "", false, nil
	case string:
		return x, true, nil
	case []byte:
		return string(x), true, nil
	case int64:
		return fmt.Sprint(x), true, nil
	case float64:
		return fmt.Sprint(x), true, nil
	}
	return "", false, fmt.Errorf("storage: regexp argument of type %T", v)
}

func sqliteRegexpLike(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	s, ok, err := sqlText(args[0])
	if err != nil || !ok {
		return nil, err
	}
	pattern, ok, err := sqlText(args[1])
	if err != nil || !ok {
		return nil, err
	}
	re, err := compileCached(pattern)
	if err != nil {
		return nil, err
	}
	if re.MatchString(s) {
		return int64(1), nil
	}
	return int64(0), nil
}

func sqliteRegexpReplace(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	s, ok, err := sqlText(args[0])
	if err != nil || !ok {
		return nil, err
	}
	pattern, ok, err := sqlText(args[1])
	if err != nil || !ok {
		return nil, err
	}
	replacement, ok, err := sqlText(args[2])
	if err != nil || !ok {
		return nil, err
	}
	re, err := compileCached(pattern)
	if err != nil {
		return nil, err
	}
	return regexpReplaceFirst(re, s, replacement), nil
}

// regexpReplaceFirst replaces the first match of re in s with the
// Postgres-style replacement (\1..\9 are groups, \& the whole match, \\
// a backslash), the semantics of regexp_replace without the 'g' flag.
func regexpReplaceFirst(re *regexp.Regexp, s, replacement string) string {
	loc := re.FindStringSubmatchIndex(s)
	if loc == nil {
		return s
	}
	var out []byte
	out = append(out, s[:loc[0]]...)
	out = re.ExpandString(out, postgresReplacementToGo(replacement), s, loc)
	out = append(out, s[loc[1]:]...)
	return string(out)
}

// postgresReplacementToGo rewrites a Postgres replacement string into
// Go's template form: \N becomes ${N}, \& becomes ${0}, \\ becomes \,
// and a literal $ is escaped as $$ so Go does not read it as a group.
func postgresReplacementToGo(r string) string {
	var b strings.Builder
	for i := 0; i < len(r); i++ {
		c := r[i]
		switch {
		case c == '$':
			b.WriteString("$$")
		case c == '\\' && i+1 < len(r):
			i++
			switch n := r[i]; {
			case n >= '0' && n <= '9':
				fmt.Fprintf(&b, "${%c}", n)
			case n == '&':
				b.WriteString("${0}")
			default:
				b.WriteByte(n)
			}
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// percentileAgg computes percentile_cont(value, fraction) as Postgres
// does: over the non-NULL values sorted ascending, the row at
// fraction * (n - 1), interpolated linearly between its two neighbours
// when that position is not whole; NULL when no value was given.
type percentileAgg struct {
	values   []float64
	fraction float64
	hasFrac  bool
}

func toFloat(v driver.Value) (float64, bool, error) {
	switch x := v.(type) {
	case nil:
		return 0, false, nil
	case int64:
		return float64(x), true, nil
	case float64:
		return x, true, nil
	case string:
		var f float64
		if _, err := fmt.Sscan(x, &f); err != nil {
			return 0, false, fmt.Errorf("storage: percentile_cont: %q is not a number", x)
		}
		return f, true, nil
	}
	return 0, false, fmt.Errorf("storage: percentile_cont argument of type %T", v)
}

func (a *percentileAgg) Step(_ *sqlite.FunctionContext, args []driver.Value) error {
	if !a.hasFrac {
		f, ok, err := toFloat(args[1])
		if err != nil {
			return err
		}
		if ok {
			if f < 0 || f > 1 || math.IsNaN(f) {
				return fmt.Errorf("storage: percentile_cont fraction %v is outside [0, 1]", f)
			}
			a.fraction, a.hasFrac = f, true
		}
	}
	v, ok, err := toFloat(args[0])
	if err != nil {
		return err
	}
	if ok {
		a.values = append(a.values, v)
	}
	return nil
}

func (a *percentileAgg) WindowInverse(_ *sqlite.FunctionContext, args []driver.Value) error {
	v, ok, err := toFloat(args[0])
	if err != nil || !ok {
		return err
	}
	for i, x := range a.values {
		if x == v {
			a.values = append(a.values[:i], a.values[i+1:]...)
			break
		}
	}
	return nil
}

func (a *percentileAgg) WindowValue(_ *sqlite.FunctionContext) (driver.Value, error) {
	if len(a.values) == 0 || !a.hasFrac {
		return nil, nil
	}
	sorted := append([]float64(nil), a.values...)
	sort.Float64s(sorted)
	return percentileCont(sorted, a.fraction), nil
}

func (a *percentileAgg) Final(*sqlite.FunctionContext) {}

// percentileCont is Postgres' percentile_cont over sorted values: the
// row at fraction * (n - 1), lerped between its floor and ceiling rows
// as lo + (hi - lo) * proportion.
func percentileCont(sorted []float64, fraction float64) float64 {
	n := len(sorted)
	pos := fraction * float64(n-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	if lo == hi {
		return sorted[lo]
	}
	proportion := pos - float64(lo)
	return sorted[lo] + (sorted[hi]-sorted[lo])*proportion
}
