package connect

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckServer(t *testing.T) {
	accepted := []struct {
		raw, want string
		local     bool
	}{
		{"http://localhost:4000", "http://localhost:4000", true},
		{"  http://localhost:4000/ingest \n", "http://localhost:4000/ingest", true},
		{"http://127.0.0.1:4100", "http://127.0.0.1:4100", true},
		{"http://127.1.2.3:4000", "http://127.1.2.3:4000", true},
		{"http://[::1]:4000/ingest", "http://[::1]:4000/ingest", true},
		{"HTTP://LocalHost:4000", "HTTP://LocalHost:4000", true},
		{"https://flightdeck.example.com", "https://flightdeck.example.com", false},
		{"https://example.com/fd/ingest", "https://example.com/fd/ingest", false},
		{"http://10.0.0.5:4000", "http://10.0.0.5:4000", false},
		// A name that only starts with localhost is resolved elsewhere.
		{"http://localhost.example.com:4000", "http://localhost.example.com:4000", false},
	}
	for _, c := range accepted {
		got, local, err := CheckServer(c.raw)
		if err != nil || got != c.want || local != c.local {
			t.Errorf("CheckServer(%q) = %q, %v, %v; want %q, %v", c.raw, got, local, err, c.want, c.local)
		}
	}

	refused := []struct{ raw, says string }{
		{"", "empty"},
		{"   ", "empty"},
		{"ftd_0123456789abcdef0123456789abcdef", "looks like an access token"},
		{"tok_dev", "looks like an access token"},
		{"https://user:s3cret-pass@example.com/ingest", "credentials"},
		{"https://s3cret-pass@example.com", "credentials"},
		{"flightdeck.example.com", "http:// or https://"},
		{"ftp://example.com", "http:// or https://"},
		{"https://good.example\\@evil.example", "backslashes"},
		{"https://exa mple.com", "no spaces"},
		{"https://", "no host"},
		{"http://:4000", "no host"},
	}
	for _, c := range refused {
		_, _, err := CheckServer(c.raw)
		if err == nil || !errors.Is(err, ErrUsage) || !strings.Contains(err.Error(), c.says) {
			t.Errorf("CheckServer(%q) = %v; want a usage error saying %q", c.raw, err, c.says)
			continue
		}
		// No message repeats a refused value: it may hold a secret.
		for _, secret := range []string{"s3cret-pass", "ftd_0123", "evil.example"} {
			if strings.Contains(c.raw, secret) && strings.Contains(err.Error(), secret) {
				t.Errorf("CheckServer(%q) repeats %q: %v", c.raw, secret, err)
			}
		}
	}
}

func TestCheckToken(t *testing.T) {
	for _, ok := range []string{"ftd_0123456789abcdef0123456789abcdef", "tok_dev"} {
		if err := CheckToken(ok); err != nil {
			t.Errorf("CheckToken(%q) = %v; want nil", ok, err)
		}
	}
	for _, bad := range []string{
		"ftd_0123456789ABCDEF0123456789ABCDEF", // minted tokens are lower-case
		"ftd_0123456789abcdef",                 // short
		"ftd_0123456789abcdef0123456789abcdefaa",
		"ftd_0123456789abcdef0123456789abcdeg",
		"https://flightdeck.example.com", // the server, in the wrong place
		"tok_devx",
	} {
		err := CheckToken(bad)
		if err == nil || !errors.Is(err, ErrUsage) {
			t.Errorf("CheckToken(%q) = %v; want a usage error", bad, err)
			continue
		}
		if strings.Contains(err.Error(), bad) {
			t.Errorf("CheckToken's message repeats the value it refused: %v", err)
		}
	}
}

func TestReadTokenFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	token := "ftd_0123456789abcdef0123456789abcdef"
	got, err := ReadTokenFile(write("token", "\n  "+token+"\r\n"))
	if err != nil || got != token {
		t.Fatalf("ReadTokenFile = %q, %v; want the token without its white space", got, err)
	}
	if _, err := ReadTokenFile(write("empty", " \n")); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Errorf("an empty file: %v; want an error saying it is empty", err)
	}
	big := write("big", strings.Repeat("a", maxTokenFileBytes+1))
	if _, err := ReadTokenFile(big); err == nil || !strings.Contains(err.Error(), "larger than a token file") {
		t.Errorf("a file over %d bytes: %v; want it refused", maxTokenFileBytes, err)
	}
	if _, err := ReadTokenFile(filepath.Join(dir, "missing")); err == nil || !errors.Is(err, ErrUsage) {
		t.Errorf("a missing file: %v; want a usage error", err)
	}
}

func TestRegistry(t *testing.T) {
	reg := Default()
	c, ok := reg.Lookup("claude-code")
	if !ok || c.Name() != "Claude Code" {
		t.Fatalf("Default().Lookup(claude-code) = %v, %v; want the Claude Code connector", c, ok)
	}
	if _, ok := reg.Lookup("Claude Code"); ok {
		t.Error("a connector is looked up by its id, not its display name")
	}
	if got := strings.Join(reg.IDs(), ","); got != "claude-code" {
		t.Errorf("IDs() = %q", got)
	}
	// Ids are what users type and installers parse: unique, lower-case,
	// no white space or tab.
	seen := map[string]bool{}
	for _, c := range reg {
		id := c.ID()
		if seen[id] || id != strings.ToLower(id) || strings.ContainsAny(id, " \t,") {
			t.Errorf("connector id %q must be unique, lower-case and free of spaces, tabs and commas", id)
		}
		seen[id] = true
	}
}
