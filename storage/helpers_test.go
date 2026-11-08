package storage_test

import (
	"context"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
)

// createTable creates a scratch table for one test with per-backend
// DDL (the column types differ), dropping any leftover first and
// dropping it again when the test ends. Postgres tests share a database
// per package, so each test owns a table name of its own.
func createTable(t *testing.T, db *storage.DB, name, postgresDDL, sqliteDDL string) {
	t.Helper()
	ctx := context.Background()
	ddl := sqliteDDL
	if db.Backend == storage.Postgres {
		ddl = postgresDDL
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+name); err != nil {
		t.Fatalf("drop leftover %s: %v", name, err)
	}
	if _, err := db.ExecContext(ctx, "CREATE TABLE "+name+" "+ddl); err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+name)
	})
}

func mustExec(t *testing.T, db *storage.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func queryString(t *testing.T, db *storage.DB, query string, args ...any) string {
	t.Helper()
	var s string
	if err := db.QueryRowContext(context.Background(), query, args...).Scan(&s); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return s
}

func queryInt(t *testing.T, db *storage.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return n
}
