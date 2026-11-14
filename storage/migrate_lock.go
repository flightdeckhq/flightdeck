package storage

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

// Instances that start together on one database each apply the
// migrations (the binary's pods under one Deployment, the standalone
// workers' replicas). golang-migrate serialises them itself, but on
// Postgres it does so with a session that blocks in pg_advisory_lock
// for as long as another instance migrates. A blocked statement is an
// open transaction, and CREATE INDEX CONCURRENTLY waits for every open
// transaction to finish, while the blocked one waits for the index
// builder's lock: Postgres detects the deadlock and cancels the build,
// leaving the schema dirty (four instances on an empty database stopped
// at version 30). On SQLite golang-migrate's lock is a flag of each
// migrator object and excludes nothing.
//
// So every Migrate, MigrateDown and SchemaVersion first takes a lock of
// this package's own, before golang-migrate opens its session: on
// Postgres an advisory lock asked for in short statements that return
// at once, so a waiting instance holds no transaction between them; on
// SQLite a lock file beside the database and a mutex of the process.
// Once an instance holds it, golang-migrate's own lock is free and its
// waits are short.

const (
	// migrationLockWait bounds how long an instance waits for another
	// to finish applying the migrations. The migrations to date take
	// seconds on an empty database, and an index built over a large
	// events table takes minutes; ten minutes outlasts that and still
	// turns a holder that never lets go into an error that names the
	// wait. A holder that dies loses its lock at once: Postgres drops a
	// session's advisory locks with its connection, the kernel drops a
	// file lock with its process.
	migrationLockWait = 10 * time.Minute
	// migrationLockPoll is how often a waiting instance asks again.
	// Each ask is one statement, or one system call, that answers at
	// once; four a second cost nothing and start the waiter within a
	// quarter of a second of the holder's end.
	migrationLockPoll = 250 * time.Millisecond
	// migrationLockReport is how often a waiting instance logs that it
	// is still waiting, so a start that waits is not mistaken for one
	// that hangs.
	migrationLockReport = 30 * time.Second
)

// The Postgres advisory lock that serialises the migrations of every
// instance on one database. Advisory locks belong to one database, so
// one key serves all of them. It is a pair of int4 keys, a space of
// its own: golang-migrate's lock is a single bigint key and never
// collides with it. The first key spells "FDMG" (Flightdeck migrations).
const (
	migrationLockClass int32 = 0x46444d47
	migrationLockKey   int32 = 1
)

// migrateLockSuffix names the lock file of a SQLite database's
// migrations: the database's real path (symbolic links resolved) with
// this suffix, beside it. It is not the binary's own "<database>.lock",
// which a running instance holds for as long as it runs. A hard link
// to the database has a lock file of its own name, so two processes
// that reach one file through two hard links are not excluded from
// each other; see Migrate.
const migrateLockSuffix = ".migrate.lock"

// lockMigrations takes the migration lock of the database at rawURL,
// waiting for another holder up to migrationLockWait, and returns the
// function that releases it. ctx ends the wait.
func lockMigrations(ctx context.Context, rawURL string) (func(), error) {
	backend, err := BackendOf(rawURL)
	if err != nil {
		return nil, err
	}
	if backend == Postgres {
		return lockPostgresMigrations(ctx, rawURL)
	}
	return lockSQLiteMigrations(ctx, SQLitePath(rawURL))
}

func lockPostgresMigrations(ctx context.Context, rawURL string) (func(), error) {
	db, err := sql.Open("pgx", rawURL)
	if err != nil {
		return nil, fmt.Errorf("storage: open postgres for the migration lock: %w", err)
	}
	// One session holds the lock from the first ask to the release.
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("storage: connect for the migration lock: %w", err)
	}
	try := func() (bool, error) {
		var taken bool
		err := conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1::int4, $2::int4)`,
			migrationLockClass, migrationLockKey).Scan(&taken)
		return taken, err
	}
	if err := waitForMigrationLock(ctx, try, MaskURL(rawURL), migrationLockWait); err != nil {
		_ = conn.Close()
		_ = db.Close()
		return nil, err
	}
	return func() {
		// Closing the session releases the lock as well; the unlock
		// lets the next instance in before the pool winds down.
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1::int4, $2::int4)`,
			migrationLockClass, migrationLockKey)
		_ = conn.Close()
		_ = db.Close()
	}, nil
}

// sqliteMigrationMutex is the mutex that serialises the migrations of
// one SQLite database file in this process.
type sqliteMigrationMutex struct {
	path string // the file's real path (ResolveSQLitePath)
	mu   sync.Mutex
}

// sqliteMigrationMutexes holds one entry per SQLite database file this
// process has migrated. On platforms without file locks the mutex is
// the only exclusion; elsewhere it also covers what the lock file
// cannot: a hard link, which no path resolves (see
// sqliteMigrationMutexFor).
var (
	sqliteMigrationRegistry sync.Mutex
	sqliteMigrationMutexes  []*sqliteMigrationMutex
)

// sqliteMigrationMutexFor returns the mutex of the database whose real
// path is path: the entry of that path, or the entry of another path
// that names the same file (os.SameFile: a hard link, on every
// platform), or a new one. The files are looked at when the lock is
// asked for, so a database created by an earlier migration is matched
// to its hard links once it exists.
func sqliteMigrationMutexFor(path string) *sync.Mutex {
	sqliteMigrationRegistry.Lock()
	defer sqliteMigrationRegistry.Unlock()
	info, statErr := os.Stat(path)
	for _, m := range sqliteMigrationMutexes {
		if m.path == path {
			return &m.mu
		}
		if statErr != nil {
			continue
		}
		if other, err := os.Stat(m.path); err == nil && os.SameFile(info, other) {
			return &m.mu
		}
	}
	m := &sqliteMigrationMutex{path: path}
	sqliteMigrationMutexes = append(sqliteMigrationMutexes, m)
	return &m.mu
}

func lockSQLiteMigrations(ctx context.Context, path string) (func(), error) {
	resolved, err := ResolveSQLitePath(path)
	if err != nil {
		return nil, fmt.Errorf("storage: SQLite database path: %w", err)
	}
	mu := sqliteMigrationMutexFor(resolved)
	if err := waitForMigrationLock(ctx, func() (bool, error) { return mu.TryLock(), nil }, resolved, migrationLockWait); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(resolved+migrateLockSuffix, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		mu.Unlock()
		return nil, fmt.Errorf("storage: the migration lock file: %w", err)
	}
	if err := waitForMigrationLock(ctx, func() (bool, error) { return tryLockFile(f) }, resolved, migrationLockWait); err != nil {
		_ = f.Close()
		mu.Unlock()
		return nil, err
	}
	return func() {
		_ = unlockFile(f)
		_ = f.Close()
		mu.Unlock()
	}, nil
}

// waitForMigrationLock calls try until it reports the lock taken,
// every migrationLockPoll, for at most wait (migrationLockWait), logging when
// it starts waiting and every migrationLockReport after. database names
// the database for the log and the error, its password masked.
func waitForMigrationLock(ctx context.Context, try func() (bool, error), database string, wait time.Duration) error {
	began := time.Now()
	var reported time.Time
	for {
		taken, err := try()
		if err != nil {
			return fmt.Errorf("storage: take the migration lock: %w", err)
		}
		if taken {
			if !reported.IsZero() {
				slog.Info("the other instance is done with the migrations; checking the schema", "database", database,
					"waited", time.Since(began).Round(time.Second))
			}
			return nil
		}
		now := time.Now()
		switch {
		case reported.IsZero():
			slog.Info("another instance is applying the migrations to this database; waiting for it", "database", database)
			reported = now
		case now.Sub(reported) >= migrationLockReport:
			slog.Info("still waiting for another instance to finish the migrations", "database", database,
				"waited", now.Sub(began).Round(time.Second))
			reported = now
		}
		if now.Sub(began) >= wait {
			return fmt.Errorf("storage: another instance has been applying the migrations to %s for more than %s; "+
				"if none is running, the holder is stuck: stop it, and the next start applies the migrations", database, wait)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("storage: waiting for the migration lock: %w", ctx.Err())
		case <-time.After(migrationLockPoll):
		}
	}
}
