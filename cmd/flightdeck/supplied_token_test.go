package main

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A dashboard token the operator supplies, against the real binary.
// The child listens on every interface, where the binary would mint a
// token of its own; the supplied one must be the dashboard's token, be
// stored once, and appear nowhere in the binary's output.

// The tokens of these tests have a minted token's form and are no
// instance's token.
const (
	suppliedTokenA = "ftd_7e9f1a3f9c1e5b2d4c6e8f0a1b3c5d7a"
	suppliedTokenB = "ftd_c5d7a7e9f1a3f9c1e5b2d4c6e8f0a1b3"
)

// suppliedTokenCount is how many of the instance's access tokens carry
// the supplied token's name.
func (c *child) suppliedTokenCount(t *testing.T, token string) int {
	t.Helper()
	var rows []struct {
		Name string `json:"name"`
	}
	if code := c.get(t, "/api/v1/access-tokens", token, &rows); code != http.StatusOK {
		t.Fatalf("GET /api/v1/access-tokens: %d", code)
	}
	n := 0
	for _, r := range rows {
		if r.Name == "Supplied dashboard token" {
			n++
		}
	}
	return n
}

func requireNoToken(t *testing.T, out string, tokens ...string) {
	t.Helper()
	for _, tok := range tokens {
		// Neither the token nor a recognisable part of it: its first
		// eight characters are the prefix the Settings page shows, so
		// the digits after them are what must never be printed.
		if strings.Contains(out, tok) || strings.Contains(out, tok[8:20]) {
			t.Fatalf("the binary's output carries the supplied token:\n%s", out)
		}
	}
}

func TestBinary_ASuppliedDashboardToken(t *testing.T) {
	skipWithoutSignals(t)
	dataDir := filepath.Join(tempDir(t), "data")
	tokenFile := filepath.Join(tempDir(t), "dashboard-token")
	// As a secret mount writes it: a trailing newline, readable by all.
	if err := os.WriteFile(tokenFile, []byte(suppliedTokenA+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	c := startWithEnv(t, []string{"FLIGHTDECK_DASHBOARD_TOKEN_FILE=" + tokenFile}, "0.0.0.0:"+port, port, dataDir)
	if got := c.dashboardToken(t); got != suppliedTokenA {
		t.Fatalf("/runtime-config.json does not serve the supplied token (it serves a %d-character one)", len(got))
	}
	if code := c.get(t, "/api/v1/sessions", suppliedTokenA, nil); code != http.StatusOK {
		t.Fatalf("the query API answered %d to the supplied token", code)
	}
	if code := c.get(t, "/api/v1/sessions", "tok_dev", nil); code != http.StatusUnauthorized {
		t.Fatalf("the query API answered %d to the development token on a listen beyond loopback, want 401", code)
	}
	if n := c.suppliedTokenCount(t, suppliedTokenA); n != 1 {
		t.Fatalf("%d access tokens named for the supplied one, want 1", n)
	}
	out := c.out.String()
	if !strings.Contains(out, `  Token       supplied by FLIGHTDECK_DASHBOARD_TOKEN_FILE   (named "Supplied dashboard token" in Settings)`) {
		t.Fatalf("the start-up block does not say where the token came from:\n%s", out)
	}
	requireNoToken(t, out, suppliedTokenA)
	// The data dir keeps no copy of it.
	secrets, err := os.ReadFile(filepath.Join(dataDir, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(secrets), "ftd_") || strings.Contains(string(secrets), "dashboard_token") {
		t.Fatal("secrets.json holds a dashboard token; a supplied one is not written there")
	}
	if err := c.stop(t, os.Interrupt); err != nil {
		t.Fatalf("stop: %v\n%s", err, c.out.String())
	}

	// A restart with the same token: still one row.
	c = startWithEnv(t, []string{"FLIGHTDECK_DASHBOARD_TOKEN_FILE=" + tokenFile}, "0.0.0.0:"+port, port, dataDir)
	if n := c.suppliedTokenCount(t, suppliedTokenA); n != 1 {
		t.Fatalf("%d access tokens named for the supplied one after a restart, want 1", n)
	}
	requireNoToken(t, c.out.String(), suppliedTokenA)
	if err := c.stop(t, os.Interrupt); err != nil {
		t.Fatalf("stop: %v\n%s", err, c.out.String())
	}

	// The operator changes the token, this time through the variable:
	// the new one is served, the old one still resolves.
	c = startWithEnv(t, []string{"FLIGHTDECK_DASHBOARD_TOKEN=" + suppliedTokenB}, "0.0.0.0:"+port, port, dataDir)
	if got := c.dashboardToken(t); got != suppliedTokenB {
		t.Fatalf("/runtime-config.json does not serve the new supplied token")
	}
	for _, tok := range []string{suppliedTokenA, suppliedTokenB} {
		if code := c.get(t, "/api/v1/sessions", tok, nil); code != http.StatusOK {
			t.Fatalf("after the token changed, the query API answered %d to one of the two supplied tokens", code)
		}
	}
	if n := c.suppliedTokenCount(t, suppliedTokenB); n != 2 {
		t.Fatalf("%d access tokens named for the supplied one after a change, want 2", n)
	}
	out = c.out.String()
	if !strings.Contains(out, "  Token       supplied by FLIGHTDECK_DASHBOARD_TOKEN   (") {
		t.Fatalf("the start-up block does not name the variable:\n%s", out)
	}
	requireNoToken(t, out, suppliedTokenA, suppliedTokenB)
}

// A value that is not a token stops the start before anything is
// bound or written, and the message never repeats it.
func TestBinary_AMalformedSuppliedTokenIsRefusedWithoutBeingEchoed(t *testing.T) {
	dataDir := filepath.Join(tempDir(t), "data")
	tokenFile := filepath.Join(tempDir(t), "dashboard-token")
	const notAToken = "correct-horse-battery-staple-0123456789"
	if err := os.WriteFile(tokenFile, []byte(notAToken), 0o600); err != nil {
		t.Fatal(err)
	}
	port := freePort(t)
	cases := []struct {
		name string
		env  string
		want string
	}{
		{"a file that holds something else", "FLIGHTDECK_DASHBOARD_TOKEN_FILE=" + tokenFile, "FLIGHTDECK_DASHBOARD_TOKEN_FILE (" + tokenFile + ")"},
		{"a missing file", "FLIGHTDECK_DASHBOARD_TOKEN_FILE=" + tokenFile + ".absent", "FLIGHTDECK_DASHBOARD_TOKEN_FILE"},
		{"a malformed variable", "FLIGHTDECK_DASHBOARD_TOKEN=" + notAToken, "FLIGHTDECK_DASHBOARD_TOKEN: "},
		{"a weak variable", "FLIGHTDECK_DASHBOARD_TOKEN=ftd_00000000000000000000000000000000", "not random"},
	}
	for _, c := range cases {
		cmd, out := command("--listen", "0.0.0.0:"+port, "--data-dir", dataDir)
		cmd.Env = append(cmd.Env, c.env)
		ctx, cancel := context.WithTimeout(context.Background(), refusalTimeout)
		done := make(chan error, 1)
		if err := cmd.Start(); err != nil {
			cancel()
			t.Fatal(err)
		}
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err == nil {
				t.Errorf("%s: the binary exited 0:\n%s", c.name, out.String())
			}
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			<-done
			t.Errorf("%s: the binary was still running after %s:\n%s", c.name, refusalTimeout, out.String())
		}
		cancel()
		got := out.String()
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: the message lacks %q:\n%s", c.name, c.want, got)
		}
		if strings.Contains(got, "horse-battery") || strings.Contains(got, "0000000000") {
			t.Errorf("%s: the message repeats the refused value:\n%s", c.name, got)
		}
		if _, err := os.Stat(dataDir); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s: the data dir was created before the token was refused (stat: %v)", c.name, err)
		}
	}
}

// On loopback the development token is used; a supplied token is
// ignored, and the log says so without printing it.
func TestBinary_ASuppliedTokenIsIgnoredOnLoopback(t *testing.T) {
	port := freePort(t)
	c := startWithEnv(t, []string{"FLIGHTDECK_DASHBOARD_TOKEN=" + suppliedTokenA}, "127.0.0.1:"+port, port, filepath.Join(tempDir(t), "data"))
	if got := c.dashboardToken(t); got != "tok_dev" {
		t.Fatalf("/runtime-config.json serves a %d-character token on loopback, want the development token", len(got))
	}
	if code := c.get(t, "/api/v1/sessions", suppliedTokenA, nil); code != http.StatusUnauthorized {
		t.Fatalf("the query API answered %d to the ignored supplied token, want 401", code)
	}
	out := c.out.String()
	if !strings.Contains(out, "the supplied dashboard token is ignored") {
		t.Fatalf("the log does not say the supplied token is ignored:\n%s", out)
	}
	requireNoToken(t, out, suppliedTokenA)
	// The block is the loopback one.
	if !strings.Contains(out, "  Token       tok_dev   (development token") {
		t.Fatalf("the start-up block is not the loopback one:\n%s", out)
	}
}
