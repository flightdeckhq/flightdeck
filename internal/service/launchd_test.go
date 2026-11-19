package service

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func launchdOf(te *testEnv) *launchd { return &launchd{rt: te.rt} }

func TestLaunchd_InstallWritesThePlistBootstrapsItAndKeepsTheLogInTheDataDir(t *testing.T) {
	te := newTestEnv(t, "darwin")
	port := freePort(t)
	data := te.dataDir("Flightdeck data")
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	m := launchdOf(te)
	if want := filepath.Join(te.rt.Home, "Library", "LaunchAgents", "com.flightdeck-hq.flightdeck.plist"); m.path() != want {
		t.Fatalf("plist path %s, want %s", m.path(), want)
	}
	if got, want := unitArgv(t, te, m), []string{te.binary, "--port", port, "--data-dir", data}; !reflect.DeepEqual(got, want) {
		t.Errorf("the plist runs %q, want %q", got, want)
	}
	for _, line := range []string{
		"launchctl enable gui/501/com.flightdeck-hq.flightdeck",
		"launchctl bootstrap gui/501 " + m.path(),
	} {
		if !te.sys.called(line) {
			t.Errorf("install did not run %q; it ran %q", line, te.sys.calls)
		}
	}
	if info, err := os.Stat(data); err != nil || info.Mode().Perm() != 0o700 {
		t.Errorf("the data dir for the log was not created 0700: %v %v", info, err)
	}
	if !strings.Contains(te.stdout.String(), filepath.Join(data, "flightdeck.log")) {
		t.Errorf("install does not say where the log is:\n%s", te.output())
	}

	// Again: launchd reads a plist only when it is bootstrapped, so the
	// loaded agent is booted out first.
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("second install exited %d:\n%s", code, te.output())
	}
	if !te.sys.called("launchctl bootout gui/501/com.flightdeck-hq.flightdeck") || te.sys.callCount("launchctl bootstrap gui/501 "+m.path()) != 2 {
		t.Errorf("a re-install did not boot out and bootstrap again: %q", te.sys.calls)
	}
}

// launchd can answer "Input/output error" to a bootstrap right after a
// bootout while it tears the job down; install tries again.
func TestLaunchd_BootstrapIsRetried(t *testing.T) {
	te := newTestEnv(t, "darwin")
	te.sys.bootstrapFailNo = 2
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if n := te.sys.callCount("launchctl bootstrap gui/501 " + launchdOf(te).path()); n != 3 {
		t.Errorf("bootstrap ran %d times, want 3 (two refusals, then success)", n)
	}
}

func TestLaunchd_WithoutALoginSessionNothingIsWritten(t *testing.T) {
	te := newTestEnv(t, "darwin")
	te.sys.noGUI = true
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitUnsupported {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stderr.String(), "no login session") {
		t.Errorf("the refusal does not say why:\n%s", te.output())
	}
	assertNothingWritten(t, te)
}

func TestLaunchd_RefusesWhileHomebrewsServiceIsLoaded(t *testing.T) {
	te := newTestEnv(t, "darwin")
	te.sys.brewLoaded = true
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitUnsupported {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	assertNothingWritten(t, te)
	if code := te.main("status"); code != ExitNotInstalled || !strings.Contains(te.stdout.String(), "Homebrew's flightdeck service is loaded") {
		t.Errorf("status exited %d:\n%s", code, te.output())
	}
}

func TestLaunchd_FailedStartIsRolledBack(t *testing.T) {
	te := newTestEnv(t, "darwin")
	te.sys.failStart = true
	data := te.dataDir("d")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "flightdeck.log"), []byte("earlier\nflightdeck: data dir is not writable\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := te.main("install", "--port", freePort(t), "--data-dir", data); code != ExitFailed {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stderr.String(), "data dir is not writable") {
		t.Errorf("the failure does not show the log's end:\n%s", te.output())
	}
	if _, err := os.Stat(launchdOf(te).path()); !os.IsNotExist(err) {
		t.Errorf("the plist of a service that failed is still there (%v)", err)
	}
}

func TestLaunchd_StatusRestartRemove(t *testing.T) {
	te := newTestEnv(t, "darwin")
	data := te.dataDir("d")
	port := freePort(t)
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	pid := te.sys.running().pid
	// The sub-section of `launchctl print` has a "state" and a "pid" of
	// its own; the agent's are the ones read.
	if code := te.main("status"); code != ExitOK || !strings.Contains(te.stdout.String(), "running, pid "+itoa(pid)+"; starts at login") {
		t.Fatalf("status exited %d:\n%s", code, te.output())
	}
	te.sys.mu.Lock()
	te.sys.disabled = true
	te.sys.mu.Unlock()
	if code := te.main("status"); !strings.Contains(te.stdout.String(), "does not start at login") {
		t.Errorf("status (%d) of a disabled agent:\n%s", code, te.output())
	}
	if code := te.main("restart"); code != ExitOK || !te.sys.called("launchctl kickstart -k gui/501/com.flightdeck-hq.flightdeck") {
		t.Fatalf("restart exited %d: %q\n%s", code, te.sys.calls, te.output())
	}
	if te.sys.running().pid == pid {
		t.Error("restart did not start a new process")
	}
	if err := os.WriteFile(filepath.Join(data, "flightdeck.db"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := te.main("remove"); code != ExitOK {
		t.Fatalf("remove exited %d:\n%s", code, te.output())
	}
	if _, err := os.Stat(launchdOf(te).path()); !os.IsNotExist(err) || te.sys.plist != nil || te.sys.running() != nil {
		t.Errorf("the agent is still there after remove (%v)", err)
	}
	if got, err := os.ReadFile(filepath.Join(data, "flightdeck.db")); err != nil || string(got) != "data" {
		t.Errorf("remove touched the data dir: %q %v", got, err)
	}
}

func TestLaunchd_RecentLogIsTheEndOfTheFile(t *testing.T) {
	data := t.TempDir()
	var b strings.Builder
	for i := range 5000 {
		b.WriteString("line " + itoa(i) + "\n")
	}
	if err := os.WriteFile(filepath.Join(data, "flightdeck.log"), []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	got := (&launchd{}).recentLog(context.Background(), Config{DataDir: data}, time.Time{})
	lines := strings.Split(got, "\n")
	if len(lines) != recentLogLines || lines[len(lines)-1] != "line 4999" || lines[0] != "line 4980" {
		t.Errorf("the log's end is %d lines, %q … %q", len(lines), lines[0], lines[len(lines)-1])
	}
}
