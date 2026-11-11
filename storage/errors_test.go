package storage_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/jackc/pgx/v5/pgconn"
)

// Real refusals from both engines classify as data errors; a cancelled
// context, which is how a dropped connection or a deadline reaches a
// store, does not.
func TestIsDataError_OnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		createTable(t, db, "storagetest_data_errors",
			"(id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER CHECK (n > 0), u TEXT UNIQUE)",
			"(id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER CHECK (n > 0), u TEXT UNIQUE)")
		mustExec(t, db, "INSERT INTO storagetest_data_errors (id, name, n, u) VALUES (1, 'a', 1, 'x')")

		cases := map[string]string{
			"not null":  "INSERT INTO storagetest_data_errors (id, name) VALUES (2, NULL)",
			"check":     "INSERT INTO storagetest_data_errors (id, name, n) VALUES (3, 'b', 0)",
			"unique":    "INSERT INTO storagetest_data_errors (id, name, u) VALUES (4, 'c', 'x')",
			"duplicate": "INSERT INTO storagetest_data_errors (id, name) VALUES (1, 'd')",
		}
		if db.Backend == storage.Postgres {
			// text cannot hold a NUL byte (SQLSTATE 22021); SQLite stores
			// it, so the case is Postgres-only.
			cases["nul byte"] = "INSERT INTO storagetest_data_errors (id, name) VALUES (5, 'a' || chr(0) || 'b')"
		}
		for name, q := range cases {
			_, err := db.ExecContext(ctx, q)
			if err == nil {
				t.Errorf("%s: statement succeeded, want a refusal", name)
				continue
			}
			if !storage.IsDataError(err) {
				t.Errorf("%s: IsDataError(%v) = false, want true", name, err)
			}
			if !storage.IsDataError(fmt.Errorf("insert: %w", err)) {
				t.Errorf("%s: a wrapped data error was not recognised", name)
			}
		}

		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		_, err := db.ExecContext(cancelled, "INSERT INTO storagetest_data_errors (id, name) VALUES (6, 'e')")
		if err == nil {
			t.Fatal("a cancelled context ran the statement")
		}
		if storage.IsDataError(err) {
			t.Errorf("IsDataError(%v) = true for a cancelled context, want false", err)
		}
	})
}

func TestIsDataError_PostgresClasses(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"NUL byte in text (22021)", &pgconn.PgError{Code: "22021"}, true},
		{"not-null violation (23502)", &pgconn.PgError{Code: "23502"}, true},
		{"program limit (54000)", &pgconn.PgError{Code: "54000"}, true},
		{"statement timeout (57014)", &pgconn.PgError{Code: "57014"}, false},
		{"serialization failure (40001)", &pgconn.PgError{Code: "40001"}, false},
		{"deadlock (40P01)", &pgconn.PgError{Code: "40P01"}, false},
		{"empty code", &pgconn.PgError{}, false},
		{"plain error", errors.New("conn closed"), false},
		{"nil", nil, false},
	}
	for _, c := range cases {
		if got := storage.IsDataError(c.err); got != c.want {
			t.Errorf("%s: IsDataError = %v, want %v", c.name, got, c.want)
		}
	}
}
