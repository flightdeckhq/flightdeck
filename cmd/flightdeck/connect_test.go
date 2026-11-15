package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/connect"
	"github.com/flightdeckhq/flightdeck/internal/connect/fakeclaude"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
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
	// A data dir of the test's own: connect looks there for the running
	// server, and the developer's own must not change what a test sees.
	return []string{
		"PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH"), "FAKE_CLAUDE_STATE=" + state,
		"FLIGHTDECK_DATA_DIR=" + filepath.Join(t.TempDir(), "connect-data"),
	}, state
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

// setClaudeState gives the stand-in claude state files, as its header
// documents them: "marketplace", "installed", "server=<value>".
func setClaudeState(t *testing.T, state string, entries ...string) {
	t.Helper()
	for _, e := range entries {
		name, value, _ := strings.Cut(e, "=")
		if err := os.WriteFile(filepath.Join(state, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// The maintainer's sequence: Claude Code connected to one port, the
// server started on another. The server logs the one line that says so,
// records its address in the data dir, and `flightdeck connect
// claude-code` with no flag plans the server's port; the address is
// gone once the server stops.
func TestBinary_TheServerAndConnectFindEachOtherOnAnotherPort(t *testing.T) {
	skipWithoutSignals(t)
	env, state := connectEnv(t)
	elsewhere := "http://localhost:" + freePort(t)
	setClaudeState(t, state, "marketplace", "installed", "server="+elsewhere)
	port := freePort(t)
	here := "http://localhost:" + port
	dataDir := filepath.Join(tempDir(t), "data")
	c := startArgs(t, append(env, agentCheckEnv+"=1"), port, "--port", port, "--data-dir", dataDir)

	line := "Claude Code reports to " + elsewhere + ", not to this server at " + here +
		": its sessions are not recorded here. To report here, run: flightdeck connect claude-code --port " + port
	waitFor(t, "the line that Claude Code reports elsewhere", logTimeout, func() bool { return strings.Contains(c.out.String(), line) })
	if n := strings.Count(c.out.String(), "reports to "); n != 1 {
		t.Fatalf("%d lines about where Claude Code reports, want 1:\n%s", n, c.out.String())
	}
	if !strings.Contains(c.out.String(), " WARN "+line) {
		t.Errorf("the line is not a warning:\n%s", c.out.String())
	}
	inst, err := datadir.ReadInstance(dataDir)
	if err != nil || inst.Listen != "127.0.0.1:"+port || inst.PID != c.cmd.Process.Pid {
		t.Fatalf("the instance file holds %+v (%v), want 127.0.0.1:%s and pid %d", inst, err, port, c.cmd.Process.Pid)
	}

	// connect with no flag: nothing answers at the saved port, so the plan
	// points the plugin at the server running here.
	withDir := append(env, "FLIGHTDECK_DATA_DIR="+dataDir)
	code, out := runConnect(t, withDir, "claude-code", "--dry-run")
	if code != 0 || !strings.Contains(out, "  - save the server "+here+" in the plugin's options") ||
		!strings.Contains(out, "Claude Code reports to "+elsewhere+", where no Flightdeck answers; "+here+" is the Flightdeck running on this machine") {
		t.Fatalf("--dry-run: exit %d:\n%s", code, out)
	}
	if code, out = runConnect(t, withDir, "claude-code", "--yes"); code != 0 || !strings.Contains(out, "Claude Code is connected: sessions started from now on report to "+here) {
		t.Fatalf("connect --yes: exit %d:\n%s", code, out)
	}
	if saved, _ := os.ReadFile(filepath.Join(state, "server")); string(saved) != here {
		t.Fatalf("the stand-in saved the server %q, want %s", saved, here)
	}
	if code, out = runConnect(t, withDir); code != 0 || strings.Contains(out, "no answer") || !strings.Contains(out, "reporting to "+here) {
		t.Fatalf("the listing: exit %d:\n%s", code, out)
	}

	if err := c.stop(t, os.Interrupt); err != nil {
		t.Fatalf("the stop: %v\n%s", err, c.out.String())
	}
	if _, err := datadir.ReadInstance(dataDir); !errors.Is(err, datadir.ErrNoInstance) {
		t.Fatalf("the instance file after a clean stop: %v, want none", err)
	}

	// Not connected yet: connect plans the server that runs, here on a
	// port of its own.
	env2, state2 := connectEnv(t)
	port2 := freePort(t)
	dataDir2 := filepath.Join(tempDir(t), "data")
	startArgs(t, env2, port2, "--port", port2, "--data-dir", dataDir2)
	code, out = runConnect(t, append(env2, "FLIGHTDECK_DATA_DIR="+dataDir2), "claude-code", "--dry-run")
	if code != 0 || !strings.Contains(out, "  - save the server http://localhost:"+port2+" in the plugin's options") ||
		strings.Contains(out, "No Flightdeck answers") {
		t.Fatalf("--dry-run, not connected: exit %d:\n%s", code, out)
	}
	if _, err := os.Stat(filepath.Join(state2, "installed")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("--dry-run installed the plugin: %v", err)
	}
}

// A --public instance serves other machines: it runs no agent's command
// and records no address for connect to follow.
func TestBinary_APublicInstanceAsksNoAgentAndIsNotOffered(t *testing.T) {
	skipWithoutSignals(t)
	env, state := connectEnv(t)
	setClaudeState(t, state, "marketplace", "installed", "server=http://localhost:"+freePort(t))
	port := freePort(t)
	dataDir := filepath.Join(tempDir(t), "data")
	// A file a killed loopback instance left on this data dir: removed.
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := datadir.WriteInstance(dataDir, datadir.Instance{Listen: "127.0.0.1:" + port, PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	c := startArgs(t, append(env, agentCheckEnv+"=1"), port, "--public", "--port", port, "--data-dir", dataDir)
	if _, err := datadir.ReadInstance(dataDir); !errors.Is(err, datadir.ErrNoInstance) {
		t.Fatalf("a --public instance's data dir names an instance: %v", err)
	}
	code, out := runConnect(t, append(env, "FLIGHTDECK_DATA_DIR="+dataDir), "claude-code", "--dry-run")
	if code != 0 || strings.Contains(out, "http://localhost:"+port) {
		t.Fatalf("--dry-run beside a --public instance: exit %d:\n%s", code, out)
	}
	if err := c.stop(t, os.Interrupt); err != nil {
		t.Fatalf("the stop: %v\n%s", err, c.out.String())
	}
	if strings.Contains(c.out.String(), "reports to") {
		t.Fatalf("a --public instance logged where Claude Code reports:\n%s", c.out.String())
	}
	// The dry run reads the plugin's status and never runs `claude
	// --version`; the check of the agents starts with it.
	calls, _ := os.ReadFile(filepath.Join(state, "calls.log"))
	if n := strings.Count(string(calls), "argv: --version"); n != 0 {
		t.Fatalf("`claude --version` ran %d times: a --public instance runs no agent's command\n%s", n, calls)
	}
}

// agentStub is a connector whose answers the test sets; with block set,
// Detect waits until its context ends, as a hung agent CLI would.
type agentStub struct {
	server string
	block  bool
}

func (a *agentStub) ID() string   { return "stub-agent" }
func (a *agentStub) Name() string { return "Stub Agent" }
func (a *agentStub) Detect(ctx context.Context) (connect.Detection, error) {
	if a.block {
		<-ctx.Done()
		return connect.Detection{Found: true}, ctx.Err()
	}
	return connect.Detection{Found: true, Path: "/bin/stub", Version: "1"}, nil
}
func (a *agentStub) Status(context.Context) (connect.Status, error) {
	return connect.Status{Installed: true, Enabled: true, Server: a.server}, nil
}
func (a *agentStub) PlanConnect(context.Context, connect.Target) (connect.Plan, error) {
	return connect.Plan{}, nil
}
func (a *agentStub) PlanDisconnect(context.Context) (connect.Plan, error) { return connect.Plan{}, nil }

func TestStartAgentCheck_LogsOneWarningExactlyWhenTheAgentReportsElsewhere(t *testing.T) {
	for _, c := range []struct {
		server, listen string
		want           int
	}{
		{"", "127.0.0.1:4100", 1},
		{"http://localhost:4100", "127.0.0.1:4100", 0},
		{"https://flightdeck.example.com", "127.0.0.1:4100", 0},
	} {
		var logged lockedBuffer
		logger := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))
		startAgentCheck(context.Background(), connect.Registry{&agentStub{server: c.server}}, c.listen, logger)()
		if n := strings.Count(logged.String(), "level=WARN"); n != c.want || (c.want == 1 && !strings.Contains(logged.String(), "flightdeck connect stub-agent --port 4100")) {
			t.Errorf("server %q, listen %s: %d warnings, want %d:\n%s", c.server, c.listen, n, c.want, logged.String())
		}
	}
}

func TestStartAgentCheck_NeverBlocksTheStartAndEndsWhenCancelled(t *testing.T) {
	var logged lockedBuffer
	logger := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctx, cancel := context.WithCancel(context.Background())
	returned := make(chan func(), 1)
	go func() {
		returned <- startAgentCheck(ctx, connect.Registry{&agentStub{block: true}}, "127.0.0.1:4100", logger)
	}()
	var wait func()
	select {
	case wait = <-returned:
	case <-time.After(logTimeout):
		cancel()
		t.Fatal("startAgentCheck waited for the agent's command")
	}
	ended := make(chan struct{})
	go func() {
		wait()
		close(ended)
	}()
	select {
	case <-ended:
		t.Fatal("the check ended while the agent's command still ran")
	default:
	}
	cancel()
	select {
	case <-ended:
	case <-time.After(logTimeout):
		t.Fatal("the check did not end when cancelled")
	}
	// A cancelled check logs nothing: the stop is under way.
	if logged.String() != "" {
		t.Fatalf("a cancelled check logged:\n%s", logged.String())
	}
}

func TestAgentEnvironment_DropsEveryFlightdeckVariable(t *testing.T) {
	got := agentEnvironment([]string{
		"PATH=/bin", "CLAUDE_CONFIG_DIR=/c", "FLIGHTDECK_JWT_SECRET=s", "FLIGHTDECK_POSTGRES_URL=postgres://u:p@h/d",
		"FLIGHTDECK_DATABASE_URL=postgres://u:p@h/d", "FLIGHTDECK_DASHBOARD_TOKEN=t", "FLIGHTDECK_TOKEN=t", "flightdeck_token_file=/f",
		"ENVIRONMENT=prod", "NOT_FLIGHTDECK_X=kept",
	})
	want := []string{"PATH=/bin", "CLAUDE_CONFIG_DIR=/c", "ENVIRONMENT=prod", "NOT_FLIGHTDECK_X=kept"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("agentEnvironment = %q, want %q", got, want)
	}
}

// recordingClaude replaces the stand-in on env's PATH with a wrapper that
// writes its arguments ("argv: ...", the first line) and the environment
// it was started with to env.<pid> in the stand-in's state directory,
// then runs the stand-in.
func recordingClaude(t *testing.T, env []string) {
	t.Helper()
	bin, _, _ := strings.Cut(strings.TrimPrefix(env[0], "PATH="), string(os.PathListSeparator))
	standIn := filepath.Join(bin, "claude-stand-in")
	if err := os.Rename(filepath.Join(bin, "claude"), standIn); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\n{ echo \"argv: $*\"; env; } > \"$FAKE_CLAUDE_STATE/env.$$\"\nexec '" + standIn + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
}

// recordedEnvironments returns every environment the wrapper recorded.
func recordedEnvironments(t *testing.T, state string) []string {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(state, "env.*"))
	if err != nil {
		t.Fatal(err)
	}
	var envs []string
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		envs = append(envs, string(data))
	}
	return envs
}

// The server's secrets stay in the server: the claude the start-up check
// runs gets the environment the binary was started with, without any
// FLIGHTDECK_ variable, so neither the JWT secret and the database URL
// the binary sets for its services nor a supplied token reaches it.
// `flightdeck connect`, a process of its own, never holds the server's.
func TestBinary_TheAgentsCommandsGetNoneOfTheServersSecrets(t *testing.T) {
	skipWithoutSignals(t)
	env, state := connectEnv(t)
	recordingClaude(t, env)
	setClaudeState(t, state, "marketplace", "installed", "server=http://localhost:"+freePort(t))
	port := freePort(t)
	secrets := []string{
		"FLIGHTDECK_DASHBOARD_TOKEN=ftd_9f3a1c7e5b2d4086a1c3e5f7092b4d6e",
		"FLIGHTDECK_TOKEN=ftd_0123456789abcdef0123456789abcdef",
	}
	c := startArgs(t, append(append(env, agentCheckEnv+"=1"), secrets...), port, "--port", port, "--data-dir", filepath.Join(tempDir(t), "data"))
	waitFor(t, "the line that Claude Code reports elsewhere", logTimeout, func() bool { return strings.Contains(c.out.String(), "reports to ") })
	if err := c.stop(t, os.Interrupt); err != nil {
		t.Fatalf("the stop: %v\n%s", err, c.out.String())
	}
	envs := recordedEnvironments(t, state)
	// Every command the check runs, the two help commands it runs side by
	// side included, got the environment checked below.
	ran := map[string]bool{}
	for _, e := range envs {
		argv, _, _ := strings.Cut(e, "\n")
		ran[strings.TrimPrefix(argv, "argv: ")] = true
	}
	for _, want := range []string{"--version", "plugin configure --help", "plugin marketplace add --help", "plugin list --json",
		"plugin configure flightdeck@flightdeck-plugins --json"} {
		if !ran[want] {
			t.Errorf("the check's `claude %s` was not recorded; recorded %v", want, ran)
		}
	}
	for _, e := range envs {
		if !strings.Contains(e, "FAKE_CLAUDE_STATE=") {
			t.Fatalf("the recorded environment is not the binary's:\n%s", e)
		}
		for _, line := range strings.Split(e, "\n") {
			if strings.HasPrefix(strings.ToUpper(line), "FLIGHTDECK_") || line == "ENVIRONMENT=dev" {
				t.Errorf("the check's claude got %s", strings.SplitN(line, "=", 2)[0])
			}
		}
	}

	// connect: the user's own variables, none of the server's.
	for _, p := range mustGlob(t, filepath.Join(state, "env.*")) {
		_ = os.Remove(p)
	}
	if code, out := runConnect(t, env, "claude-code", "--dry-run"); code != 0 {
		t.Fatalf("connect --dry-run: exit %d:\n%s", code, out)
	}
	for _, e := range recordedEnvironments(t, state) {
		for _, name := range []string{"FLIGHTDECK_JWT_SECRET=", "FLIGHTDECK_POSTGRES_URL=", "FLIGHTDECK_DASHBOARD_TOKEN=", "ENVIRONMENT=dev"} {
			if strings.Contains(e, name) {
				t.Errorf("connect's claude got %s", strings.TrimSuffix(name, "="))
			}
		}
	}
}

func mustGlob(t *testing.T, pattern string) []string {
	t.Helper()
	paths, err := filepath.Glob(pattern)
	if err != nil {
		t.Fatal(err)
	}
	return paths
}
