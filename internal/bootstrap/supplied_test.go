package bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	apiapp "github.com/flightdeckhq/flightdeck/api/app"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// goodToken has the form of a minted token; it is no instance's token.
const goodToken = "ftd_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a"

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestCheckSupplied(t *testing.T) {
	for _, ok := range []string{goodToken, "ftd_0123456789abcdef0123456789abcdef", "ftd_c0ffee1234567890abcdef0987654321"} {
		if err := checkSupplied(ok); err != nil {
			t.Errorf("a well-formed token was refused: %v", err)
		}
	}
	refused := map[string]string{
		"empty":                        "",
		"the development token":        "tok_dev",
		"no prefix":                    "3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a",
		"another prefix":               "tok_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a",
		"an upper-case prefix":         "FTD_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a",
		"one digit short":              "ftd_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1",
		"one digit long":               "ftd_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a0",
		"upper-case hex":               "ftd_3F9C1E7A5B2D4C6E8F0A1B3C5D7E9F1A",
		"a letter that is not hex":     "ftd_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1g",
		"a space inside":               "ftd_3f9c1e7a5b2d4c6e 8f0a1b3c5d7e9f1",
		"a passphrase":                 "ftd_correct-horse-battery-staple-000",
		"all zeros":                    "ftd_00000000000000000000000000000000",
		"one digit repeated":           "ftd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"a word repeated":              "ftd_deadbeefdeadbeefdeadbeefdeadbeef",
		"seven distinct digits":        "ftd_01234560123456012345601234560123",
		"a token with a newline in it": "ftd_3f9c1e7a5b2d4c6e\n8f0a1b3c5d7e9f1",
	}
	for name, value := range refused {
		err := checkSupplied(value)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if !strings.Contains(err.Error(), "ftd_") || !strings.Contains(err.Error(), "openssl rand -hex 16") {
			t.Errorf("%s: the error does not say what a token looks like: %v", name, err)
		}
		// The message never repeats the value, nor its digits.
		if digits := strings.TrimPrefix(value, "ftd_"); len(digits) >= 8 && strings.Contains(err.Error(), digits[:8]) {
			t.Errorf("%s: the error repeats the refused value: %v", name, err)
		}
	}
}

func TestLoadSupplied(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string, mode os.FileMode) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	other := "ftd_a1b3c5d7e9f13f9c1e7a5b2d4c6e8f0a"

	// Nothing set: nothing supplied, the binary mints.
	if s, err := LoadSupplied(envMap(nil)); err != nil || s != nil {
		t.Fatalf("nothing set: %+v, %v", s, err)
	}
	// The file, as a secret mount writes it: a trailing newline, and
	// readable by everyone (Kubernetes mounts 0644, Docker 0444).
	for _, mode := range []os.FileMode{0o600, 0o644, 0o444} {
		path := write("token", goodToken+"\n", mode)
		s, err := LoadSupplied(envMap(map[string]string{TokenFileEnv: path}))
		if err != nil || s == nil || s.Token != goodToken || s.Source != TokenFileEnv || s.Shadowed {
			t.Fatalf("file with mode %04o: %+v, %v", mode, s, err)
		}
		_ = os.Chmod(path, 0o600)
	}
	// Kubernetes mounts a secret's key as a symbolic link.
	if runtime.GOOS != "windows" {
		target := write("..data-token", goodToken, 0o644)
		link := filepath.Join(dir, "linked-token")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if s, err := LoadSupplied(envMap(map[string]string{TokenFileEnv: link})); err != nil || s == nil || s.Token != goodToken {
			t.Fatalf("a symbolic link to the token: %+v, %v", s, err)
		}
	}
	// The variable alone, with the blanks an env file leaves.
	s, err := LoadSupplied(envMap(map[string]string{TokenEnv: " " + other + "\n"}))
	if err != nil || s == nil || s.Token != other || s.Source != TokenEnv {
		t.Fatalf("the variable: %+v, %v", s, err)
	}
	// Both: the file wins, and says so.
	s, err = LoadSupplied(envMap(map[string]string{TokenFileEnv: write("both", goodToken, 0o600), TokenEnv: other}))
	if err != nil || s == nil || s.Token != goodToken || s.Source != TokenFileEnv || !s.Shadowed {
		t.Fatalf("both set: %+v, %v", s, err)
	}

	// What is refused, and that the message names the variable (and the
	// file) but never the content.
	const secretLooking = "hunter2-not-a-token-0123456789abcdef"
	cases := []struct {
		name string
		env  map[string]string
		want []string
	}{
		{"a missing file", map[string]string{TokenFileEnv: filepath.Join(dir, "absent")}, []string{TokenFileEnv, "absent"}},
		{"an empty file", map[string]string{TokenFileEnv: write("empty", "\n", 0o600)}, []string{TokenFileEnv, "empty", "the value is empty"}},
		{"a file that holds something else", map[string]string{TokenFileEnv: write("wrong", secretLooking, 0o600)}, []string{TokenFileEnv, "wrong", `"ftd_" followed by 32`}},
		{"a file far larger than a token", map[string]string{TokenFileEnv: write("large", strings.Repeat("x", 8<<10), 0o600)}, []string{TokenFileEnv, "larger than a token file"}},
		{"a directory", map[string]string{TokenFileEnv: dir}, []string{TokenFileEnv}},
		{"a malformed variable", map[string]string{TokenEnv: secretLooking}, []string{TokenEnv, `"ftd_" followed by 32`}},
		{"a weak variable", map[string]string{TokenEnv: "ftd_00000000000000000000000000000000"}, []string{TokenEnv, "not random"}},
		{"a bad file is not rescued by a good variable", map[string]string{TokenFileEnv: write("wrong2", secretLooking, 0o600), TokenEnv: goodToken}, []string{TokenFileEnv}},
	}
	for _, c := range cases {
		s, err := LoadSupplied(envMap(c.env))
		if err == nil {
			t.Errorf("%s: accepted (%+v)", c.name, s)
			continue
		}
		for _, want := range c.want {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s: the error lacks %q: %v", c.name, want, err)
			}
		}
		for _, leak := range []string{"hunter2", secretLooking[8:20], "xxxxxxxx", "0000000000"} {
			if strings.Contains(err.Error(), leak) {
				t.Errorf("%s: the error repeats the refused content: %v", c.name, err)
			}
		}
	}
}

func suppliedRowCount(t *testing.T, db *storage.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM access_tokens WHERE name = $1", SuppliedTokenName).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A supplied token is stored once across restarts, is what the
// dashboard is served, leaves secrets.json alone, and survives a change
// of the supplied value until it is revoked.
func TestEnsureToken_Supplied(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		before := suppliedRowCount(t, db)
		secretsPath := filepath.Join(t.TempDir(), "secrets.json")
		secrets, err := datadir.LoadSecrets(secretsPath)
		if err != nil {
			t.Fatal(err)
		}
		first := &Supplied{Token: "ftd_9f1a3f9c1e7a5b2d4c6e8f0a1b3c5d7e", Source: TokenFileEnv}

		for start := 1; start <= 3; start++ {
			res, err := EnsureToken(ctx, db, secrets, secretsPath, false, first)
			if err != nil {
				t.Fatalf("start %d: %v", start, err)
			}
			if res.Token != first.Token || res.Source != TokenFileEnv || res.Minted || res.Dev {
				t.Fatalf("start %d: %+v, want the supplied token and its source", start, res)
			}
		}
		if n := suppliedRowCount(t, db) - before; n != 1 {
			t.Fatalf("%d rows after three starts with one supplied token, want 1", n)
		}
		if ok, err := apiapp.TokenValid(ctx, db, first.Token); err != nil || !ok {
			t.Fatalf("the supplied token does not resolve: %v, %v", ok, err)
		}
		// Its source is the operator's file: the data dir keeps no copy.
		reloaded, err := datadir.LoadSecrets(secretsPath)
		if err != nil {
			t.Fatal(err)
		}
		if reloaded.DashboardToken != "" {
			t.Fatalf("secrets.json holds a dashboard token (%d chars); a supplied token is not written there", len(reloaded.DashboardToken))
		}

		// The operator changes the token.
		second := &Supplied{Token: "ftd_1b3c5d7e9f1a3f9c1e7a5b2d4c6e8f0a", Source: TokenEnv}
		res, err := EnsureToken(ctx, db, secrets, secretsPath, false, second)
		if err != nil || res.Token != second.Token || res.Source != TokenEnv {
			t.Fatalf("after the change: %+v, %v", res, err)
		}
		for _, tok := range []string{first.Token, second.Token} {
			if ok, err := apiapp.TokenValid(ctx, db, tok); err != nil || !ok {
				t.Fatalf("after the change, both the old and the new token must resolve (%v, %v)", ok, err)
			}
		}

		// The operator stops supplying one: the binary mints, as it
		// does with nothing supplied, and the supplied ones stay.
		res, err = EnsureToken(ctx, db, secrets, secretsPath, false, nil)
		if err != nil || !res.Minted || res.Source != "" || res.Token == first.Token || res.Token == second.Token {
			t.Fatalf("with nothing supplied: %+v, %v, want a minted token", res, err)
		}
		if ok, err := apiapp.TokenValid(ctx, db, second.Token); err != nil || !ok {
			t.Fatalf("the supplied token stopped resolving once it was no longer supplied (%v, %v)", ok, err)
		}

		// Loopback: the development token, whatever was supplied.
		res, err = EnsureToken(ctx, db, secrets, secretsPath, true, first)
		if err != nil || res.Token != DevToken || !res.Dev || res.Source != "" {
			t.Fatalf("dev mode with a supplied token: %+v, %v", res, err)
		}
	})
}
