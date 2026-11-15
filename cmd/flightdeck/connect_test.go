package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/connect/fakeclaude"
)

// `flightdeck connect` through the real binary's command line, against
// scripts/fake-claude.sh as `claude` on PATH: the dispatch to the
// subcommand, its exit statuses and its output as the installers and a
// person see them. internal/connect tests the connector itself.

// connectCommandTimeout bounds one run of the connect command. Against
// the stand-in every step takes milliseconds; a run that takes this
// long has hung.
const connectCommandTimeout = 60 * time.Second

// connectEnv puts the stand-in claude first on PATH with a fresh state
// directory and returns the environment entries and that directory: on
// Unix scripts/fake-claude.sh, on Windows, where that script cannot run,
// the Go stand-in (internal/connect/fakeclaude).
func connectEnv(t *testing.T) ([]string, string) {
	t.Helper()
	bin, state := t.TempDir(), t.TempDir()
	if runtime.GOOS == "windows" {
		// The Go stand-in: this test binary as claude.exe, which TestMain
		// runs as internal/connect/fakeclaude, since the script cannot run.
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(self)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, fakeclaude.Name+".exe"), data, 0o755); err != nil {
			t.Fatal(err)
		}
	} else {
		script, err := os.ReadFile(filepath.Join("..", "..", "scripts", "fake-claude.sh"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, "claude"), script, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return []string{"PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH"), "FAKE_CLAUDE_STATE=" + state}, state
}

// runConnect runs `flightdeck connect args...` with env added to a
// scrubbed environment and returns its exit status and output.
func runConnect(t *testing.T, env []string, args ...string) (int, string) {
	t.Helper()
	cmd, out := command(append([]string{"connect"}, args...)...)
	cmd.Env = append(cmd.Env, env...)
	ctx, cancel := context.WithTimeout(context.Background(), connectCommandTimeout)
	defer cancel()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var exit *exec.ExitError
		switch {
		case err == nil:
			return 0, out.String()
		case errors.As(err, &exit):
			return exit.ExitCode(), out.String()
		}
		t.Fatalf("flightdeck connect %v: %v\n%s", args, err, out.String())
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-done
		t.Fatalf("flightdeck connect %v did not exit within %s:\n%s", args, connectCommandTimeout, out.String())
	}
	return -1, ""
}

func TestBinary_ConnectCommand(t *testing.T) {
	env, state := connectEnv(t)

	code, out := runConnect(t, env, "--detected")
	if code != 0 || out != "claude-code\tnot-connected\tClaude Code\n" {
		t.Fatalf("--detected: exit %d, %q", code, out)
	}
	// Not a terminal: no question, the connect goes ahead.
	code, out = runConnect(t, env, "claude-code")
	if code != 0 || strings.Contains(out, "Continue?") || !strings.Contains(out, "Claude Code is connected") {
		t.Fatalf("connect: exit %d:\n%s", code, out)
	}
	calls, err := os.ReadFile(filepath.Join(state, "calls.log"))
	if err != nil || !strings.Contains(string(calls), "argv: plugin install flightdeck@flightdeck-plugins --scope user --json") {
		t.Fatalf("the stand-in was not asked to install the plugin (%v):\n%s", err, calls)
	}
	code, out = runConnect(t, env, "claude-code")
	if code != 0 || !strings.Contains(out, "already connected") {
		t.Fatalf("connect again: exit %d:\n%s", code, out)
	}
	code, out = runConnect(t, env)
	if code != 0 || !strings.Contains(out, "connected      plugin 0.9.0, reporting to the local server at http://localhost:4000") {
		t.Fatalf("the listing: exit %d:\n%s", code, out)
	}

	// The token comes from the environment, which command() scrubs of
	// every FLIGHTDECK_ variable first, and never shows in the output.
	token := "ftd_0123456789abcdef0123456789abcdef"
	code, out = runConnect(t, append(env, "FLIGHTDECK_TOKEN="+token), "claude-code", "--server", "https://flightdeck.example.com")
	if code != 0 || strings.Contains(out, token) {
		t.Fatalf("--server with FLIGHTDECK_TOKEN: exit %d:\n%s", code, out)
	}
	if saved, _ := os.ReadFile(filepath.Join(state, "token")); string(saved) != token {
		t.Fatalf("the stand-in saved the token %q", saved)
	}

	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{"claude-code", "--remove"}, 2}, // no terminal: --remove needs --yes
		{[]string{"claude-code", "--remove", "--yes"}, 0},
		{[]string{"no-such-agent"}, 2},
		{[]string{"claude-code", "--server", "https://other.example.com"}, 2},
	} {
		if code, out := runConnect(t, env, c.args...); code != c.code {
			t.Errorf("flightdeck connect %v: exit %d, want %d:\n%s", c.args, code, c.code, out)
		}
	}

	// No claude on PATH: exit 3, one line.
	code, out = runConnect(t, []string{"PATH=" + t.TempDir()}, "claude-code")
	if code != 3 || strings.Count(out, "\n") != 1 || !strings.Contains(out, "Claude Code is not on this machine") {
		t.Fatalf("without claude: exit %d, %q", code, out)
	}

	// A subtest, so the Windows job's -run pattern runs it as well.
	t.Run("an outdated Claude Code", func(t *testing.T) {
		env, state := connectEnv(t)
		env = append(env, "FAKE_CLAUDE_OLD_CLI=1")
		code, out := runConnect(t, env, "--detected")
		if code != 0 || out != "claude-code\toutdated\tClaude Code\n" {
			t.Fatalf("--detected: exit %d, %q", code, out)
		}
		code, out = runConnect(t, env)
		if code != 0 || !strings.Contains(out, "2.1.283 (Claude Code) at ") || !strings.Contains(out, "too old        this version has no `claude plugin configure`") ||
			!strings.Contains(out, "claude update") {
			t.Fatalf("the listing: exit %d:\n%s", code, out)
		}
		for _, args := range [][]string{{"claude-code"}, {"claude-code", "--dry-run"}, {"claude-code", "--yes"}} {
			code, out := runConnect(t, env, args...)
			if code != 5 || strings.Count(out, "\n") != 1 || strings.Contains(out, "unknown option") ||
				!strings.Contains(out, "flightdeck connect claude-code: Claude Code 2.1.283 is too old for flightdeck connect") ||
				!strings.Contains(out, "update it with `claude update`, then run flightdeck connect claude-code again") {
				t.Fatalf("flightdeck connect %v: exit %d, %q; want 5 and one line saying what to do", args, code, out)
			}
		}
		// Every call was the version, a help or the plugin list: nothing
		// changed.
		calls, err := os.ReadFile(filepath.Join(state, "calls.log"))
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(calls)), "\n") {
			if line != "argv: --version" && line != "argv: plugin list --json" && !strings.HasSuffix(line, " --help") {
				t.Fatalf("an outdated Claude Code was asked %q", line)
			}
		}
	})
}

func TestBinary_HelpNamesConnect(t *testing.T) {
	cmd, out := command("--help")
	if err := cmd.Run(); err != nil {
		t.Fatalf("flightdeck --help: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "flightdeck connect [<agent>] [flags]") {
		t.Fatalf("flightdeck --help does not name the connect command:\n%s", out.String())
	}
	cmd, out = command("connect", "--help")
	if err := cmd.Run(); err != nil || !strings.Contains(out.String(), "-token-file") || !strings.Contains(out.String(), "claude-code (Claude Code)") {
		t.Fatalf("flightdeck connect --help: %v\n%s", err, out.String())
	}
}
