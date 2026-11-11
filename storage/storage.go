// Package storage is the one database boundary of Flightdeck's Go
// services. It opens SQLite (the default) or Postgres behind a shared
// *sql.DB, names the dialect so a store can pick its per-backend query
// set, carries the schema migrations of both backends, and provides the
// Bus that replaces direct LISTEN/NOTIFY.
//
// Stores write plain database/sql against DB and use Dialect for the
// handful of constructs that differ between the two backends. No pgx
// type and no SQLite driver symbol leaves this package.
package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"runtime"
	"strings"
	"time"

	// Postgres through pgx's database/sql adapter: the "pgx" driver name.
	_ "github.com/jackc/pgx/v5/stdlib"
)

// Backend names a storage engine.
type Backend string

const (
	// Postgres is the multi-process backend (Helm, several instances).
	Postgres Backend = "postgres"
	// SQLite is the default, single-process backend.
	SQLite Backend = "sqlite"
)

// ErrUnsupportedURL is returned by Open for a URL whose scheme is
// neither sqlite nor postgres.
var ErrUnsupportedURL = errors.New("storage: database URL must start with sqlite:// or postgres://")

// ErrInvalidURL is returned by Open for a Postgres URL that does not
// parse. The message does not quote the URL, which holds the password;
// the usual cause is a reserved character in it.
var ErrInvalidURL = errors.New("storage: the Postgres URL does not parse (percent-encode reserved characters in the password, @ as %40)")

// ErrSQLiteNeedsFile is returned by Open for a sqlite:// URL that names
// no file (empty or :memory:): an in-memory database is private to one
// connection, so the read pool and the migrator would each see an
// empty one.
var ErrSQLiteNeedsFile = errors.New("storage: sqlite URL must name a file")

// PostgresMinOpenConns is the floor of the Postgres pool size; the pool
// holds max(PostgresMinOpenConns, NumCPU) connections, open and idle
// alike, the default pgxpool used before the storage boundary. The cap
// matters because token validation runs before the rate limiter and an
// unknown token is never cached: without it a burst of bad tokens
// opens a connection per request and can exhaust the server's
// max_connections. Four covers a small host; a CPU per connection is
// as many queries as the process runs at once.
const PostgresMinOpenConns = 4

// postgresConnMaxIdleTime is how long an idle Postgres connection is
// kept before it is closed (pgxpool's default). Long enough that the
// pool does not reconnect between requests of a quiet service, short
// enough that a burst's connections are returned to the server within
// the hour.
const postgresConnMaxIdleTime = 30 * time.Minute

// OpenRetry's backoff: the first wait after a failed attempt, doubling
// to the cap. Half a second notices a database that is a moment behind
// the service in a compose or Kubernetes start; five seconds keeps the
// log from filling while a slower restart completes.
const (
	openRetryInitialDelay = 500 * time.Millisecond
	openRetryMaxDelay     = 5 * time.Second
)

// sqliteBusyTimeoutMillis is how long an SQLite connection waits for a
// lock held by another connection before failing with SQLITE_BUSY.
// Writes serialise on the writer handle in Go (one connection), so the
// wait only covers an out-of-process writer such as a sqlite3 shell on
// the same file; five seconds outlives any such interactive statement
// without hiding a stuck process behind an endless wait.
const sqliteBusyTimeoutMillis = 5000

// sqliteReaderConns bounds a SQLite read pool. Readers never block
// each other or the writer in WAL mode, so the number only caps the
// memory of idle connections; eight covers the dashboard's concurrent
// fetches on a page load with the API's own background reads. Each
// handle has a read pool of its own (see Share), so the eight are per
// service.
const sqliteReaderConns = 8

// DB is an open database: the writer handle (the embedded *sql.DB),
// the dialect, and on SQLite a separate read pool.
//
// Read/write split on SQLite: the embedded *sql.DB is the writer and is
// limited to one connection, so every write transaction queues in Go
// (context-aware) instead of spinning on SQLite's busy handler; its
// transactions start with BEGIN IMMEDIATE so the write lock is taken at
// BEGIN and a read-then-write transaction can never fail with
// SQLITE_BUSY halfway through. Reader returns a pool of connections for
// statements that only read (its connections are query_only: a write
// through it fails); in WAL mode they neither block the writer nor are
// blocked by it. A read that must see a transaction's own uncommitted
// rows runs on the transaction, not on Reader. On Postgres both handles
// are the same pool.
//
// Because the writer is one connection, a statement issued on DB while
// the same goroutine holds an open Tx or unread Rows from DB waits for
// that connection and never gets it: a deadlock, not an error. Inside a
// transaction every statement runs on the Tx; a read that needs no
// transaction runs on Reader. sql.TxOptions.ReadOnly is enforced by
// Postgres and ignored by SQLite.
type DB struct {
	*sql.DB
	// Dialect is the SQL dialect of Backend.
	Dialect Dialect
	// Backend names the engine behind the handles.
	Backend Backend

	reader *sql.DB
	// url is the URL Open received; the Postgres Bus dials it for LISTEN.
	url string
	// checkpointer resets the write-ahead log of a SQLite database
	// (sqlite_checkpoint.go); nil on Postgres and on a shared handle.
	checkpointer *walCheckpointer
	// shared marks a SQLite handle made by Share: the writer belongs to
	// the handle it was made from, which closes it.
	shared bool
}

// Open connects to the database named by url: "sqlite://<path>" opens
// (creating if needed) the SQLite file at <path>; "postgres://..."
// opens a Postgres pool through pgx. Open pings the database. It does
// not migrate; see Migrate.
func Open(ctx context.Context, rawURL string) (*DB, error) {
	backend, err := BackendOf(rawURL)
	if err != nil {
		return nil, err
	}
	var db *DB
	switch backend {
	case SQLite:
		db, err = openSQLite(rawURL)
	case Postgres:
		db, err = openPostgres(rawURL)
	}
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("storage: ping %s: %w", backend, err)
	}
	if db.reader != db.DB {
		if err := db.reader.PingContext(ctx); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("storage: ping %s reader: %w", backend, err)
		}
	}
	return db, nil
}

// OpenRetry is Open for a service starting up: a database that does not
// answer is retried with a doubling delay until it does or budget has
// elapsed, each attempt logged at warn, so a service that starts a
// moment before its database (compose, a Kubernetes rollout) comes up
// instead of exiting. A failure that another attempt cannot fix
// (PermanentOpenError: a URL Open can never accept, credentials or a
// database name Postgres refuses, a SQLite file that cannot be opened)
// is returned at once. The last error is returned when the budget runs
// out or ctx ends.
func OpenRetry(ctx context.Context, rawURL string, budget time.Duration) (*DB, error) {
	deadline := time.Now().Add(budget)
	delay := openRetryInitialDelay
	for attempt := 1; ; attempt++ {
		db, err := Open(ctx, rawURL)
		if err == nil {
			return db, nil
		}
		if PermanentOpenError(err) {
			return nil, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, fmt.Errorf("storage: database not reachable after %d attempts over %s: %w", attempt, budget, err)
		}
		if delay > remaining {
			delay = remaining
		}
		slog.Warn("database not reachable, retrying", "attempt", attempt, "delay", delay, "err", err)
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("storage: open gave up after %d attempts: %w (last error: %w)", attempt, ctx.Err(), err)
		case <-time.After(delay):
		}
		delay = min(delay*2, openRetryMaxDelay)
	}
}

// BackendOf reports which backend a database URL names.
func BackendOf(rawURL string) (Backend, error) {
	switch {
	case strings.HasPrefix(rawURL, sqliteScheme):
		return SQLite, nil
	case strings.HasPrefix(rawURL, "postgres://"), strings.HasPrefix(rawURL, "postgresql://"):
		return Postgres, nil
	}
	return "", ErrUnsupportedURL
}

// sqliteScheme is the prefix of every SQLite database URL.
const sqliteScheme = "sqlite://"

// SQLitePath returns the file path of a sqlite:// URL: everything after
// the scheme, verbatim ("sqlite:///var/lib/fd.db" is "/var/lib/fd.db",
// "sqlite://fd.db" is the relative "fd.db").
func SQLitePath(rawURL string) string {
	return strings.TrimPrefix(rawURL, sqliteScheme)
}

// SQLiteURL returns the database URL of the SQLite file at path, the
// inverse of SQLitePath: SQLitePath(SQLiteURL(p)) is p for every p. The
// path follows the scheme byte for byte; nothing in it is
// percent-encoded, because nothing reads it back as a URL. A path with
// spaces, "#", "?", "%" or a Windows drive letter therefore names the
// same file here and in Open (which does the one encoding SQLite needs,
// in sqliteFileURI). Building the URL through net/url instead would
// escape those characters, and Open would then create a second,
// empty database at the escaped path.
func SQLiteURL(path string) string {
	return sqliteScheme + path
}

func openPostgres(rawURL string) (*DB, error) {
	if _, err := url.Parse(rawURL); err != nil {
		// The parse error quotes the URL, password included; it is
		// left out.
		return nil, ErrInvalidURL
	}
	pool, err := sql.Open("pgx", rawURL)
	if err != nil {
		return nil, fmt.Errorf("storage: open postgres: %w", err)
	}
	conns := max(PostgresMinOpenConns, runtime.NumCPU())
	pool.SetMaxOpenConns(conns)
	pool.SetMaxIdleConns(conns)
	pool.SetConnMaxIdleTime(postgresConnMaxIdleTime)
	return &DB{DB: pool, reader: pool, Dialect: postgresDialect{}, Backend: Postgres, url: rawURL}, nil
}

func openSQLite(rawURL string) (*DB, error) {
	path := SQLitePath(rawURL)
	if path == "" || strings.HasPrefix(path, ":memory:") {
		return nil, ErrSQLiteNeedsFile
	}
	writer, err := sql.Open(sqliteDriverName, sqliteDSN(path, true))
	if err != nil {
		return nil, fmt.Errorf("storage: open sqlite: %w", err)
	}
	// One writer connection: see the DB doc. Idle forever so the WAL
	// connection (and the in-memory database) is never dropped.
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	writer.SetConnMaxLifetime(0)
	writer.SetConnMaxIdleTime(0)

	db := &DB{DB: writer, reader: writer, Dialect: sqliteDialect{}, Backend: SQLite, url: rawURL}
	reader, err := openSQLiteReaders(path)
	if err != nil {
		_ = writer.Close()
		return nil, err
	}
	db.reader = reader
	db.checkpointer = startWALCheckpointer(writer, path)
	return db, nil
}

// openSQLiteReaders opens a read pool on the SQLite file at path.
func openSQLiteReaders(path string) (*sql.DB, error) {
	reader, err := sql.Open(sqliteDriverName, sqliteDSN(path, false))
	if err != nil {
		return nil, fmt.Errorf("storage: open sqlite reader: %w", err)
	}
	reader.SetMaxOpenConns(sqliteReaderConns)
	reader.SetMaxIdleConns(sqliteReaderConns)
	reader.SetConnMaxLifetime(0)
	reader.SetConnMaxIdleTime(0)
	return reader, nil
}

// Share returns a handle on the same database for another service of
// the same process, so that one service's load cannot take the
// connections another needs.
//
// On SQLite the handle writes through db's writer, so the process still
// has exactly one writer connection and every write queues on it, and
// reads through a pool of its own: a dashboard's slow listings never
// make the workers' point reads on every event wait for a connection.
// On Postgres, which has no single writer to share, the handle is a
// pool of its own on the same URL, the pool each service has when it
// runs as a process of its own. Three services on one pool sized for
// one were measured storing a third as many events a second under
// read load (84 against 245, 5,000 events, eight readers, pool of four
// against three of four).
//
// Close on the returned handle closes only what Share opened and
// leaves db usable. On SQLite db must stay open for as long as the
// handle is used, and is closed after it.
func (db *DB) Share(ctx context.Context) (*DB, error) {
	if db.Backend != SQLite {
		pool, err := openPostgres(db.url)
		if err != nil {
			return nil, err
		}
		if err := pool.PingContext(ctx); err != nil {
			_ = pool.Close()
			return nil, fmt.Errorf("storage: ping %s: %w", db.Backend, err)
		}
		return pool, nil
	}
	reader, err := openSQLiteReaders(SQLitePath(db.url))
	if err != nil {
		return nil, err
	}
	if err := reader.PingContext(ctx); err != nil {
		_ = reader.Close()
		return nil, fmt.Errorf("storage: ping sqlite reader: %w", err)
	}
	return &DB{DB: db.DB, reader: reader, Dialect: db.Dialect, Backend: db.Backend, url: db.url, shared: true}, nil
}

// sqliteDSN builds the modernc DSN for path. Every connection enables
// WAL (readers and the writer do not block each other), the busy
// timeout, foreign keys (off by default in SQLite), synchronous NORMAL
// (durable across application crashes in WAL mode, with fsync only at
// checkpoints) and case_sensitive_like, so a plain LIKE is
// case-sensitive as on Postgres (Dialect.ILike is the case-insensitive
// match on both). The reader's connections are query_only, so a write
// that reaches the read pool by mistake fails instead of racing the
// writer. The writer additionally begins every transaction IMMEDIATE.
func sqliteDSN(path string, writer bool) string {
	q := url.Values{}
	q["_pragma"] = []string{
		"journal_mode(WAL)",
		fmt.Sprintf("busy_timeout(%d)", sqliteBusyTimeoutMillis),
		"foreign_keys(1)",
		"synchronous(NORMAL)",
		"case_sensitive_like(1)",
	}
	if writer {
		q.Set("_txlock", "immediate")
	} else {
		q["_pragma"] = append(q["_pragma"], "query_only(1)")
	}
	return sqliteFileURI(path) + "?" + q.Encode()
}

// sqliteFileURI renders path as the file: URI SQLite opens (modernc
// passes a DSN that starts with "file:" to SQLite whole, with
// SQLITE_OPEN_URI). SQLite percent-decodes the path and treats the first
// "?" and "#" as the query and fragment separators, so every byte that
// is not safe in a URI path is percent-encoded: a data directory named
// "a#b", "x?y", "50%" or "My Documents" opens the file at that path, not
// a truncated or mis-decoded one. An absolute path becomes
// file:///path; a Windows drive path (C:\x\y.db, in either slash
// style) becomes file:///C:/x/y.db, the form SQLite documents for
// Windows; a relative path stays relative (file:rel/y.db).
func sqliteFileURI(path string) string {
	if isWindowsDrivePath(path) {
		path = "/" + strings.ReplaceAll(path, `\`, "/")
	}
	escaped := (&url.URL{Path: path}).EscapedPath()
	if strings.HasPrefix(escaped, "/") {
		return "file://" + escaped
	}
	return "file:" + escaped
}

// isWindowsDrivePath reports whether path starts with a drive letter
// and a colon, checked by shape rather than runtime.GOOS so the
// rendering is testable everywhere.
func isWindowsDrivePath(path string) bool {
	if len(path) < 3 || path[1] != ':' || (path[2] != '\\' && path[2] != '/') {
		return false
	}
	c := path[0]
	return ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
}

// Reader returns the handle for statements that only read. On SQLite it
// is the read pool, which never waits for the writer; on Postgres it is
// the same pool as DB.
func (db *DB) Reader() *sql.DB {
	return db.reader
}

// URL returns the URL the database was opened with.
func (db *DB) URL() string {
	return db.url
}

// Close closes both handles. On SQLite the last connection to close
// checkpoints the write-ahead log into the database file and removes
// it, so a closed database is one file.
func (db *DB) Close() error {
	if db.shared {
		// The writer is not this handle's to close; its read pool is.
		return db.reader.Close()
	}
	if db.checkpointer != nil {
		db.checkpointer.Stop()
	}
	err := db.DB.Close()
	if db.reader != db.DB {
		if rerr := db.reader.Close(); err == nil {
			err = rerr
		}
	}
	return err
}
