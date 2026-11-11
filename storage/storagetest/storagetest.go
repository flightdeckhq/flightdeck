// Package storagetest opens migrated databases for the Go tests that
// run SQL, on every backend the test run covers.
//
// Which backends run is decided by the environment:
//
//	FLIGHTDECK_TEST_BACKEND=sqlite     SQLite only
//	FLIGHTDECK_TEST_BACKEND=postgres   Postgres only; TEST_POSTGRES_URL
//	                                   must name a database (the test
//	                                   skips otherwise, which the DB
//	                                   test harness treats as a failure)
//	unset                              SQLite always, and Postgres when
//	                                   TEST_POSTGRES_URL is set
//
// SQLite needs no server: every test gets a fresh file in its temp
// directory, migrated from the embedded baseline, so `go test ./...`
// covers the SQLite half of every DB test everywhere. Postgres tests
// share the database TEST_POSTGRES_URL names (scripts/go-db-tests.sh
// gives each package one of its own) and must keep to rows they
// created.
package storagetest

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
)

// BackendEnv is the variable that selects the backends a run covers.
const BackendEnv = "FLIGHTDECK_TEST_BACKEND"

// PostgresURLEnv names the Postgres database the Postgres half runs on.
const PostgresURLEnv = "TEST_POSTGRES_URL"

// Backends returns the backends this run covers, in run order.
func Backends(t testing.TB) []storage.Backend {
	t.Helper()
	switch v := os.Getenv(BackendEnv); v {
	case "sqlite":
		return []storage.Backend{storage.SQLite}
	case "postgres":
		return []storage.Backend{storage.Postgres}
	case "":
		if os.Getenv(PostgresURLEnv) != "" {
			return []storage.Backend{storage.SQLite, storage.Postgres}
		}
		return []storage.Backend{storage.SQLite}
	default:
		t.Fatalf("%s=%q: want sqlite, postgres or unset", BackendEnv, v)
		return nil
	}
}

// Each runs fn once per covered backend, as a subtest named after the
// backend, with an open and migrated database that closes when the
// subtest ends.
func Each(t *testing.T, fn func(t *testing.T, db *storage.DB)) {
	t.Helper()
	for _, b := range Backends(t) {
		t.Run(string(b), func(t *testing.T) {
			fn(t, Open(t, b))
		})
	}
}

// Open returns an open, migrated database of the given backend.
func Open(t testing.TB, b storage.Backend) *storage.DB {
	t.Helper()
	switch b {
	case storage.SQLite:
		return OpenSQLite(t)
	case storage.Postgres:
		return OpenPostgres(t)
	}
	t.Fatalf("unknown backend %q", b)
	return nil
}

// OpenSQLite creates a fresh SQLite database in the test's temp
// directory, migrates it and opens it.
func OpenSQLite(t testing.TB) *storage.DB {
	t.Helper()
	url := "sqlite://" + filepath.Join(t.TempDir(), "flightdeck.db")
	return openMigrated(t, url)
}

// OpenPostgres opens the database TEST_POSTGRES_URL names, migrated to
// the newest version. It skips the test when the variable is unset.
func OpenPostgres(t testing.TB) *storage.DB {
	t.Helper()
	url := PostgresURL(t)
	return openMigrated(t, url)
}

// PostgresURL returns TEST_POSTGRES_URL or skips the test.
func PostgresURL(t testing.TB) string {
	t.Helper()
	url := os.Getenv(PostgresURLEnv)
	if url == "" {
		t.Skipf("%s not set; skipping the Postgres half", PostgresURLEnv)
	}
	return url
}

func openMigrated(t testing.TB, url string) *storage.DB {
	t.Helper()
	ctx := context.Background()
	if err := storage.Migrate(ctx, url); err != nil {
		t.Fatalf("migrate %s: %v", redact(url), err)
	}
	db, err := storage.Open(ctx, url)
	if err != nil {
		t.Fatalf("open %s: %v", redact(url), err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// redact keeps a Postgres password out of test output.
func redact(url string) string {
	return storage.MaskURL(url)
}
