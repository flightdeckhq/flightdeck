package connect

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// mainResult is one run of the command.
type mainResult struct {
	code           int
	stdout, stderr string
}

// runMain runs `flightdeck connect args...` against the stand-in claude
// (newFakeClaude must have run), with env as its variables, answer on
// stdin and interactive as whether a person is at the terminal.
func runMain(t *testing.T, env map[string]string, answer string, interactive bool, args ...string) mainResult {
	t.Helper()
	return runMainWith(t, newConnector(), env, answer, interactive, args...)
}

// runMainWith is runMain with c as the one connector.
func runMainWith(t *testing.T, c Connector, env map[string]string, answer string, interactive bool, args ...string) mainResult {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Main(context.Background(), args, IO{
		Registry:    Registry{c},
		Getenv:      func(k string) string { return env[k] },
		Stdin:       strings.NewReader(answer),
		Stdout:      &stdout,
		Stderr:      &stderr,
		Interactive: interactive,
	})
	return mainResult{code, stdout.String(), stderr.String()}
}

func TestMain_List(t *testing.T) {
	f := newFakeClaude(t)
	r := runMain(t, nil, "", false)
	if r.code != ExitOK || !strings.Contains(r.stdout, "Claude Code (claude-code)") ||
		!strings.Contains(strings.ToLower(r.stdout), strings.ToLower("2.1.325 (Claude Code) at "+f.exe)) ||
		!strings.Contains(r.stdout, "connect it with: flightdeck connect claude-code") {
		t.Fatalf("listing, not connected: %+v", r)
	}
	if got := f.changes(t); len(got) != 0 {
		t.Fatalf("the listing ran %q", got)
	}

	f.set(t, "marketplace", "installed", "server=https://flightdeck.example.com", "token="+testToken)
	r = runMain(t, nil, "", false)
	if r.code != ExitOK || !strings.Contains(r.stdout, "connected      plugin 0.9.0, reporting to https://flightdeck.example.com, a token saved") {
		t.Fatalf("listing, connected: %+v", r)
	}
	if strings.Contains(r.stdout, testToken) {
		t.Fatal("the listing printed the token")
	}

	f.set(t, "disabled")
	if r = runMain(t, nil, "", false); !strings.Contains(r.stdout, "turned off") {
		t.Fatalf("listing, disabled: %+v", r)
	}
}

func TestMain_ListWithoutClaude(t *testing.T) {
	var stdout bytes.Buffer
	code := Main(context.Background(), nil, IO{
		Registry: Registry{NewClaudeCode(func(string) (string, error) { return "", exec.ErrNotFound }, Exec)},
		Stdout:   &stdout, Stderr: &stdout,
	})
	if code != ExitOK || !strings.Contains(stdout.String(), "not found      no claude command on PATH; install Claude Code") {
		t.Fatalf("exit %d:\n%s", code, stdout.String())
	}
}

func TestMain_Detected(t *testing.T) {
	f := newFakeClaude(t)
	if r := runMain(t, nil, "", false, "--detected"); r.code != ExitOK || r.stdout != "claude-code\tnot-connected\tClaude Code\n" {
		t.Fatalf("--detected, not connected: %+v", r)
	}
	f.set(t, "marketplace", "installed")
	if r := runMain(t, nil, "", false, "--detected"); r.code != ExitOK || r.stdout != "claude-code\tconnected\tClaude Code\n" {
		t.Fatalf("--detected, connected: %+v", r)
	}
	// A status that cannot be read counts as not connected: the connect
	// that follows reports why.
	t.Setenv("FAKE_CLAUDE_FAIL", "list")
	if r := runMain(t, nil, "", false, "--detected"); r.code != ExitOK || r.stdout != "claude-code\tnot-connected\tClaude Code\n" {
		t.Fatalf("--detected, unreadable status: %+v", r)
	}
	// An agent not on this machine has no line, and that is not an error.
	var stdout bytes.Buffer
	code := Main(context.Background(), []string{"--detected"}, IO{
		Registry: Registry{NewClaudeCode(func(string) (string, error) { return "", exec.ErrNotFound }, Exec)},
		Stdout:   &stdout, Stderr: &stdout,
	})
	if code != ExitOK || stdout.Len() != 0 {
		t.Fatalf("--detected without claude: exit %d, %q", code, stdout.String())
	}
}

func TestMain_Connect(t *testing.T) {
	f := newFakeClaude(t)
	r := runMain(t, nil, "", false, "claude-code")
	if r.code != ExitOK || !strings.Contains(r.stdout, "Installed the flightdeck plugin") || !f.has("installed") {
		t.Fatalf("connect: %+v", r)
	}
	r = runMain(t, nil, "", false, "claude-code")
	if r.code != ExitOK || !strings.Contains(r.stdout, "already connected") {
		t.Fatalf("connect again: %+v", r)
	}
}

func TestMain_ServerAndToken(t *testing.T) {
	f := newFakeClaude(t)
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte(testToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Flags after the agent's id, as people type them.
	r := runMain(t, nil, "", false, "claude-code", "--server", "https://flightdeck.example.com", "--token-file", tokenFile)
	if r.code != ExitOK || f.read(t, "token") != testToken || f.read(t, "server") != "https://flightdeck.example.com" {
		t.Fatalf("--server with --token-file: %+v", r)
	}
	if strings.Contains(r.stdout+r.stderr, testToken) {
		t.Fatal("the command printed the token")
	}

	t.Run("FLIGHTDECK_TOKEN", func(t *testing.T) {
		other := "ftd_fedcba9876543210fedcba9876543210"
		r := runMain(t, map[string]string{"FLIGHTDECK_TOKEN": other}, "", false, "--server", "https://other.example.com", "claude-code")
		if r.code != ExitOK || f.read(t, "token") != other {
			t.Fatalf("token from FLIGHTDECK_TOKEN: %+v", r)
		}
	})
	t.Run("the development token is refused for a server elsewhere", func(t *testing.T) {
		r := runMain(t, map[string]string{"FLIGHTDECK_TOKEN": DevToken}, "", false, "claude-code", "--server", "https://third.example.com")
		if r.code != ExitUsage || !strings.Contains(r.stderr, "only a server on this machine accepts") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("a malformed token is refused and not repeated", func(t *testing.T) {
		r := runMain(t, map[string]string{"FLIGHTDECK_TOKEN": "not-a-token-value"}, "", false, "claude-code", "--server", "https://third.example.com")
		if r.code != ExitUsage || !strings.Contains(r.stderr, "FLIGHTDECK_TOKEN: the token must be") || strings.Contains(r.stderr, "not-a-token-value") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("a server elsewhere with no token", func(t *testing.T) {
		r := runMain(t, nil, "", false, "claude-code", "--server", "https://third.example.com")
		if r.code != ExitUsage || !strings.Contains(r.stderr, "needs an access token") {
			t.Fatalf("%+v", r)
		}
	})
}

func TestMain_Remove(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace", "installed")
	// Without a terminal, --remove needs --yes.
	r := runMain(t, nil, "", false, "claude-code", "--remove")
	if r.code != ExitUsage || !f.has("installed") || !strings.Contains(r.stderr, "--remove needs --yes; nothing changed") {
		t.Fatalf("--remove without a terminal and without --yes: %+v", r)
	}
	r = runMain(t, nil, "", false, "claude-code", "--remove", "--yes")
	if r.code != ExitOK || f.has("installed") || !strings.Contains(r.stdout, "Uninstalled") {
		t.Fatalf("--remove --yes: %+v", r)
	}
	// Nothing to remove needs no --yes.
	r = runMain(t, nil, "", false, "claude-code", "--remove")
	if r.code != ExitOK || !strings.Contains(r.stdout, "nothing changed") {
		t.Fatalf("--remove again: %+v", r)
	}
}

func TestMain_DryRun(t *testing.T) {
	f := newFakeClaude(t)
	r := runMain(t, nil, "", false, "claude-code", "--dry-run")
	if r.code != ExitOK || !strings.Contains(r.stdout, "Connect Claude Code to Flightdeck:\n  - add the flightdeck-plugins marketplace") ||
		!strings.Contains(r.stdout, "install the flightdeck plugin for your user from github.com/flightdeckhq/flightdeck") ||
		!strings.Contains(r.stdout, "The plugin records your Claude Code sessions, including prompts, responses, tool results and sanitised tool inputs") {
		t.Fatalf("--dry-run: %+v", r)
	}
	if got := f.changes(t); len(got) != 0 {
		t.Fatalf("--dry-run ran %q", got)
	}
	f.set(t, "marketplace", "installed")
	if r = runMain(t, nil, "", false, "claude-code", "--remove", "--dry-run"); r.code != ExitOK || !strings.Contains(r.stdout, "uninstall the flightdeck plugin") || !f.has("installed") {
		t.Fatalf("--remove --dry-run: %+v", r)
	}
}

func TestMain_AMarketplaceFromElsewhereNeedsAPerson(t *testing.T) {
	foreign := `"source":"directory","path":"/src/my-flightdeck"`
	t.Run("without a terminal", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace="+foreign)
		r := runMain(t, nil, "", false, "claude-code")
		if r.code != ExitNeedsConfirmation || f.has("installed") || !strings.Contains(r.stderr, "comes from the local directory /src/my-flightdeck") ||
			!strings.Contains(r.stderr, "claude plugin install flightdeck@flightdeck-plugins --scope user") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("--yes on a terminal", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace="+foreign)
		if r := runMain(t, nil, "y\n", true, "claude-code", "--yes"); r.code != ExitNeedsConfirmation || f.has("installed") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("an empty answer is no", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace="+foreign)
		r := runMain(t, nil, "\n", true, "claude-code")
		if r.code != ExitFailed || f.has("installed") || !strings.Contains(r.stdout, "Caution: ") || !strings.Contains(r.stdout, "Continue? [y/N] ") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("--dry-run reports it with exit status 4, the installers' signal", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace="+foreign)
		r := runMain(t, nil, "", false, "claude-code", "--dry-run")
		if r.code != ExitNeedsConfirmation || !strings.Contains(r.stdout, "Caution: ") || f.has("installed") {
			t.Fatalf("%+v", r)
		}
		// This repository's marketplace: exit status 0.
		f.set(t, "marketplace=")
		if r := runMain(t, nil, "", false, "claude-code", "--dry-run"); r.code != ExitOK {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("yes on a terminal installs", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace="+foreign)
		if r := runMain(t, nil, "yes\n", true, "claude-code"); r.code != ExitOK || !f.has("installed") {
			t.Fatalf("%+v", r)
		}
	})
}

func TestMain_Warnings(t *testing.T) {
	f := newFakeClaude(t)
	dir := t.TempDir()
	open := filepath.Join(dir, "token")
	if err := os.WriteFile(open, []byte(testToken), 0o644); err != nil {
		t.Fatal(err)
	}
	r := runMain(t, nil, "", false, "claude-code", "--server", "http://10.0.0.5:4000", "--token-file", open)
	if r.code != ExitOK || f.read(t, "token") != testToken {
		t.Fatalf("%+v", r)
	}
	if !strings.Contains(r.stderr, "warning: http://10.0.0.5:4000 is plain http:// and not this machine") {
		t.Errorf("no warning for plain http:// to another machine: %q", r.stderr)
	}
	// Windows keeps no Unix permission bits: there is no such warning.
	if runtime.GOOS != "windows" && !strings.Contains(r.stderr, "can be read by other users (mode 0644); chmod 600 it") {
		t.Errorf("no warning for a token file others can read: %q", r.stderr)
	}
	// Neither for a loopback server, nor for a file only its owner reads.
	private := filepath.Join(dir, "private")
	if err := os.WriteFile(private, []byte(testToken), 0o600); err != nil {
		t.Fatal(err)
	}
	r = runMain(t, nil, "", false, "claude-code", "--server", "http://127.0.0.1:4100", "--token-file", private)
	if r.code != ExitOK || strings.Contains(r.stderr, "warning") {
		t.Fatalf("%+v", r)
	}
}

func TestMain_ATokenFileWrittenByPowerShell(t *testing.T) {
	f := newFakeClaude(t)
	data := []byte{0xFF, 0xFE}
	for _, r := range testToken + "\r\n" {
		data = append(data, byte(r), 0)
	}
	path := filepath.Join(t.TempDir(), "token.txt")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if r := runMain(t, nil, "", false, "claude-code", "--server", "https://fd.example.com", "--token-file", path); r.code != ExitOK || f.read(t, "token") != testToken {
		t.Fatalf("a UTF-16 token file: %+v, saved %q", r, f.read(t, "token"))
	}
}

func TestMain_Asks(t *testing.T) {
	t.Run("an empty answer connects", func(t *testing.T) {
		f := newFakeClaude(t)
		r := runMain(t, nil, "\n", true, "claude-code")
		if r.code != ExitOK || !strings.Contains(r.stdout, "Connect Claude Code to Flightdeck:\n  - add the flightdeck-plugins marketplace") ||
			!strings.Contains(r.stdout, "Continue? [Y/n] ") || !f.has("installed") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("no changes nothing", func(t *testing.T) {
		f := newFakeClaude(t)
		r := runMain(t, nil, "n\n", true, "claude-code")
		if r.code != ExitFailed || !strings.Contains(r.stdout, "Nothing changed.") || len(f.changes(t)) != 0 {
			t.Fatalf("%+v, changes %q", r, f.changes(t))
		}
	})
	t.Run("end of input is no", func(t *testing.T) {
		f := newFakeClaude(t)
		if r := runMain(t, nil, "", true, "claude-code"); r.code != ExitFailed || len(f.changes(t)) != 0 {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("--yes does not ask", func(t *testing.T) {
		f := newFakeClaude(t)
		r := runMain(t, nil, "", true, "claude-code", "--yes")
		if r.code != ExitOK || strings.Contains(r.stdout, "Continue?") || !f.has("installed") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("remove defaults to no", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed")
		r := runMain(t, nil, "\n", true, "claude-code", "--remove")
		if r.code != ExitFailed || !strings.Contains(r.stdout, "Continue? [y/N] ") || !f.has("installed") {
			t.Fatalf("%+v", r)
		}
		if r = runMain(t, nil, "y\n", true, "claude-code", "-y", "--remove"); r.code != ExitOK || f.has("installed") {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("nothing to change asks nothing", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed")
		if r := runMain(t, nil, "", true, "claude-code"); r.code != ExitOK || strings.Contains(r.stdout, "Continue?") {
			t.Fatalf("%+v", r)
		}
	})
}

func TestMain_ExitStatuses(t *testing.T) {
	newFakeClaude(t)
	cases := []struct {
		name string
		args []string
		code int
		says string
	}{
		{"an unknown agent", []string{"codex"}, ExitUsage, `no agent named "codex"; the agents are claude-code`},
		{"two agents", []string{"claude-code", "codex"}, ExitUsage, "one agent at a time"},
		{"an unknown flag", []string{"claude-code", "--token", "x"}, ExitUsage, "flag provided but not defined: -token"},
		{"--token-file without --server", []string{"claude-code", "--token-file", "/dev/null"}, ExitUsage, "--token-file goes with --server"},
		{"--remove with --server", []string{"claude-code", "--remove", "--server", "https://x.example.com"}, ExitUsage, "--remove takes no --server"},
		{"--detected with an agent", []string{"--detected", "claude-code"}, ExitUsage, "--detected takes no agent"},
		{"a flag and no agent", []string{"--server", "https://x.example.com"}, ExitUsage, "name the agent"},
		{"a refused server", []string{"claude-code", "--server", "flightdeck.example.com"}, ExitUsage, "http:// or https://"},
		{"help", []string{"--help"}, ExitOK, "Exit status: 0 connected"},
		{"help names exit status 5", []string{"--help"}, ExitOK, "5 the agent is too old for this command"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := runMain(t, nil, "", false, c.args...)
			if r.code != c.code || !strings.Contains(r.stderr, c.says) {
				t.Fatalf("exit %d, stderr %q; want %d and %q", r.code, r.stderr, c.code, c.says)
			}
		})
	}

	t.Run("the agent is not on this machine", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main(context.Background(), []string{"claude-code"}, IO{
			Registry: Registry{NewClaudeCode(func(string) (string, error) { return "", exec.ErrNotFound }, Exec)},
			Stdout:   &stdout, Stderr: &stderr,
		})
		if code != ExitNotFound || !strings.Contains(stderr.String(), "Claude Code is not on this machine (no claude command on PATH)") {
			t.Fatalf("exit %d, %q", code, stderr.String())
		}
	})
	t.Run("a step that fails", func(t *testing.T) {
		t.Setenv("FAKE_CLAUDE_FAIL", "marketplace-add")
		r := runMain(t, nil, "", false, "claude-code")
		if r.code != ExitFailed || strings.Count(r.stderr, "\n") != 1 || !strings.Contains(r.stderr, "flightdeck connect claude-code: `claude plugin marketplace add") {
			t.Fatalf("%+v; want exit 1 and one line naming the step", r)
		}
	})
}

// The installers branch on exit statuses by number (install.sh's
// CONNECT_NEEDS_CONFIRMATION and CONNECT_OUTDATED, install.ps1's
// $needsConfirmation and $outdated), and on --detected's states by name:
// the values are a contract with them.
func TestExitStatusesTheInstallersRead(t *testing.T) {
	if ExitOK != 0 || ExitNeedsConfirmation != 4 || ExitOutdated != 5 {
		t.Fatalf("ExitOK = %d, ExitNeedsConfirmation = %d, ExitOutdated = %d; the installers read 0, 4 and 5", ExitOK, ExitNeedsConfirmation, ExitOutdated)
	}
	if stateConnected != "connected" || stateNotConnected != "not-connected" || stateOutdated != "outdated" {
		t.Fatalf("the states are %q, %q and %q; the installers read connected, not-connected and outdated", stateConnected, stateNotConnected, stateOutdated)
	}
}

func TestMain_AnOutdatedClaudeCode(t *testing.T) {
	t.Run("the listing", func(t *testing.T) {
		f := newOldFakeClaude(t)
		r := runMain(t, nil, "", false)
		if r.code != ExitOK || !strings.Contains(strings.ToLower(r.stdout), strings.ToLower("found          2.1.283 (Claude Code) at "+f.exe)) ||
			!strings.Contains(r.stdout, "too old        this version has no `claude plugin configure` and no --json on `claude plugin marketplace add`") ||
			!strings.Contains(r.stdout, "update it with `claude update`, then run flightdeck connect claude-code again") ||
			!strings.Contains(r.stdout, "/plugin marketplace add flightdeckhq/flightdeck, then /plugin install flightdeck@flightdeck-plugins") ||
			strings.Contains(r.stdout, "connect it with:") {
			t.Fatalf("listing: %+v", r)
		}
		// The check and the plugin list, nothing else: nothing changed.
		if got := f.calls(t); !sameCalls(got, outdatedCalls) {
			t.Fatalf("the listing ran %q; want only %q", got, outdatedCalls)
		}
	})
	t.Run("--detected", func(t *testing.T) {
		f := newOldFakeClaude(t)
		if r := runMain(t, nil, "", false, "--detected"); r.code != ExitOK || r.stdout != "claude-code\toutdated\tClaude Code\n" {
			t.Fatalf("--detected: %+v", r)
		}
		if got := f.calls(t); !sameCalls(got, outdatedCalls) {
			t.Fatalf("--detected ran %q; want only %q", got, outdatedCalls)
		}
		// Installed from inside Claude Code but turned off: still outdated.
		f.set(t, "marketplace", "installed", "disabled")
		if r := runMain(t, nil, "", false, "--detected"); r.code != ExitOK || r.stdout != "claude-code\toutdated\tClaude Code\n" {
			t.Fatalf("--detected, installed and turned off: %+v", r)
		}
	})
	// The plugin installed and turned on from inside Claude Code (the
	// /plugin commands the advice names): connected, with nothing to do,
	// although this version cannot show the server it reports to.
	t.Run("connected from inside Claude Code", func(t *testing.T) {
		f := newOldFakeClaude(t)
		f.set(t, "marketplace", "installed")
		if r := runMain(t, nil, "", false, "--detected"); r.code != ExitOK || r.stdout != "claude-code\tconnected\tClaude Code\n" {
			t.Fatalf("--detected: %+v", r)
		}
		r := runMain(t, nil, "", false)
		if r.code != ExitOK ||
			!strings.Contains(r.stdout, "connected      plugin 0.9.0; this version of Claude Code cannot show the server it reports to: update Claude Code to see or change it") ||
			strings.Contains(r.stdout, "too old") || strings.Contains(r.stdout, "/plugin install") {
			t.Fatalf("listing: %+v", r)
		}
		if got := f.changes(t); len(got) != 0 {
			t.Fatalf("ran %q", got)
		}
		// Connecting it still needs the commands it lacks.
		if r := runMain(t, nil, "", false, "claude-code"); r.code != ExitOutdated || len(f.changes(t)) != 0 {
			t.Fatalf("connect: %+v", r)
		}
	})
	for _, args := range [][]string{
		{"claude-code"},
		{"claude-code", "--dry-run"},
		{"claude-code", "--yes"},
		{"claude-code", "--server", "https://fd.example.com", "--dry-run"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			f := newOldFakeClaude(t)
			r := runMain(t, map[string]string{"FLIGHTDECK_TOKEN": testToken}, "y\n", true, args...)
			if r.code != ExitOutdated || r.stdout != "" || strings.Count(r.stderr, "\n") != 1 ||
				!strings.HasPrefix(r.stderr, "flightdeck connect claude-code: Claude Code 2.1.283 is too old for flightdeck connect") ||
				!strings.Contains(r.stderr, "so nothing changed: update it with `claude update`, then run flightdeck connect claude-code again") ||
				strings.Contains(r.stderr, "unknown option") || strings.Contains(r.stderr, testToken) {
				t.Fatalf("exit %d, stdout %q, stderr %q; want exit 5 and one line saying what to do", r.code, r.stdout, r.stderr)
			}
			if got := f.calls(t); !sameCalls(got, outdatedCalls) {
				t.Fatalf("ran %q; want only %q", got, outdatedCalls)
			}
		})
	}
	t.Run("--remove", func(t *testing.T) {
		f := newOldFakeClaude(t)
		f.set(t, "marketplace", "installed")
		if r := runMain(t, nil, "", false, "claude-code", "--remove", "--dry-run"); r.code != ExitOK || !strings.Contains(r.stdout, "uninstall the flightdeck plugin") {
			t.Fatalf("--remove --dry-run: %+v", r)
		}
		if r := runMain(t, nil, "", false, "claude-code", "--remove", "--yes"); r.code != ExitOK || !strings.Contains(r.stdout, "Uninstalled the flightdeck plugin") || f.has("installed") {
			t.Fatalf("--remove --yes: %+v", r)
		}
		if r := runMain(t, nil, "", false, "claude-code", "--remove"); r.code != ExitOK || !strings.Contains(r.stdout, "nothing changed") {
			t.Fatalf("--remove again: %+v", r)
		}
	})
	t.Run("a step refused as unknown", func(t *testing.T) {
		f := newOldFakeClaude(t)
		r := runMainWith(t, NewClaudeCode(exec.LookPath, answering(currentHelps)), nil, "", false, "claude-code")
		if r.code != ExitOutdated || strings.Count(r.stderr, "\n") != 1 ||
			!strings.Contains(r.stderr, "flightdeck connect claude-code: `claude plugin marketplace add flightdeckhq/flightdeck --json` failed: error: unknown option '--json', so Claude Code 2.1.283 is too old") ||
			!strings.Contains(r.stderr, "claude update") || f.has("installed") {
			t.Fatalf("%+v; want exit 5 and one line naming the version and what to do", r)
		}
	})
}

// A status the listing cannot read is printed without the sentinel's
// text, as report prints an error.
func TestMain_TheListingPrintsAStatusErrorAsReportDoes(t *testing.T) {
	newFakeClaude(t)
	c := NewClaudeCode(exec.LookPath, answering(map[string]answer{"plugin list --json": {stderr: "error: unknown option '--json'\n", fail: true}}))
	r := runMainWith(t, c, nil, "", false)
	if r.code != ExitOK || !strings.Contains(r.stdout, "status unknown `claude plugin list --json` failed: error: unknown option '--json', so Claude Code 2.1.325 is too old") ||
		strings.Contains(r.stdout, ErrOutdated.Error()) {
		t.Fatalf("listing: %+v", r)
	}
}
