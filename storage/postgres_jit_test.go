package storage_test

import (
	"context"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// showJIT is the jit setting of a connection of the pool.
func showJIT(t *testing.T, db *storage.DB) string {
	t.Helper()
	var v string
	if err := db.QueryRowContext(context.Background(), "SHOW jit").Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func withParam(url, param string) string {
	if strings.Contains(url, "?") {
		return url + "&" + param
	}
	return url + "?" + param
}

// TestPostgresConnections_RunWithJITOff checks that every pool the
// storage module opens on Postgres, a shared one included, runs with JIT
// compilation off, and that a jit setting in the URL wins.
func TestPostgresConnections_RunWithJITOff(t *testing.T) {
	base := storagetest.PostgresURL(t)
	t.Setenv("PGOPTIONS", "")
	ctx := context.Background()

	db := storagetest.OpenPostgres(t)
	if got := showJIT(t, db); got != "off" {
		t.Errorf("jit = %q on a storage connection, want off", got)
	}
	shared, err := db.Share(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = shared.Close() }()
	if got := showJIT(t, shared); got != "off" {
		t.Errorf("jit = %q on a shared handle's connection, want off", got)
	}

	for _, param := range []string{"jit=on", "options=-c%20jit%3Don"} {
		own, err := storage.Open(ctx, withParam(base, param))
		if err != nil {
			t.Fatal(err)
		}
		if got := showJIT(t, own); got != "on" {
			t.Errorf("jit = %q with %s in the URL, want the operator's on", got, param)
		}
		_ = own.Close()
	}
}
