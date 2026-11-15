package connect

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
)

// The Claude Code connector against scripts/fake-claude.sh, a stand-in
// `claude` with the output shapes of Claude Code 2.1.325, put on PATH as
// `claude`. The stand-in records every argv and every stdin it read.

const testToken = "ftd_0123456789abcdef0123456789abcdef"

// testStepTimeout replaces every step's timeout in the tests that make
// the stand-in hang, so a hang is seen in seconds, not minutes.
const testStepTimeout = 2 * time.Second

// fakeClaude is one stand-in `claude` and its state directory.
type fakeClaude struct {
	bin, state string
}

// newFakeClaude puts the stand-in on PATH and returns it with no state:
// no marketplace declared, no plugin installed.
func newFakeClaude(t *testing.T) *fakeClaude {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in claude is a POSIX shell script")
	}
	src, err := filepath.Abs(filepath.Join("..", "..", "scripts", "fake-claude.sh"))
	if err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeClaude{bin: t.TempDir(), state: t.TempDir()}
	if err := os.WriteFile(filepath.Join(f.bin, "claude"), script, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", f.bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_CLAUDE_STATE", f.state)
	for _, v := range []string{"FAKE_CLAUDE_FAIL", "FAKE_CLAUDE_HANG", "FAKE_CLAUDE_HANG_CHILD", "FAKE_CLAUDE_HANG_SECS", "FAKE_CLAUDE_VERSION"} {
		t.Setenv(v, "")
	}
	return f
}

// set creates state files: "marketplace", "installed", "disabled", or
// "server=<value>" and "token=<value>".
func (f *fakeClaude) set(t *testing.T, entries ...string) {
	t.Helper()
	for _, e := range entries {
		name, value, _ := strings.Cut(e, "=")
		if err := os.WriteFile(filepath.Join(f.state, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *fakeClaude) has(name string) bool {
	_, err := os.Stat(filepath.Join(f.state, name))
	return err == nil
}

func (f *fakeClaude) read(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.state, name))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return string(data)
}

// calls returns the argv lines the stand-in logged, without "argv: ".
func (f *fakeClaude) calls(t *testing.T) []string {
	t.Helper()
	var argv []string
	for _, line := range strings.Split(f.read(t, "calls.log"), "\n") {
		if a, ok := strings.CutPrefix(line, "argv: "); ok {
			argv = append(argv, a)
		}
	}
	return argv
}

// changes returns the logged calls that change something.
func (f *fakeClaude) changes(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, a := range f.calls(t) {
		if a == "--version" || strings.HasSuffix(a, "list --json") || a == "plugin configure "+pluginID+" --json" {
			continue
		}
		out = append(out, a)
	}
	return out
}

func (f *fakeClaude) resetLog(t *testing.T) {
	t.Helper()
	if err := os.Remove(filepath.Join(f.state, "calls.log")); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func newConnector() *ClaudeCode { return NewClaudeCode(exec.LookPath, Exec) }

// shortTimeouts runs every step with testStepTimeout in place of its own.
func shortTimeouts(ctx context.Context, _ time.Duration, stdin []byte, path string, args ...string) ([]byte, []byte, error) {
	return Exec(ctx, testStepTimeout, stdin, path, args...)
}

func applyConnect(t *testing.T, c Connector, target Target) ([]string, error) {
	t.Helper()
	plan, err := c.PlanConnect(context.Background(), target)
	if err != nil {
		return nil, err
	}
	var lines []string
	err = plan.Apply(context.Background(), func(l string) { lines = append(lines, l) })
	return lines, err
}

func TestClaudeCode_Detect(t *testing.T) {
	f := newFakeClaude(t)
	c := newConnector()
	det, err := c.Detect(context.Background())
	if err != nil || !det.Found || det.Version != "2.1.325 (Claude Code)" || det.Path != filepath.Join(f.bin, "claude") {
		t.Fatalf("Detect = %+v, %v; want the stand-in and its version", det, err)
	}

	t.Run("not on PATH", func(t *testing.T) {
		c := NewClaudeCode(func(string) (string, error) { return "", exec.ErrNotFound }, Exec)
		det, err := c.Detect(context.Background())
		if err != nil || det.Found || !strings.Contains(det.Missing, "no claude command on PATH") {
			t.Fatalf("Detect = %+v, %v; want not found, no error", det, err)
		}
		if _, err := c.PlanConnect(context.Background(), Target{}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("PlanConnect without claude: %v; want ErrNotFound", err)
		}
		if _, err := c.PlanDisconnect(context.Background()); !errors.Is(err, ErrNotFound) {
			t.Fatalf("PlanDisconnect without claude: %v; want ErrNotFound", err)
		}
	})
	t.Run("a claude that fails", func(t *testing.T) {
		t.Setenv("FAKE_CLAUDE_FAIL", "version")
		det, err := c.Detect(context.Background())
		if err == nil || !det.Found || !strings.Contains(err.Error(), "simulated version failure") {
			t.Fatalf("Detect = %+v, %v; want found, with the CLI's own reason", det, err)
		}
	})
}

func TestClaudeCode_ConnectFromNothing(t *testing.T) {
	f := newFakeClaude(t)
	c := newConnector()
	plan, err := c.PlanConnect(context.Background(), Target{})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Steps) != 2 || !strings.Contains(plan.Steps[0].Summary, "marketplace") || !strings.Contains(plan.Steps[1].Summary, "install") {
		t.Fatalf("plan = %+v; want the marketplace, then the install", plan.Steps)
	}
	// Planning reads only.
	if got := f.changes(t); len(got) != 0 {
		t.Fatalf("planning ran %q; it must change nothing", got)
	}
	var lines []string
	if err := plan.Apply(context.Background(), func(l string) { lines = append(lines, l) }); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"plugin marketplace add flightdeckhq/flightdeck --json",
		"plugin install flightdeck@flightdeck-plugins --scope user --json",
	}
	if got := f.changes(t); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("changes = %q; want %q", got, want)
	}
	// No server, no token: the plugin's own defaults, nothing saved.
	if f.has("server") || f.has("token") {
		t.Fatal("a connect without --server saved an option")
	}
	if last := lines[len(lines)-1]; !strings.Contains(last, "the local server at http://localhost:4000") {
		t.Errorf("the closing line %q does not name the local server", last)
	}
	st, err := c.Status(context.Background())
	if err != nil || !st.Connected() || st.Version != "0.9.0" || st.Server != "" || st.TokenSaved {
		t.Fatalf("Status after connecting = %+v, %v", st, err)
	}

	t.Run("connecting again changes nothing", func(t *testing.T) {
		f.resetLog(t)
		lines, err := applyConnect(t, c, Target{})
		if err != nil {
			t.Fatal(err)
		}
		if got := f.changes(t); len(got) != 0 {
			t.Fatalf("a second connect ran %q", got)
		}
		if len(lines) != 1 || !strings.Contains(lines[0], "already connected") || !strings.Contains(lines[0], "nothing changed") {
			t.Fatalf("a second connect said %q", lines)
		}
	})
}

func TestClaudeCode_ConnectUsesADeclaredMarketplace(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace")
	if _, err := applyConnect(t, newConnector(), Target{}); err != nil {
		t.Fatal(err)
	}
	if got := f.changes(t); len(got) != 1 || !strings.HasPrefix(got[0], "plugin install ") {
		t.Fatalf("changes = %q; want the install alone", got)
	}
}

func TestClaudeCode_ConnectTurnsADisabledPluginOn(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace", "installed", "disabled")
	st, err := newConnector().Status(context.Background())
	if err != nil || !st.Installed || st.Connected() {
		t.Fatalf("Status of a disabled plugin = %+v, %v; want installed, not connected", st, err)
	}
	if _, err := applyConnect(t, newConnector(), Target{}); err != nil {
		t.Fatal(err)
	}
	if got := f.changes(t); len(got) != 1 || got[0] != "plugin enable "+pluginID {
		t.Fatalf("changes = %q; want the enable alone", got)
	}
	if f.has("disabled") {
		t.Fatal("the plugin is still disabled")
	}
}

func TestClaudeCode_ConnectToARemoteServer(t *testing.T) {
	f := newFakeClaude(t)
	c := newConnector()
	server := "https://flightdeck.example.com"
	if _, err := applyConnect(t, c, Target{Server: server, Token: testToken}); err != nil {
		t.Fatal(err)
	}
	// The token went on stdin, never on a command line.
	for _, argv := range f.calls(t) {
		if strings.Contains(argv, testToken) || strings.Contains(argv, "ftd_") {
			t.Fatalf("the token is on a command line: %q", argv)
		}
	}
	if log := f.read(t, "calls.log"); !strings.Contains(log, `stdin: {"server":"`+server+`","token":"`+testToken+`"}`) {
		t.Fatalf("the values were not given on stdin:\n%s", log)
	}
	if f.read(t, "server") != server || f.read(t, "token") != testToken {
		t.Fatal("the stand-in did not save the server and the token")
	}
	st, err := c.Status(context.Background())
	if err != nil || st.Server != server || !st.TokenSaved {
		t.Fatalf("Status = %+v, %v; want the server and a token saved", st, err)
	}

	t.Run("the same server and no token keeps the saved token", func(t *testing.T) {
		f.resetLog(t)
		lines, err := applyConnect(t, c, Target{Server: server})
		if err != nil {
			t.Fatal(err)
		}
		if got := f.changes(t); len(got) != 0 || !strings.Contains(lines[0], "already connected") {
			t.Fatalf("changes = %q, lines %q; want nothing changed", got, lines)
		}
	})
	t.Run("another server needs its token", func(t *testing.T) {
		f.resetLog(t)
		_, err := applyConnect(t, c, Target{Server: "https://other.example.com"})
		if !errors.Is(err, ErrUsage) || !strings.Contains(err.Error(), "needs an access token") {
			t.Fatalf("connect to another server without a token: %v; want a usage error", err)
		}
		if got := f.changes(t); len(got) != 0 {
			t.Fatalf("a refused connect ran %q", got)
		}
		if f.read(t, "server") != server {
			t.Fatal("the saved server changed")
		}
	})
	t.Run("a loopback server replaces another server's token with the development token", func(t *testing.T) {
		if _, err := applyConnect(t, c, Target{Server: "http://localhost:4100", Local: true}); err != nil {
			t.Fatal(err)
		}
		if f.read(t, "server") != "http://localhost:4100" || f.read(t, "token") != DevToken {
			t.Fatalf("server %q, token %q; want the local server and %s", f.read(t, "server"), f.read(t, "token"), DevToken)
		}
	})
}

func TestClaudeCode_ARemoteServerWithoutAToken(t *testing.T) {
	f := newFakeClaude(t)
	_, err := applyConnect(t, newConnector(), Target{Server: "https://flightdeck.example.com"})
	if !errors.Is(err, ErrUsage) {
		t.Fatalf("err = %v; want a usage error", err)
	}
	// Refused before anything changed: no marketplace, no install.
	if got := f.changes(t); len(got) != 0 || f.has("installed") {
		t.Fatalf("a refused connect ran %q", got)
	}
}

func TestClaudeCode_Disconnect(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace", "installed", "server=https://flightdeck.example.com", "token="+testToken)
	c := newConnector()
	plan, err := c.PlanDisconnect(context.Background())
	if err != nil || len(plan.Steps) != 1 {
		t.Fatalf("PlanDisconnect = %+v, %v; want one step", plan, err)
	}
	if err := plan.Apply(context.Background(), func(string) {}); err != nil {
		t.Fatal(err)
	}
	if got := f.changes(t); len(got) != 1 || got[0] != "plugin uninstall "+pluginID+" --scope user --json" {
		t.Fatalf("changes = %q; want the uninstall alone", got)
	}
	if f.has("installed") || f.has("token") || !f.has("marketplace") {
		t.Fatal("the plugin and its token must go and the marketplace stay")
	}

	t.Run("again: nothing to do", func(t *testing.T) {
		f.resetLog(t)
		plan, err := c.PlanDisconnect(context.Background())
		if err != nil || len(plan.Steps) != 0 || !strings.Contains(plan.Unchanged, "nothing changed") {
			t.Fatalf("PlanDisconnect = %+v, %v; want no step", plan, err)
		}
		if got := f.changes(t); len(got) != 0 {
			t.Fatalf("ran %q", got)
		}
	})
}

func TestClaudeCode_AFailedStep(t *testing.T) {
	f := newFakeClaude(t)
	t.Setenv("FAKE_CLAUDE_FAIL", "install")
	_, err := applyConnect(t, newConnector(), Target{})
	if err == nil {
		t.Fatal("a failed install connected")
	}
	msg := err.Error()
	if !strings.Contains(msg, "`claude plugin install flightdeck@flightdeck-plugins --scope user --json` failed: simulated install failure") || strings.Contains(msg, "\n") {
		t.Fatalf("err = %q; want one line naming the step and the CLI's reason", msg)
	}
	// The marketplace step before it ran; nothing after it did.
	if got := f.changes(t); len(got) != 2 || !f.has("marketplace") || f.has("installed") {
		t.Fatalf("changes = %q", got)
	}
}

func TestClaudeCode_AFailedSaveNeverShowsTheToken(t *testing.T) {
	f := newFakeClaude(t)
	f.set(t, "marketplace", "installed")
	t.Setenv("FAKE_CLAUDE_FAIL", "configure")
	_, err := applyConnect(t, newConnector(), Target{Server: "https://flightdeck.example.com", Token: testToken})
	if err == nil || strings.Contains(err.Error(), testToken) || !strings.Contains(err.Error(), "simulated configure failure") {
		t.Fatalf("err = %v; want the CLI's reason and never the token", err)
	}
}

func TestClaudeCode_AStepThatHangsIsStopped(t *testing.T) {
	for _, mode := range []string{"FAKE_CLAUDE_HANG", "FAKE_CLAUDE_HANG_CHILD"} {
		t.Run(mode, func(t *testing.T) {
			f := newFakeClaude(t)
			t.Setenv(mode, "marketplace-add")
			// Longer than the step's timeout and its wait for the
			// child; short enough that nothing lingers for long.
			t.Setenv("FAKE_CLAUDE_HANG_SECS", "30")
			c := NewClaudeCode(exec.LookPath, shortTimeouts)
			start := time.Now()
			_, err := applyConnect(t, c, Target{})
			elapsed := time.Since(start)
			if err == nil || !strings.Contains(err.Error(), "did not finish within") || !strings.Contains(err.Error(), "marketplace add") {
				t.Fatalf("err = %v; want the step named as stopped at its timeout", err)
			}
			// The bound: the timeout, the wait for a child holding the
			// output, and slack for a loaded machine.
			if limit := testStepTimeout + processWaitDelay + 5*time.Second; elapsed > limit {
				t.Fatalf("the hung step took %s; the bound is %s", elapsed, limit)
			}
			if f.has("installed") {
				t.Fatal("the steps after the hung one ran")
			}
		})
	}
}

func TestClaudeCode_UnreadableOutput(t *testing.T) {
	newFakeClaude(t)
	// A claude that answers the list with something other than JSON.
	c := NewClaudeCode(exec.LookPath, func(ctx context.Context, timeout time.Duration, stdin []byte, path string, args ...string) ([]byte, []byte, error) {
		if len(args) > 1 && args[1] == "list" {
			return []byte("Installed plugins:\n  none\n"), nil, nil
		}
		return Exec(ctx, timeout, stdin, path, args...)
	})
	if _, err := c.Status(context.Background()); err == nil || !strings.Contains(err.Error(), "printed no plugin list") {
		t.Fatalf("Status = %v; want an error saying the list could not be read", err)
	}
}

func TestResultLine(t *testing.T) {
	out := "Cloning via HTTPS\nsome progress\n{\"outcome\":\"failed\",\"message\":\"first\\nthe reason\"}\n"
	r, ok := resultLine([]byte(out))
	if !ok || r.Outcome != "failed" || lastLine(r.Message) != "the reason" {
		t.Fatalf("resultLine = %+v, %v", r, ok)
	}
	if _, ok := resultLine([]byte("no json here\n")); ok {
		t.Fatal("found a result line in plain text")
	}
}
