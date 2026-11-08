package datadir

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDefault_IsUnderTheHomeDirectory(t *testing.T) {
	d := Default()
	if runtime.GOOS == "windows" {
		if !strings.HasSuffix(d, `\flightdeck`) {
			t.Fatalf("%q", d)
		}
		return
	}
	home, _ := os.UserHomeDir()
	if d != filepath.Join(home, ".flightdeck") {
		t.Fatalf("%q", d)
	}
}

func TestEnsure_CreatesTheLayoutPrivately(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	l, err := Ensure(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{l.Root, l.NATS, l.ACME} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", p)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
			t.Fatalf("%s mode %04o, want 0700", p, info.Mode().Perm())
		}
	}
	if l.Secrets != filepath.Join(l.Root, "secrets.json") {
		t.Fatalf("secrets path %q", l.Secrets)
	}
	// A second Ensure on the same directory is a no-op.
	again, err := Ensure(root)
	if err != nil {
		t.Fatal(err)
	}
	if again.Warning != "" {
		t.Fatalf("a 0700 data dir drew a warning: %q", again.Warning)
	}
}

func TestEnsure_WarnsAboutAWideDataDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not checked on Windows")
	}
	root := filepath.Join(t.TempDir(), "shared")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	l, err := Ensure(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"0755", "chmod 700", root} {
		if !strings.Contains(l.Warning, want) {
			t.Fatalf("warning %q lacks %q", l.Warning, want)
		}
	}
	// The directory is used as it is: Ensure does not change modes.
	info, _ := os.Stat(root)
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("Ensure changed the mode to %04o", info.Mode().Perm())
	}
}

func TestLoadSecrets_CreatesOnceAndReloads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	s, err := LoadSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	if b, err := hex.DecodeString(s.JWTSecret); err != nil || len(b) != secretBytes {
		t.Fatalf("jwt secret %q is not %d random bytes in hex", s.JWTSecret, secretBytes)
	}
	if s.DashboardToken != "" {
		t.Fatalf("a new secrets file has no dashboard token: %q", s.DashboardToken)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("mode %04o, want 0600", info.Mode().Perm())
		}
	}
	s.DashboardToken = "ftd_0123456789abcdef0123456789abcdef"
	if err := SaveSecrets(path, s); err != nil {
		t.Fatal(err)
	}
	again, err := LoadSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	if again.JWTSecret != s.JWTSecret || again.DashboardToken != s.DashboardToken {
		t.Fatalf("reloaded %+v, want %+v", again, s)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary file left behind: %v", err)
	}
}

func TestLoadSecrets_RefusesAWorldReadableFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not checked on Windows")
	}
	path := filepath.Join(t.TempDir(), "secrets.json")
	if err := os.WriteFile(path, []byte(`{"jwt_secret":"ab"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := LoadSecrets(path)
	if err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("err = %v, want a mode complaint", err)
	}
}

func TestLoadSecrets_FillsAMissingJWTSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	if err := os.WriteFile(path, []byte(`{"dashboard_token":"ftd_x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := LoadSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.JWTSecret == "" || s.DashboardToken != "ftd_x" {
		t.Fatalf("%+v", s)
	}
}

func TestLoadSecrets_RejectsBadJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	if err := os.WriteFile(path, []byte(`{`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSecrets(path); err == nil {
		t.Fatal("want a parse error")
	}
}
