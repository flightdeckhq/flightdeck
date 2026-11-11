// Package migrate applies the schema migrations with golang-migrate,
// from a directory on disk (the compose mount) or from an embedded
// filesystem (the flightdeck binary).
package migrate

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5" // the pgx5:// database driver
	_ "github.com/golang-migrate/migrate/v4/source/file"     // the file:// source
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

// Run applies all pending migrations from the given migrations directory
// to the database at the given URL. Returns nil if already up to date.
func Run(databaseURL string, migrationsDir string) error {
	m, err := migrate.New("file://"+migrationsDir, pgx5URL(databaseURL))
	if err != nil {
		return fmt.Errorf("migrate.New: %w", err)
	}
	return up(m)
}

// RunFS applies all pending migrations from fsys, whose root holds the
// numbered up/down pairs, to the database at the given URL. Returns nil
// if already up to date.
func RunFS(databaseURL string, fsys fs.FS) error {
	src, err := iofs.New(fsys, ".")
	if err != nil {
		return fmt.Errorf("migrations source: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, pgx5URL(databaseURL))
	if err != nil {
		return fmt.Errorf("migrate.New: %w", err)
	}
	return up(m)
}

// pgx5URL rewrites a postgres:// URL to the pgx5:// scheme golang-migrate's
// pgx/v5 driver registers under.
func pgx5URL(databaseURL string) string {
	return strings.Replace(databaseURL, "postgres://", "pgx5://", 1)
}

func up(m *migrate.Migrate) error {
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate.Up: %w", err)
	}
	return nil
}
