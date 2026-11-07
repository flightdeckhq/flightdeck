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
	"net/url"
	"strings"

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

// sqliteBusyTimeoutMillis is how long an SQLite connection waits for a
// lock held by another connection before failing with SQLITE_BUSY.
// Writes serialise on the writer handle in Go (one connection), so the
// wait only covers an out-of-process writer such as a sqlite3 shell on
// the same file; five seconds outlives any such interactive statement
// without hiding a stuck process behind an endless wait.
const sqliteBusyTimeoutMillis = 5000

// sqliteReaderConns bounds the SQLite read pool. Readers never block
// each other or the writer in WAL mode, so the number only caps the
// memory of idle connections; eight covers the dashboard's concurrent
// fetches on a page load with the API's own background reads.
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
// statements that only read; in WAL mode they neither block the writer
// nor are blocked by it. A read that must see a transaction's own
// uncommitted rows runs on the transaction, not on Reader. On Postgres
// both handles are the same pool.
type DB struct {
	*sql.DB
	// Dialect is the SQL dialect of Backend.
	Dialect Dialect
	// Backend names the engine behind the handles.
	Backend Backend

	reader *sql.DB
	// url is the URL Open received; the Postgres Bus dials it for LISTEN.
	url string
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

// BackendOf reports which backend a database URL names.
func BackendOf(rawURL string) (Backend, error) {
	switch {
	case strings.HasPrefix(rawURL, "sqlite://"):
		return SQLite, nil
	case strings.HasPrefix(rawURL, "postgres://"), strings.HasPrefix(rawURL, "postgresql://"):
		return Postgres, nil
	}
	return "", ErrUnsupportedURL
}

// SQLitePath returns the file path of a sqlite:// URL: everything after
// the scheme, verbatim ("sqlite:///var/lib/fd.db" is "/var/lib/fd.db",
// "sqlite://fd.db" is the relative "fd.db").
func SQLitePath(rawURL string) string {
	return strings.TrimPrefix(rawURL, "sqlite://")
}

func openPostgres(rawURL string) (*DB, error) {
	if _, err := url.Parse(rawURL); err != nil {
		return nil, fmt.Errorf("storage: parse postgres URL: %w", err)
	}
	pool, err := sql.Open("pgx", rawURL)
	if err != nil {
		return nil, fmt.Errorf("storage: open postgres: %w", err)
	}
	return &DB{DB: pool, reader: pool, Dialect: postgresDialect{}, Backend: Postgres, url: rawURL}, nil
}

func openSQLite(rawURL string) (*DB, error) {
	path := SQLitePath(rawURL)
	if path == "" || strings.HasPrefix(path, ":memory:") {
		// An in-memory database is private to one connection; the
		// read pool and the migrator would each see an empty one.
		return nil, errors.New("storage: sqlite URL must name a file")
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
	reader, err := sql.Open(sqliteDriverName, sqliteDSN(path, false))
	if err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("storage: open sqlite reader: %w", err)
	}
	reader.SetMaxOpenConns(sqliteReaderConns)
	reader.SetMaxIdleConns(sqliteReaderConns)
	reader.SetConnMaxLifetime(0)
	reader.SetConnMaxIdleTime(0)
	db.reader = reader
	return db, nil
}

// sqliteDSN builds the modernc DSN for path. Every connection enables
// WAL (readers and the writer do not block each other), the busy
// timeout, foreign keys (off by default in SQLite) and synchronous
// NORMAL (durable across application crashes in WAL mode, with fsync
// only at checkpoints). The writer additionally begins every
// transaction IMMEDIATE.
func sqliteDSN(path string, writer bool) string {
	q := url.Values{}
	q["_pragma"] = []string{
		"journal_mode(WAL)",
		fmt.Sprintf("busy_timeout(%d)", sqliteBusyTimeoutMillis),
		"foreign_keys(1)",
		"synchronous(NORMAL)",
	}
	if writer {
		q.Set("_txlock", "immediate")
	}
	return "file:" + path + "?" + q.Encode()
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

// Close closes both handles.
func (db *DB) Close() error {
	err := db.DB.Close()
	if db.reader != db.DB {
		if rerr := db.reader.Close(); err == nil {
			err = rerr
		}
	}
	return err
}
