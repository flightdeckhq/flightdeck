package connect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
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
	// bin is the directory on PATH, exe the stand-in's path in it.
	bin, exe, state string
}

// newFakeClaude puts the stand-in on PATH and returns it with no state:
// no marketplace declared, no plugin installed. On Unix it is
// scripts/fake-claude.sh, the stand-in the installer tests and the
// install gate use too; on Windows, where that script cannot run, it is
// this test binary copied as claude.exe (fakeclaude), so the connector
// finds it through PATHEXT, gives it values on stdin and kills its
// process tree there for real. The tests hold both to the same assertions.
func newFakeClaude(t *testing.T) *fakeClaude {
	t.Helper()
	f := &fakeClaude{state: t.TempDir()}
	if runtime.GOOS == "windows" {
		f.exe = goFakeClaude(t)
		f.bin = filepath.Dir(f.exe)
	} else {
		src, err := filepath.Abs(filepath.Join("..", "..", "scripts", "fake-claude.sh"))
		if err != nil {
			t.Fatal(err)
		}
		script, err := os.ReadFile(src)
		if err != nil {
			t.Fatal(err)
		}
		f.bin = t.TempDir()
		f.exe = filepath.Join(f.bin, "claude")
		if err := os.WriteFile(f.exe, script, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", f.bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_CLAUDE_STATE", f.state)
	for _, v := range []string{"FAKE_CLAUDE_FAIL", "FAKE_CLAUDE_HANG", "FAKE_CLAUDE_HANG_CHILD", "FAKE_CLAUDE_HANG_SECS", "FAKE_CLAUDE_VERSION", "FAKE_CLAUDE_OLD_CLI"} {
		t.Setenv(v, "")
	}
	return f
}

// newOldFakeClaude is newFakeClaude answering as Claude Code 2.1.283:
// no `plugin configure`, no --json on `plugin marketplace add`.
func newOldFakeClaude(t *testing.T) *fakeClaude {
	t.Helper()
	f := newFakeClaude(t)
	t.Setenv("FAKE_CLAUDE_OLD_CLI", "1")
	return f
}

// The commands Detect runs: the version and the check, all read-only.
var checkCalls = []string{"--version", "plugin configure --help", "plugin marketplace add --help"}

// The commands a connect refused on an outdated Claude Code runs, and the
// listing and --detected of one without the plugin: the check, the plugin
// list, and the version for the message. All read-only.
var outdatedCalls = append(slices.Clone(checkCalls), "plugin list --json")

// sameCalls reports whether got holds the calls of want in any order:
// the check runs its commands side by side.
func sameCalls(got, want []string) bool {
	return slices.Equal(slices.Sorted(slices.Values(got)), slices.Sorted(slices.Values(want)))
}

// planThenTimeApply plans a connect, then applies it and returns how
// long the steps took, apart from the planning: the bound a hung step is
// held to is the step's, and planning starts the CLI several times
// (about a second each for a race-built stand-in on a Windows runner).
func planThenTimeApply(t *testing.T, c Connector, target Target) (time.Duration, error) {
	t.Helper()
	plan, err := c.PlanConnect(context.Background(), target)
	if err != nil {
		t.Fatalf("PlanConnect: %v", err)
	}
	start := time.Now()
	err = plan.Apply(context.Background(), func(string) {})
	return time.Since(start), err
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
		if a == "--version" || strings.HasSuffix(a, " --help") || strings.HasSuffix(a, "list --json") || a == "plugin configure "+pluginID+" --json" {
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
	if err != nil || !det.Found || det.Version != "2.1.325 (Claude Code)" || !strings.EqualFold(det.Path, f.exe) || det.Outdated != "" {
		t.Fatalf("Detect = %+v, %v; want the stand-in and its version, not outdated", det, err)
	}
	// The version and the check, nothing else.
	if got := f.calls(t); !sameCalls(got, checkCalls) {
		t.Fatalf("Detect ran %q; want %q", got, checkCalls)
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
	// A failure the CLI reports is not a CLI that is too old.
	if errors.Is(err, ErrOutdated) || strings.Contains(msg, "claude update") {
		t.Fatalf("err = %q; a failed step is not an outdated Claude Code", msg)
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
			elapsed, err := planThenTimeApply(t, c, Target{})
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

func TestClaudeCode_AMarketplaceFromElsewhere(t *testing.T) {
	trusted := []string{
		``, // the stand-in's default: github + flightdeckhq/flightdeck
		`"source":"github","repo":"FlightdeckHQ/Flightdeck"`,
		`"source":"git","url":"https://github.com/flightdeckhq/flightdeck.git"`,
		`"source":"git","url":"git@github.com:flightdeckhq/flightdeck.git"`,
	}
	for _, src := range trusted {
		f := newFakeClaude(t)
		f.set(t, "marketplace="+src)
		plan, err := newConnector().PlanConnect(context.Background(), Target{})
		if err != nil || plan.Caution != "" || !strings.Contains(plan.Steps[0].Summary, "from github.com/flightdeckhq/flightdeck") {
			t.Errorf("marketplace %s: plan %+v, %v; want this repository trusted", src, plan, err)
		}
	}
	foreign := map[string]string{
		`"source":"directory","path":"/src/my-flightdeck"`:          "the local directory /src/my-flightdeck",
		`"source":"github","repo":"someone/flightdeck"`:             "the GitHub repository someone/flightdeck",
		`"source":"git","url":"https://example.com/flightdeck.git"`: "the git repository https://example.com/flightdeck.git",
		`"source":"url","url":"https://example.com/m.json"`:         "a url https://example.com/m.json source",
	}
	for src, says := range foreign {
		f := newFakeClaude(t)
		f.set(t, "marketplace="+src)
		plan, err := newConnector().PlanConnect(context.Background(), Target{})
		if err != nil || len(plan.Steps) != 1 || !strings.Contains(plan.Steps[0].Summary, says) || !strings.Contains(plan.Caution, says) ||
			!strings.Contains(plan.Caution, "claude plugin install flightdeck@flightdeck-plugins --scope user") {
			t.Errorf("marketplace %s: plan %+v, %v; want the install step and a caution naming %q and the manual command", src, plan, err, says)
		}
	}
}

func TestClaudeCode_TheSameServerSpelledAnotherWay(t *testing.T) {
	t.Run("a loopback server with a trailing slash keeps the saved token", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "server=http://localhost:4000", "token="+testToken)
		lines, err := applyConnect(t, newConnector(), Target{Server: "http://localhost:4000/", Local: true})
		if err != nil || len(f.changes(t)) != 0 || f.read(t, "token") != testToken || !strings.Contains(lines[0], "already connected") {
			t.Fatalf("lines %q, err %v, changes %q, token %q; want nothing changed", lines, err, f.changes(t), f.read(t, "token"))
		}
	})
	t.Run("the default server named explicitly is the default", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "token="+testToken)
		if _, err := applyConnect(t, newConnector(), Target{Server: "http://localhost:4000/ingest", Local: true}); err != nil || len(f.changes(t)) != 0 {
			t.Fatalf("err %v, changes %q; want nothing changed", err, f.changes(t))
		}
	})
	t.Run("the ingestion URL of the saved remote server keeps its token", func(t *testing.T) {
		f := newFakeClaude(t)
		f.set(t, "marketplace", "installed", "server=https://fd.example.com", "token="+testToken)
		if _, err := applyConnect(t, newConnector(), Target{Server: "HTTPS://FD.example.com:443/ingest/"}); err != nil || len(f.changes(t)) != 0 {
			t.Fatalf("err %v, changes %q; want nothing changed and no token needed", err, f.changes(t))
		}
	})
}

func TestClaudeCode_TheNoticeAndTheUnchangedLine(t *testing.T) {
	f := newFakeClaude(t)
	plan, err := newConnector().PlanConnect(context.Background(), Target{Server: "https://fd.example.com", Token: testToken})
	if err != nil || !strings.Contains(plan.Notice, "prompts, responses, tool results and sanitised tool inputs") ||
		!strings.Contains(plan.Notice, "https://fd.example.com") {
		t.Fatalf("notice %q, %v; want what the plugin records and where", plan.Notice, err)
	}
	f.set(t, "marketplace", "installed")
	plan, err = newConnector().PlanConnect(context.Background(), Target{})
	if err != nil || !strings.Contains(plan.Unchanged, "nothing changed. Pass --server to change the server.") {
		t.Fatalf("unchanged %q, %v", plan.Unchanged, err)
	}
}

func TestClaudeCode_ASavedServerIsPrintedWithoutControlCharacters(t *testing.T) {
	f := newFakeClaude(t)
	// As Claude Code prints it: JSON with the control characters escaped.
	f.set(t, "marketplace", "installed", `server=https://fd.example.com\u0007\u001b[2J`)
	plan, err := newConnector().PlanConnect(context.Background(), Target{})
	if err != nil || strings.ContainsAny(plan.Unchanged, "\a\x1b") || !strings.Contains(plan.Unchanged, "https://fd.example.com[2J") {
		t.Fatalf("unchanged %q, %v; want the control characters dropped", plan.Unchanged, err)
	}
}

// answer is what a command answers in place of the stand-in.
type answer struct {
	stdout, stderr string
	// fail makes the command exit non-zero.
	fail bool
}

// answering returns a runner that answers the commands in answers (keyed
// by their arguments joined with spaces) itself and runs every other one
// on the stand-in: a CLI the stand-in has no mode for.
func answering(answers map[string]answer) RunFunc {
	return func(ctx context.Context, timeout time.Duration, stdin []byte, path string, args ...string) ([]byte, []byte, error) {
		if a, ok := answers[strings.Join(args, " ")]; ok {
			var err error
			if a.fail {
				err = errors.New("exit status 1")
			}
			return []byte(a.stdout), []byte(a.stderr), err
		}
		return Exec(ctx, timeout, stdin, path, args...)
	}
}

// currentHelps answers the check as a current Claude Code does, so the
// outdated stand-in behind it passes the check and refuses a step: a
// capability the check missed.
var currentHelps = map[string]answer{
	"plugin configure --help": {stdout: "Usage: claude plugin configure [options] <plugin>\n\nOptions:\n" +
		"  --json          Output as JSON\n  --values-stdin  Read option values from stdin\n"},
	"plugin marketplace add --help": {stdout: "Usage: claude plugin marketplace add [options] <source>\n\nOptions:\n" +
		"  --json  Print one machine-readable result line\n"},
}

func TestClaudeCode_AnOutdatedClaudeCode(t *testing.T) {
	f := newOldFakeClaude(t)
	c := newConnector()
	det, err := c.Detect(context.Background())
	if err != nil || !det.Found || det.Version != "2.1.283 (Claude Code)" {
		t.Fatalf("Detect = %+v, %v; want found, with its version", det, err)
	}
	for _, says := range []string{
		"this version has no `claude plugin configure` and no --json on `claude plugin marketplace add`, which flightdeck connect needs: ",
		"update it with `claude update`, then run flightdeck connect claude-code again",
		"or install the plugin from inside Claude Code: /plugin marketplace add flightdeckhq/flightdeck, then /plugin install flightdeck@flightdeck-plugins",
	} {
		if !strings.Contains(det.Outdated, says) {
			t.Errorf("Outdated = %q; want it to say %q", det.Outdated, says)
		}
	}
	if got := f.calls(t); !sameCalls(got, checkCalls) {
		t.Fatalf("Detect ran %q; want only %q", got, checkCalls)
	}

	for _, target := range []Target{{}, {Server: "https://fd.example.com", Token: testToken}} {
		f.resetLog(t)
		_, err := c.PlanConnect(context.Background(), target)
		if !errors.Is(err, ErrOutdated) || strings.Contains(err.Error(), "unknown") || strings.Contains(err.Error(), testToken) ||
			!strings.Contains(err.Error(), "Claude Code 2.1.283 is too old for flightdeck connect (it has no `claude plugin configure` and no --json on "+
				"`claude plugin marketplace add`), so nothing changed: update it with `claude update`") {
			t.Fatalf("PlanConnect(%+v) = %v; want ErrOutdated naming the version and what to do", target, err)
		}
		// Refused before the status read: the version and the check, and
		// nothing given on stdin.
		if got := f.calls(t); !sameCalls(got, outdatedCalls) || strings.Contains(f.read(t, "calls.log"), "stdin:") {
			t.Fatalf("PlanConnect(%+v) ran %q; want only %q", target, got, outdatedCalls)
		}
	}
}

func TestClaudeCode_OneMissingCommandMakesItOutdated(t *testing.T) {
	newOldFakeClaude(t)
	// configure, but no --json on marketplace add.
	c := NewClaudeCode(exec.LookPath, answering(map[string]answer{"plugin configure --help": currentHelps["plugin configure --help"]}))
	det, err := c.Detect(context.Background())
	if err != nil || !strings.HasPrefix(det.Outdated, "this version has no --json on `claude plugin marketplace add`, which") {
		t.Fatalf("Detect = %+v, %v; want outdated for the marketplace add alone", det, err)
	}
	// --json on marketplace add, but no configure.
	c = NewClaudeCode(exec.LookPath, answering(map[string]answer{"plugin marketplace add --help": currentHelps["plugin marketplace add --help"]}))
	if det, err = c.Detect(context.Background()); err != nil || !strings.HasPrefix(det.Outdated, "this version has no `claude plugin configure`, which") {
		t.Fatalf("Detect = %+v, %v; want outdated for configure alone", det, err)
	}
	// A configure help without --values-stdin is not enough.
	c = NewClaudeCode(exec.LookPath, answering(map[string]answer{
		"plugin configure --help":       {stdout: "Usage: claude plugin configure [options] <plugin>\n\nOptions:\n  --json  Output as JSON\n"},
		"plugin marketplace add --help": currentHelps["plugin marketplace add --help"],
	}))
	if det, err = c.Detect(context.Background()); err != nil || !strings.Contains(det.Outdated, "no `claude plugin configure`") {
		t.Fatalf("Detect = %+v, %v; want outdated without --values-stdin", det, err)
	}
	// A configure the CLI refuses as unknown.
	c = NewClaudeCode(exec.LookPath, answering(map[string]answer{
		"plugin configure --help":       {stderr: "error: unknown command 'configure'\n", fail: true},
		"plugin marketplace add --help": currentHelps["plugin marketplace add --help"],
	}))
	if det, err = c.Detect(context.Background()); err != nil || !strings.Contains(det.Outdated, "no `claude plugin configure`") {
		t.Fatalf("Detect = %+v, %v; want outdated for a refused help", det, err)
	}
}

func TestClaudeCode_TheCheckDoesNotGuess(t *testing.T) {
	t.Run("a help command that fails", func(t *testing.T) {
		f := newFakeClaude(t)
		t.Setenv("FAKE_CLAUDE_FAIL", "configure-help")
		c := newConnector()
		det, err := c.Detect(context.Background())
		if err == nil || errors.Is(err, ErrOutdated) || !det.Found || det.Outdated != "" ||
			!strings.Contains(err.Error(), "`claude plugin configure --help` failed: simulated configure-help failure") {
			t.Fatalf("Detect = %+v, %v; want an error naming the help command", det, err)
		}
		if _, err := c.PlanConnect(context.Background(), Target{}); err == nil || errors.Is(err, ErrOutdated) ||
			!strings.Contains(err.Error(), "`claude plugin configure --help` failed") {
			t.Fatalf("PlanConnect: %v; want the same error", err)
		}
		if got := f.changes(t); len(got) != 0 {
			t.Fatalf("ran %q", got)
		}
	})
	t.Run("a help command that hangs", func(t *testing.T) {
		newFakeClaude(t)
		t.Setenv("FAKE_CLAUDE_HANG", "marketplace-add-help")
		t.Setenv("FAKE_CLAUDE_HANG_SECS", "30")
		_, err := NewClaudeCode(exec.LookPath, shortTimeouts).Detect(context.Background())
		if err == nil || errors.Is(err, ErrOutdated) || !strings.Contains(err.Error(), "`claude plugin marketplace add --help` did not finish within") {
			t.Fatalf("Detect: %v; want the help command named as stopped", err)
		}
	})
	t.Run("a help command that prints no help", func(t *testing.T) {
		newFakeClaude(t)
		c := NewClaudeCode(exec.LookPath, answering(map[string]answer{"plugin configure --help": {stdout: "something else entirely\n"}}))
		if _, err := c.Detect(context.Background()); err == nil || errors.Is(err, ErrOutdated) ||
			!strings.Contains(err.Error(), "`claude plugin configure --help` printed no help this command can read") {
			t.Fatalf("Detect: %v; want an error, not a guess", err)
		}
	})
}

func TestClaudeCode_AStepRefusedAsUnknown(t *testing.T) {
	t.Run("a change", func(t *testing.T) {
		f := newOldFakeClaude(t)
		_, err := applyConnect(t, NewClaudeCode(exec.LookPath, answering(currentHelps)), Target{})
		if err == nil {
			t.Fatal("a refused step connected")
		}
		msg := err.Error()
		if !errors.Is(err, ErrOutdated) || strings.Contains(msg, "\n") ||
			!strings.Contains(msg, "`claude plugin marketplace add flightdeckhq/flightdeck --json` failed: error: unknown option '--json', "+
				"so Claude Code 2.1.283 is too old for flightdeck connect: update it with `claude update`, then run flightdeck connect claude-code again") {
			t.Fatalf("err = %q; want one line with the step, the CLI's refusal, the version and what to do", msg)
		}
		// The refused step was the first change; nothing after it ran.
		if got := f.changes(t); len(got) != 1 || f.has("installed") {
			t.Fatalf("changes = %q", got)
		}
	})
	t.Run("the status read", func(t *testing.T) {
		f := newOldFakeClaude(t)
		f.set(t, "marketplace", "installed")
		_, err := NewClaudeCode(exec.LookPath, answering(currentHelps)).PlanConnect(context.Background(), Target{})
		if !errors.Is(err, ErrOutdated) ||
			!strings.Contains(err.Error(), "`claude plugin configure flightdeck@flightdeck-plugins --json` failed: error: unknown command 'configure', so Claude Code 2.1.283 is too old") {
			t.Fatalf("PlanConnect: %v; want the refused read reported as outdated", err)
		}
	})
}

func TestClaudeCode_RemoveOnAnOutdatedClaudeCode(t *testing.T) {
	f := newOldFakeClaude(t)
	f.set(t, "marketplace", "installed", "server=https://fd.example.com", "token="+testToken)
	c := newConnector()
	plan, err := c.PlanDisconnect(context.Background())
	if err != nil || len(plan.Steps) != 1 {
		t.Fatalf("PlanDisconnect = %+v, %v; want the uninstall", plan, err)
	}
	if err := plan.Apply(context.Background(), func(string) {}); err != nil {
		t.Fatal(err)
	}
	if got := f.changes(t); len(got) != 1 || got[0] != "plugin uninstall "+pluginID+" --scope user --json" || f.has("installed") || f.has("token") {
		t.Fatalf("changes = %q; want the uninstall alone, the plugin and its token gone", got)
	}
	// It reads no option: Claude Code 2.1.283 has no configure.
	for _, call := range f.calls(t) {
		if strings.HasPrefix(call, "plugin configure") {
			t.Fatalf("a disconnect ran %q", call)
		}
	}
	if plan, err = c.PlanDisconnect(context.Background()); err != nil || len(plan.Steps) != 0 {
		t.Fatalf("PlanDisconnect again = %+v, %v; want no step", plan, err)
	}
}

func TestTheCheckReadsTheHelp(t *testing.T) {
	help := "Usage: claude x [options]\n\nOptions:\n  -h, --help      Display help\n  --json, -j      Output as JSON (with --values-stdin)\n"
	for _, c := range []struct {
		options []string
		want    bool
	}{
		{[]string{"--json"}, true},
		{[]string{"--json", "--values-stdin"}, true},
		{[]string{"-h", "--help"}, true},
		{[]string{"--js"}, false},
		{[]string{"--json", "--value"}, false},
	} {
		if got := namesAll(help, c.options); got != c.want {
			t.Errorf("namesAll(%q) = %v; want %v", c.options, got, c.want)
		}
	}
	for text, want := range map[string]bool{
		"Usage: claude plugin|plugins [options] [command]\n": true,
		"\n  usage: claude x\n":                              true,
		"Show a plugin's options\n":                          false,
		"":                                                   false,
	} {
		if got := isHelp(text); got != want {
			t.Errorf("isHelp(%q) = %v; want %v", text, got, want)
		}
	}
	for stderr, want := range map[string]bool{
		"error: unknown option '--json'\n":                                                 true,
		"x Failed: something\nerror: unknown command 'configure' (Did you mean config?)\n": true,
		"error: unknown option `sparse'\n":                                                 false, // git's, not Claude Code's
		"x Failed: unknown option '--json' in the manifest\n":                              false,
		"": false,
	} {
		if got := refused([]byte(stderr)); got != want {
			t.Errorf("refused(%q) = %v; want %v", stderr, got, want)
		}
	}
}

func TestClaudeCode_AnOutdatedClaudeCodeWithThePluginInstalled(t *testing.T) {
	f := newOldFakeClaude(t)
	f.set(t, "marketplace", "installed")
	st, err := newConnector().Status(context.Background())
	if err != nil || !st.Connected() || !st.ServerUnknown || st.Version != "0.9.0" || st.Server != "" || st.TokenSaved {
		t.Fatalf("Status = %+v, %v; want connected from the plugin list, the server unknown", st, err)
	}
	// The list, and the options read it refuses: nothing else.
	if got := f.calls(t); !sameCalls(got, []string{"plugin list --json", "plugin configure " + pluginID + " --json"}) {
		t.Fatalf("Status ran %q", got)
	}
}

func TestClaudeCode_TheCheckReadsAColouredHelp(t *testing.T) {
	newOldFakeClaude(t)
	colour := func(s string) string { return "\x1b[1m" + s + "\x1b[0m" }
	c := NewClaudeCode(exec.LookPath, answering(map[string]answer{
		"plugin configure --help": {stdout: colour("Usage:") + " claude plugin configure [options] <plugin>\n\nOptions:\n  " +
			colour("--json") + "          Output as JSON\n  \x1b[36m--values-stdin\x1b[0m  Read option values from stdin\n"},
		"plugin marketplace add --help": {stdout: colour("Usage:") + " claude plugin marketplace add [options] <source>\n\nOptions:\n  " +
			colour("--scope") + " <scope>  Where to declare it\n"},
	}))
	det, err := c.Detect(context.Background())
	if err != nil || !strings.HasPrefix(det.Outdated, "this version has no --json on `claude plugin marketplace add`, which") {
		t.Fatalf("Detect = %+v, %v; want configure read through its colours, and a coloured help without --json outdated", det, err)
	}
	if !refused([]byte("\x1b[31merror: unknown option '--json'\x1b[0m\n")) {
		t.Fatal("a refusal in colour is not read as one")
	}
}

func TestClaudeCode_ControlCharactersFromTheCLIAreNotPrinted(t *testing.T) {
	newOldFakeClaude(t)
	t.Setenv("FAKE_CLAUDE_VERSION", "2.1.283\x1b[2J\a (Claude Code)")
	c := newConnector()
	det, err := c.Detect(context.Background())
	if err != nil || strings.ContainsAny(det.Version, "\x1b\a") {
		t.Fatalf("Detect = %+v, %v; want the version without control characters", det, err)
	}
	if _, err := c.PlanConnect(context.Background(), Target{}); err == nil || strings.ContainsAny(err.Error(), "\x1b\a") {
		t.Fatalf("PlanConnect: %q; want the version without control characters", err)
	}
	// The CLI's own reason for a failed step.
	t.Setenv("FAKE_CLAUDE_VERSION", "")
	t.Setenv("FAKE_CLAUDE_OLD_CLI", "")
	c = NewClaudeCode(exec.LookPath, answering(map[string]answer{
		"plugin marketplace add " + marketplaceSource + " --json": {stderr: "x Failed: \x1b[31mclone failed\x1b[0m\a\n", fail: true},
	}))
	if _, err := applyConnect(t, c, Target{}); err == nil || strings.ContainsAny(err.Error(), "\x1b\a") || !strings.Contains(err.Error(), "x Failed: clone failed") {
		t.Fatalf("err = %q; want the CLI's reason without its colours and control characters", err)
	}
}

func TestClaudeCode_ARemoveRefusedAsUnknown(t *testing.T) {
	f := newOldFakeClaude(t)
	f.set(t, "marketplace", "installed")
	c := NewClaudeCode(exec.LookPath, answering(map[string]answer{
		"plugin uninstall " + pluginID + " --scope user --json": {stderr: "error: unknown option '--json'\n", fail: true},
	}))
	plan, err := c.PlanDisconnect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	err = plan.Apply(context.Background(), func(string) {})
	if !errors.Is(err, ErrOutdated) || !strings.Contains(err.Error(), "so Claude Code 2.1.283 is too old for flightdeck connect: "+
		"update it with `claude update`, then run flightdeck connect claude-code --remove again; or uninstall the plugin from inside Claude Code with /plugin") ||
		strings.Contains(err.Error(), "/plugin install") {
		t.Fatalf("err = %v; want advice for a removal", err)
	}
}
