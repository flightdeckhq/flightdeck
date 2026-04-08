package migrate

import (
	"fmt"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// Run applies all pending migrations from the given migrations directory
// to the database at the given URL. Returns nil if already up to date.
func Run(databaseURL string, migrationsDir string) error {
	// golang-migrate's pgx/v5 driver requires pgx5:// scheme
	dbURL := strings.Replace(databaseURL, "postgres://", "pgx5://", 1)
	m, err := migrate.New(
		"file://"+migrationsDir,
		dbURL,
	)
	if err != nil {
		return fmt.Errorf("migrate.New: %w", err)
	}
	defer m.Close()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("migrate.Up: %w", err)
	}
	return nil
}
