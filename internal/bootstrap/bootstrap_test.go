package bootstrap

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

func TestLoopback(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:4000":   true,
		"127.0.0.2:4000":   true,
		"localhost:4000":   true,
		"LOCALHOST:4100":   true,
		"[::1]:4000":       true,
		":4000":            false,
		"0.0.0.0:4000":     false,
		"[::]:4000":        false,
		"192.168.1.10:80":  false,
		"example.com:4000": false,
		"4000":             false,
		"":                 false,
	}
	for addr, want := range cases {
		if got := Loopback(addr); got != want {
			t.Errorf("Loopback(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestDevMode_NeedsLoopbackAndNoDomain(t *testing.T) {
	if !DevMode("127.0.0.1:4000", "") {
		t.Fatal("loopback without a domain is dev mode")
	}
	if DevMode("127.0.0.1:4000", "flightdeck.example.com") {
		t.Fatal("a domain turns dev mode off even on loopback")
	}
	if DevMode(":4000", "") {
		t.Fatal("every interface is not dev mode")
	}
}

func TestEnsureToken_DevModeNeedsNoDatabase(t *testing.T) {
	res, err := EnsureToken(context.Background(), nil, nil, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Token != DevToken || !res.Dev || res.Minted {
		t.Fatalf("%+v", res)
	}
}

// Outside dev mode the token lives in two places that must agree: the
// plaintext in secrets.json and its salted hash in the database. The
// first start mints, a later start on the same data dir and database
// reuses, and a start whose database no longer knows the stored token
// (a new database under an old data dir) mints again.
func TestEnsureToken_MintsOnceReusesAndRemintsForANewDatabase(t *testing.T) {
	ctx := context.Background()
	db := storagetest.OpenSQLite(t)
	secretsPath := filepath.Join(t.TempDir(), "secrets.json")
	secrets, err := datadir.LoadSecrets(secretsPath)
	if err != nil {
		t.Fatal(err)
	}

	first, err := EnsureToken(ctx, db, secrets, secretsPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Minted || first.Dev || !strings.HasPrefix(first.Token, "ftd_") {
		t.Fatalf("first start: %+v, want a minted ftd_ token", first)
	}
	// The plaintext reached the file, so the next process finds it.
	reloaded, err := datadir.LoadSecrets(secretsPath)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.DashboardToken != first.Token {
		t.Fatalf("secrets.json holds %q, want the minted token", reloaded.DashboardToken)
	}

	second, err := EnsureToken(ctx, db, reloaded, secretsPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if second.Minted || second.Token != first.Token {
		t.Fatalf("second start: %+v, want the first start's token reused", second)
	}

	// The same data dir on a database that has never seen the token.
	fresh := storagetest.OpenSQLite(t)
	third, err := EnsureToken(ctx, fresh, reloaded, secretsPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if !third.Minted || third.Token == first.Token {
		t.Fatalf("new database: %+v, want a newly minted token", third)
	}
	var names int
	if err := fresh.Reader().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM access_tokens WHERE name = $1`, TokenName).Scan(&names); err != nil {
		t.Fatal(err)
	}
	if names != 1 {
		t.Fatalf("%d access tokens named %q in the new database, want 1", names, TokenName)
	}
}
