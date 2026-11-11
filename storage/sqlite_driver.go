package storage

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"time"

	"modernc.org/sqlite"
)

// sqliteDriverName is the database/sql name of the wrapped SQLite driver.
const sqliteDriverName = "flightdeck-sqlite"

// TimeLayout is how SQLite stores every timestamp: RFC 3339 in UTC with
// exactly three fractional digits (SQLite's own strftime('%f')
// precision), so the text sorts chronologically byte-for-byte and the
// date functions of SQL and the values written from Go are
// interchangeable. Postgres keeps microseconds; a value that round-trips
// through SQLite is truncated to the millisecond.
const TimeLayout = "2006-01-02T15:04:05.000Z"

// FormatTime renders t the way SQLite stores timestamps.
func FormatTime(t time.Time) string {
	return t.UTC().Format(TimeLayout)
}

func init() {
	// The functions in sqlite_functions.go attach to modernc's default
	// driver instance, so the wrapper opens its connections through
	// that instance rather than a fresh one.
	inner := defaultSQLiteDriver()
	registerSQLiteFunctions()
	sql.Register(sqliteDriverName, &sqliteDriver{inner: inner})
}

// sqliteDriver wraps modernc's driver so every time.Time argument is
// written in TimeLayout. modernc itself writes time.Time with Go's
// String() format, which neither sorts with nor parses as the format
// the schema's defaults and date functions produce. Reading needs no
// wrapper: modernc parses TEXT in TIMESTAMP-declared columns into
// time.Time, and TimeLayout is one of the shapes it accepts. The
// connections also carry the SQL functions of sqlite_functions.go.
type sqliteDriver struct {
	inner *sqlite.Driver
}

func (d *sqliteDriver) Open(name string) (driver.Conn, error) {
	c, err := d.inner.Open(name)
	if err != nil {
		return nil, err
	}
	return &sqliteConn{Conn: c}, nil
}

// sqliteConn forwards to the modernc connection and adds the argument
// conversion. database/sql routes every argument through CheckNamedValue
// before any Exec, Query or prepared-statement call, so the inner
// connection only ever sees text timestamps.
type sqliteConn struct {
	driver.Conn
}

func (c *sqliteConn) CheckNamedValue(nv *driver.NamedValue) error {
	v, err := driver.DefaultParameterConverter.ConvertValue(nv.Value)
	if err != nil {
		return err
	}
	if t, ok := v.(time.Time); ok {
		v = FormatTime(t)
	}
	nv.Value = v
	return nil
}

func (c *sqliteConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts)
}

func (c *sqliteConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	return c.Conn.(driver.ConnPrepareContext).PrepareContext(ctx, query)
}

func (c *sqliteConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
}

func (c *sqliteConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
}

func (c *sqliteConn) Ping(ctx context.Context) error {
	return c.Conn.(driver.Pinger).Ping(ctx)
}

func (c *sqliteConn) ResetSession(ctx context.Context) error {
	return c.Conn.(driver.SessionResetter).ResetSession(ctx)
}

func (c *sqliteConn) IsValid() bool {
	return c.Conn.(driver.Validator).IsValid()
}
