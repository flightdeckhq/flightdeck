package storage

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database"
	pgxmigrate "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

// The schema migrations of both backends, embedded so a binary carries
// them. Postgres has the full history; SQLite starts from a baseline
// equal to the Postgres schema at that version, and from then on every
// schema change is a pair with the same version number in both
// directories (scripts/check-migration-pairs.sh fails CI otherwise).
//
//go:embed migrations/postgres/*.sql
var postgresMigrations embed.FS

//go:embed migrations/sqlite/*.sql
var sqliteMigrations embed.FS

// MigrationsFS returns the embedded migration files of a backend, with
// the .up.sql / .down.sql files at its root.
func MigrationsFS(b Backend) (fs.FS, error) {
	switch b {
	case Postgres:
		return fs.Sub(postgresMigrations, "migrations/postgres")
	case SQLite:
		return fs.Sub(sqliteMigrations, "migrations/sqlite")
	}
	return nil, fmt.Errorf("storage: no migrations for backend %q", b)
}

// Migrate applies every pending migration to the database at rawURL
// and returns nil when the schema is already current. It runs on a
// connection of its own, opened and closed here, so the caller's DB is
// untouched; call it before Open or on an open DB alike.
func Migrate(ctx context.Context, rawURL string) error {
	m, err := newMigrator(ctx, rawURL)
	if err != nil {
		return err
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("storage: migrate up: %w", err)
	}
	return nil
}

// MigrateDown reverts every migration (used by tests to prove each
// down file is the inverse of its up file).
func MigrateDown(ctx context.Context, rawURL string) error {
	m, err := newMigrator(ctx, rawURL)
	if err != nil {
		return err
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Down(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("storage: migrate down: %w", err)
	}
	return nil
}

// SchemaVersion reports the current migration version of the database
// at rawURL and whether a migration failed midway (dirty). A database
// with no migration applied reports version 0.
func SchemaVersion(ctx context.Context, rawURL string) (version uint, dirty bool, err error) {
	m, err := newMigrator(ctx, rawURL)
	if err != nil {
		return 0, false, err
	}
	defer func() { _, _ = m.Close() }()
	version, dirty, err = m.Version()
	if errors.Is(err, migrate.ErrNilVersion) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("storage: schema version: %w", err)
	}
	return version, dirty, nil
}

// newMigrator opens a dedicated database handle for golang-migrate,
// which closes the handle it is given when the migrator is closed.
func newMigrator(ctx context.Context, rawURL string) (*migrate.Migrate, error) {
	backend, err := BackendOf(rawURL)
	if err != nil {
		return nil, err
	}
	fsys, err := MigrationsFS(backend)
	if err != nil {
		return nil, err
	}
	src, err := iofs.New(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("storage: migration source: %w", err)
	}

	var (
		handle *sql.DB
		drv    database.Driver
	)
	switch backend {
	case Postgres:
		handle, err = sql.Open("pgx", rawURL)
		if err != nil {
			return nil, fmt.Errorf("storage: open postgres for migrate: %w", err)
		}
		if err := handle.PingContext(ctx); err != nil {
			_ = handle.Close()
			return nil, fmt.Errorf("storage: ping postgres for migrate: %w", err)
		}
		drv, err = pgxmigrate.WithInstance(handle, &pgxmigrate.Config{})
	case SQLite:
		path := SQLitePath(rawURL)
		handle, err = sql.Open(sqliteDriverName, sqliteDSN(path, true))
		if err != nil {
			return nil, fmt.Errorf("storage: open sqlite for migrate: %w", err)
		}
		handle.SetMaxOpenConns(1)
		if err := handle.PingContext(ctx); err != nil {
			_ = handle.Close()
			return nil, fmt.Errorf("storage: ping sqlite for migrate: %w", err)
		}
		drv, err = sqlitemigrate.WithInstance(handle, &sqlitemigrate.Config{})
	}
	if err != nil {
		_ = handle.Close()
		return nil, fmt.Errorf("storage: migration driver: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, string(backend), drv)
	if err != nil {
		_ = drv.Close()
		return nil, fmt.Errorf("storage: migrator: %w", err)
	}
	return m, nil
}
