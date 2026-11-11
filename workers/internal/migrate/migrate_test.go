package migrate

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestPgx5URL(t *testing.T) {
	if got := pgx5URL("postgres://u:p@h:5432/db?sslmode=disable"); got != "pgx5://u:p@h:5432/db?sslmode=disable" {
		t.Fatalf("%q", got)
	}
	if got := pgx5URL("pgx5://already"); got != "pgx5://already" {
		t.Fatalf("%q", got)
	}
}

func TestRunFS_EmptySourceStillReachesTheDatabaseStep(t *testing.T) {
	// iofs accepts a filesystem with no migration files, so an empty
	// source is not caught before the database is opened; the error a
	// caller sees names the database step.
	err := RunFS("://no-scheme", fstest.MapFS{})
	if err == nil || !strings.Contains(err.Error(), "migrate.New") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunFS_ReadsTheMigrationsThenFailsOnTheDatabase(t *testing.T) {
	fsys := fstest.MapFS{
		"000001_init.up.sql":   {Data: []byte("SELECT 1;")},
		"000001_init.down.sql": {Data: []byte("SELECT 1;")},
	}
	err := RunFS("://no-scheme", fsys)
	if err == nil || !strings.Contains(err.Error(), "migrate.New") {
		t.Fatalf("err = %v", err)
	}
}
