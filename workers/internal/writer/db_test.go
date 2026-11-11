package writer

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
)

func TestDatabaseURL_SetsTheLockTimeoutOnPostgresOnly(t *testing.T) {
	got, err := DatabaseURL("postgres://u:p@localhost:5432/flightdeck?sslmode=disable")
	if err != nil {
		t.Fatalf("DatabaseURL: %v", err)
	}
	if !strings.Contains(got, "lock_timeout=8000") || !strings.Contains(got, "sslmode=disable") {
		t.Fatalf("url = %q, want lock_timeout=8000 (ms) added and sslmode kept", got)
	}
	kept, err := DatabaseURL("postgres://u:p@localhost/fd?lock_timeout=100")
	if err != nil || !strings.Contains(kept, "lock_timeout=100") || strings.Contains(kept, "8000") {
		t.Fatalf("an operator's lock_timeout must be kept: %q, %v", kept, err)
	}
	sqlite, err := DatabaseURL("sqlite:///var/lib/flightdeck/fd.db")
	if err != nil || sqlite != "sqlite:///var/lib/flightdeck/fd.db" {
		t.Fatalf("a sqlite url must be returned unchanged: %q, %v", sqlite, err)
	}
	if _, err := DatabaseURL("mysql://x"); err == nil {
		t.Fatal("an unsupported url was accepted")
	}
}

// The runtime parameter reaches the server: every connection of a pool
// opened on the worker's URL reports the lock timeout. SQLite has no
// such parameter, so that half of the run has nothing to check.
func TestDatabaseURL_LockTimeoutReachesPostgres(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		if db.Backend != storage.Postgres {
			return
		}
		dbURL, err := DatabaseURL(db.URL())
		if err != nil {
			t.Fatal(err)
		}
		ctx := context.Background()
		opened, err := storage.Open(ctx, dbURL)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		defer func() { _ = opened.Close() }()
		var timeout string
		if err := opened.QueryRowContext(ctx, "SHOW lock_timeout").Scan(&timeout); err != nil {
			t.Fatal(err)
		}
		if timeout != "8s" {
			t.Fatalf("lock_timeout = %q, want 8s", timeout)
		}
	})
}

// A Postgres URL that does not parse is refused without its text: the
// parse error would quote the URL, password included.
func TestDatabaseURL_UnparsableURLIsRefusedWithoutItsPassword(t *testing.T) {
	_, err := DatabaseURL("postgres://worker:s3cret pass@localhost:5432/db%zz")
	if !errors.Is(err, storage.ErrInvalidURL) {
		t.Fatalf("err = %v, want storage.ErrInvalidURL", err)
	}
	if strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("the error repeats the password: %v", err)
	}
}
