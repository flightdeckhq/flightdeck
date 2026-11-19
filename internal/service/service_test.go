package service

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

// unitArgv reads back what the installed service file runs.
func unitArgv(t *testing.T, te *testEnv, m manager) []string {
	t.Helper()
	content, err := os.ReadFile(m.path())
	if err != nil {
		t.Fatalf("the service file: %v\n%s", err, te.output())
	}
	argv, err := m.argv(content)
	if err != nil {
		t.Fatalf("the service file's command line: %v", err)
	}
	return argv
}

func systemdOf(te *testEnv) *systemd { return &systemd{rt: te.rt} }

func TestInstall_WritesTheUnitStartsItAndSaysWhere(t *testing.T) {
	te := newTestEnv(t, "linux")
	port := freePort(t)
	data := te.dataDir("data")
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	m := systemdOf(te)
	if want := filepath.Join(te.rt.Home, ".config", "systemd", "user", "flightdeck.service"); m.path() != want {
		t.Fatalf("unit path %s, want %s", m.path(), want)
	}
	if got, want := unitArgv(t, te, m), []string{te.binary, "--port", port, "--data-dir", data}; !reflect.DeepEqual(got, want) {
		t.Errorf("the unit runs %q, want %q", got, want)
	}
	info, err := os.Stat(m.path())
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("the unit's mode is %v (%v), want 0644", info.Mode().Perm(), err)
	}
	for _, line := range []string{
		"systemctl --user daemon-reload",
		"systemctl --user enable flightdeck.service",
		"systemctl --user restart flightdeck.service",
	} {
		if !te.sys.called(line) {
			t.Errorf("install did not run %q; it ran %q", line, te.sys.calls)
		}
	}
	proc := te.sys.running()
	if proc == nil || !te.sys.enabled {
		t.Fatalf("the service is not running and enabled after install:\n%s", te.output())
	}
	out := te.stdout.String()
	for _, want := range []string{
		"The Flightdeck service is installed and runs: http://localhost:" + port,
		"pid " + itoa(proc.pid),
		"~/.config/systemd/user/flightdeck.service",
		"journalctl --user -u flightdeck",
		"flightdeck service remove",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("install's output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "loginctl") {
		t.Errorf("lingering is on, yet install printed the lingering command:\n%s", out)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// The server's flags are baked in as the server reads them: a flag, else
// its variable in the shell install runs in; the data dir and the URL
// file made absolute.
func TestInstall_BakesTheServerFlagsAndTheirVariables(t *testing.T) {
	te := newTestEnv(t, "linux")
	port := freePort(t)
	urlFile := filepath.Join(te.rt.Home, "db-url")
	if err := os.WriteFile(urlFile, []byte("postgres://fd:secret@db.internal:5432/fd\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	te.env = map[string]string{
		"FLIGHTDECK_PORT":     port,
		"FLIGHTDECK_PUBLIC":   "true",
		"FLIGHTDECK_DATA_DIR": te.dataDir("from-env"),
	}
	if code := te.main("install", "--allowed-hosts", "FD.internal,.example.com", "--metrics", "--database-url-file", urlFile); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	want := []string{te.binary, "--public", "--port", port, "--data-dir", te.dataDir("from-env"),
		"--database-url-file", urlFile, "--allowed-hosts", "fd.internal,.example.com", "--metrics"}
	if got := unitArgv(t, te, systemdOf(te)); !reflect.DeepEqual(got, want) {
		t.Errorf("the unit runs %q, want %q", got, want)
	}
	content, _ := os.ReadFile(systemdOf(te).path())
	if strings.Contains(string(content), "secret") {
		t.Errorf("the database URL's password is in the unit:\n%s", content)
	}
	if strings.Contains(te.output(), "warning") {
		t.Errorf("a 0600 URL file drew a warning:\n%s", te.output())
	}
}

func TestInstall_ARelativeDataDirIsMadeAbsolute(t *testing.T) {
	te := newTestEnv(t, "linux")
	t.Chdir(te.rt.Home)
	if code := te.main("install", "--port", freePort(t), "--data-dir", "rel/data"); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	c, err := configOf(unitArgv(t, te, systemdOf(te)))
	if err != nil || c.DataDir != filepath.Join(te.rt.Home, "rel", "data") {
		t.Errorf("data dir baked as %q (%v)", c.DataDir, err)
	}
}

func TestInstall_WarnsWhenOthersCanReadTheURLFile(t *testing.T) {
	te := newTestEnv(t, "linux")
	urlFile := filepath.Join(te.rt.Home, "db-url")
	if err := os.WriteFile(urlFile, []byte("postgres://fd:secret@db/fd"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(urlFile, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d"), "--database-url-file", urlFile); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stderr.String(), "warning: "+urlFile+" can be read by other users") {
		t.Errorf("no warning for a URL file others can read:\n%s", te.output())
	}
}

// Running install again with the same flags writes the same file and
// restarts the service; with other flags it rewrites the file and the
// service moves.
func TestInstall_AgainRewritesAndRestarts(t *testing.T) {
	te := newTestEnv(t, "linux")
	data := te.dataDir("data")
	port := freePort(t)
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("first install exited %d:\n%s", code, te.output())
	}
	m := systemdOf(te)
	first, _ := os.ReadFile(m.path())
	firstPID := te.sys.running().pid
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("second install exited %d:\n%s", code, te.output())
	}
	second, _ := os.ReadFile(m.path())
	if string(first) != string(second) {
		t.Errorf("the same flags wrote another unit:\n%s\n---\n%s", first, second)
	}
	if n := te.sys.callCount("systemctl --user restart flightdeck.service"); n != 2 {
		t.Errorf("restarted %d times over two installs, want 2", n)
	}
	if te.sys.running().pid == firstPID {
		t.Error("the second install did not restart the service")
	}
	if !strings.Contains(te.stdout.String(), "The Flightdeck service is updated and runs") {
		t.Errorf("the second install does not say it updated the service:\n%s", te.output())
	}

	other := freePort(t)
	if code := te.main("install", "--port", other, "--data-dir", data); code != ExitOK {
		t.Fatalf("install on another port exited %d:\n%s", code, te.output())
	}
	if got := te.sys.running().listen; got != "127.0.0.1:"+other {
		t.Errorf("the service listens on %s after install --port %s", got, other)
	}
}

func TestInstall_RefusesRootAndWritesNothing(t *testing.T) {
	te := newTestEnv(t, "linux")
	te.rt.EUID = 0
	if code := te.main("install", "--port", freePort(t)); code != ExitUsage {
		t.Fatalf("install as root exited %d, want %d:\n%s", code, ExitUsage, te.output())
	}
	if !strings.Contains(te.stderr.String(), "not as root") {
		t.Errorf("the refusal does not say why:\n%s", te.output())
	}
	assertNothingWritten(t, te)
}

func assertNothingWritten(t *testing.T, te *testEnv) {
	t.Helper()
	if _, err := os.Stat(systemdOf(te).path()); !os.IsNotExist(err) {
		t.Errorf("a unit was written (%v)", err)
	}
	if _, err := os.Stat((&launchd{rt: te.rt}).path()); !os.IsNotExist(err) {
		t.Errorf("a plist was written (%v)", err)
	}
	for _, c := range te.sys.calls {
		for _, change := range []string{"enable", "restart", "bootstrap", "daemon-reload", "kickstart"} {
			if strings.Contains(c, " "+change) {
				t.Errorf("a refused install ran %q", c)
			}
		}
	}
}

// A secret never reaches the unit: the database URL and the NATS URL are
// refused whether given as a flag or a variable, with the form to use.
func TestInstall_RefusesWhatItWillNotBake(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		env  map[string]string
		want string
	}{
		{"--database-url", []string{"--database-url", "postgres://u:pw@h/db"}, nil, "--database-url-file"},
		{"FLIGHTDECK_DATABASE_URL", nil, map[string]string{"FLIGHTDECK_DATABASE_URL": "postgres://u:pw@h/db"}, "--database-url-file"},
		{"--domain", []string{"--domain", "fd.example.com"}, nil, "443"},
		{"FLIGHTDECK_NATS_URL", nil, map[string]string{"FLIGHTDECK_NATS_URL": "nats://tok@h:4222"}, "embedded bus"},
		{"a control character", []string{"--data-dir", "/tmp/a\nb"}, nil, "control character"},
		{"an unknown flag", []string{"--bogus"}, nil, "flag provided but not defined"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			te := newTestEnv(t, "linux")
			te.env = tc.env
			if te.env == nil {
				te.env = map[string]string{}
			}
			code := te.main(append([]string{"install", "--port", freePort(t)}, tc.args...)...)
			if code != ExitUsage {
				t.Fatalf("exited %d, want %d:\n%s", code, ExitUsage, te.output())
			}
			if !strings.Contains(te.output(), tc.want) {
				t.Errorf("the refusal lacks %q:\n%s", tc.want, te.output())
			}
			if strings.Contains(te.output(), "pw@") || strings.Contains(te.output(), "tok@") {
				t.Errorf("the refusal repeats a secret:\n%s", te.output())
			}
			assertNothingWritten(t, te)
		})
	}
}

func TestInstall_RefusesAForeignUnitAndLeavesIt(t *testing.T) {
	te := newTestEnv(t, "linux")
	m := systemdOf(te)
	foreign := []byte("[Service]\nExecStart=/usr/bin/something-else\n")
	if err := writeFile(m.path(), foreign); err != nil {
		t.Fatal(err)
	}
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitFailed {
		t.Fatalf("install over a foreign unit exited %d:\n%s", code, te.output())
	}
	if got, _ := os.ReadFile(m.path()); string(got) != string(foreign) {
		t.Errorf("the foreign unit was changed:\n%s", got)
	}
	if code := te.main("remove"); code != ExitFailed {
		t.Fatalf("remove of a foreign unit exited %d:\n%s", code, te.output())
	}
	if _, err := os.Stat(m.path()); err != nil {
		t.Errorf("remove removed a foreign unit: %v", err)
	}
}

// Another flightdeck on the data dir, not the service, keeps the
// install from writing anything: the service would only fight it.
func TestInstall_RefusesADataDirAnotherFlightdeckHolds(t *testing.T) {
	te := newTestEnv(t, "linux")
	data := te.dataDir("data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	lock, err := datadir.Acquire(filepath.Join(data, datadir.LockFile))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if code := te.main("install", "--port", freePort(t), "--data-dir", data); code != ExitFailed {
		t.Fatalf("install on a held data dir exited %d:\n%s", code, te.output())
	}
	if want := "another flightdeck (pid " + itoa(os.Getpid()) + ") runs on the data dir"; !strings.Contains(te.stderr.String(), want) {
		t.Errorf("the refusal lacks %q:\n%s", want, te.output())
	}
	assertNothingWritten(t, te)
}

func TestInstall_RefusesAPortAnotherProgramListensOn(t *testing.T) {
	te := newTestEnv(t, "linux")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	if code := te.main("install", "--port", port, "--data-dir", te.dataDir("d")); code != ExitFailed {
		t.Fatalf("install on a busy port exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stderr.String(), "is in use by another program") {
		t.Errorf("the refusal does not name the port:\n%s", te.output())
	}
	assertNothingWritten(t, te)
}

// A service that does not come up is not left behind: a first install
// is removed again, with the log shown.
func TestInstall_RemovesAFirstServiceThatDoesNotComeUp(t *testing.T) {
	te := newTestEnv(t, "linux")
	te.sys.failStart = true
	te.sys.journal = "flightdeck: database: connection refused\n"
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitFailed {
		t.Fatalf("install of a service that fails exited %d:\n%s", code, te.output())
	}
	for _, want := range []string{"the service did not come up: it exited", "connection refused", "Nothing is installed"} {
		if !strings.Contains(te.stderr.String(), want) {
			t.Errorf("the failure lacks %q:\n%s", want, te.output())
		}
	}
	if _, err := os.Stat(systemdOf(te).path()); !os.IsNotExist(err) {
		t.Errorf("the unit of a service that failed is still there (%v)", err)
	}
	if !te.sys.called("systemctl --user disable --now flightdeck.service") || te.sys.enabled {
		t.Errorf("the failed service was not disabled: %q", te.sys.calls)
	}
}

// A re-install that does not come up puts the earlier service back,
// running as it did.
func TestInstall_PutsTheEarlierServiceBackWhenTheNewOneFails(t *testing.T) {
	te := newTestEnv(t, "linux")
	data := te.dataDir("data")
	port := freePort(t)
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("first install exited %d:\n%s", code, te.output())
	}
	m := systemdOf(te)
	before, _ := os.ReadFile(m.path())

	te.sys.failStart = true
	code := te.main("install", "--port", freePort(t), "--data-dir", data)
	te.sys.failStart = false
	if code != ExitFailed {
		t.Fatalf("the failing re-install exited %d:\n%s", code, te.output())
	}
	// The rollback's own start failed too while failStart was set; the
	// manager starts it again, as Restart=on-failure would.
	if got, _ := os.ReadFile(m.path()); string(got) != string(before) {
		t.Errorf("the earlier unit was not restored:\n%s\n---\n%s", got, before)
	}
	// Starts still fail during the rollback, so the earlier service is
	// written back and started but does not run, and the output says that
	// rather than that it is back.
	if !strings.Contains(te.stderr.String(), "The earlier service is written back and started") ||
		strings.Contains(te.stderr.String(), "back as it was") {
		t.Errorf("the rollback is not reported as it went:\n%s", te.output())
	}
}

// The wait is for the service's own process: a flightdeck that answers
// on the port while another PID holds the data dir does not pass.
func TestInstall_WaitsForTheServicesOwnProcess(t *testing.T) {
	te := newTestEnv(t, "linux")
	te.rt.ReadyTimeout = 200 * time.Millisecond
	te.sys.otherPID = 7
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitFailed {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stderr.String(), "the data dir is held by pid 7, not by the service's pid") {
		t.Errorf("the failure does not name the other process:\n%s", te.output())
	}
}

func TestInstall_DryRunPrintsTheUnitAndChangesNothing(t *testing.T) {
	te := newTestEnv(t, "linux")
	port := freePort(t)
	if code := te.main("install", "--dry-run", "--port", port, "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install --dry-run exited %d:\n%s", code, te.output())
	}
	out := te.stdout.String()
	for _, want := range []string{"Write the systemd user unit", "ExecStart=", "systemctl --user restart flightdeck.service", "Nothing was changed"} {
		if !strings.Contains(out, want) {
			t.Errorf("--dry-run lacks %q:\n%s", want, out)
		}
	}
	assertNothingWritten(t, te)
}

func TestInstall_ReadsTheManagersOwnConfigHome(t *testing.T) {
	te := newTestEnv(t, "linux")
	te.sys.configHome = filepath.Join(te.rt.Home, "cfg")
	te.env["XDG_CONFIG_HOME"] = filepath.Join(te.rt.Home, "shell-only")
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if _, err := os.Stat(filepath.Join(te.rt.Home, "cfg", "systemd", "user", "flightdeck.service")); err != nil {
		t.Errorf("the unit is not where the manager reads units: %v", err)
	}
}

func TestInstall_WithoutAUserManagerSaysWhatToDo(t *testing.T) {
	for _, tc := range []struct {
		name    string
		setup   func(*testEnv)
		want    string
		notWant string
	}{
		{"no systemctl", func(te *testEnv) { te.sys.missing["systemctl"] = true }, "no systemctl", ""},
		{"WSL without systemd", func(te *testEnv) {
			te.rt.WSL = true
			te.sys.envErr = "System has not been booted with systemd as init system (PID 1). Can't operate."
		}, "systemd=true", ""},
		{"no systemd", func(te *testEnv) {
			te.sys.envErr = "System has not been booted with systemd as init system (PID 1). Can't operate."
		}, "not PID 1", "wsl"},
		{"no user manager", func(te *testEnv) {
			te.sys.envErr = "Failed to connect to bus: No medium found"
		}, "sudo loginctl enable-linger ada", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			te := newTestEnv(t, "linux")
			tc.setup(te)
			if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitUnsupported {
				t.Fatalf("exited %d, want %d:\n%s", code, ExitUnsupported, te.output())
			}
			if !strings.Contains(te.output(), tc.want) || (tc.notWant != "" && strings.Contains(te.output(), tc.notWant)) {
				t.Errorf("the message (want %q) is:\n%s", tc.want, te.output())
			}
			assertNothingWritten(t, te)
		})
	}
}

func TestInstall_PrintsTheLingeringCommandOnlyWhenLingeringIsOff(t *testing.T) {
	te := newTestEnv(t, "linux")
	te.sys.linger = "no"
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stdout.String(), "  sudo loginctl enable-linger ada\n") {
		t.Errorf("no lingering command:\n%s", te.output())
	}
	if te.sys.called("loginctl enable-linger ada") {
		t.Error("install ran the lingering command itself")
	}
	te2 := newTestEnv(t, "linux")
	te2.rt.WSL, te2.sys.linger = true, "no"
	if code := te2.main("install", "--port", freePort(t), "--data-dir", te2.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te2.output())
	}
	if strings.Contains(te2.stdout.String(), "loginctl") || !strings.Contains(te2.stdout.String(), "On WSL it runs while WSL does") {
		t.Errorf("on WSL the note is:\n%s", te2.output())
	}
}

func TestInstall_PrintsWhatTheAgentCheckFinds(t *testing.T) {
	te := newTestEnv(t, "linux")
	var asked string
	te.rt.AgentNotes = func(_ context.Context, listen string) []string {
		asked = listen
		return []string{"Claude Code reports to http://localhost:4000, not to this server"}
	}
	port := freePort(t)
	if code := te.main("install", "--port", port, "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if asked != "127.0.0.1:"+port || !strings.Contains(te.stdout.String(), "Claude Code reports to") {
		t.Errorf("the agent check asked for %q and install printed:\n%s", asked, te.output())
	}
}

// Homebrew's formula has a service of its own: install points to it and
// writes nothing unless --no-brew, which bakes the path Homebrew keeps
// across upgrades; while Homebrew's service is loaded it refuses.
func TestInstall_OnAHomebrewInstall(t *testing.T) {
	te := newTestEnv(t, "linux")
	prefix := filepath.Join(te.rt.Home, "linuxbrew")
	cellar := filepath.Join(prefix, "Cellar", "flightdeck", "0.11.0", "bin", "flightdeck")
	opt := filepath.Join(prefix, "opt", "flightdeck")
	link := filepath.Join(prefix, "bin", "flightdeck")
	for _, dir := range []string{filepath.Dir(cellar), filepath.Dir(opt), filepath.Dir(link)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(cellar, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "Cellar", "flightdeck", "0.11.0"), opt); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "Cellar", "flightdeck", "0.11.0", "bin", "flightdeck"), link); err != nil {
		t.Fatal(err)
	}
	te.binary = link
	data := te.dataDir("d")

	if code := te.main("install", "--port", freePort(t), "--data-dir", data); code != ExitUnsupported {
		t.Fatalf("install on Homebrew exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stderr.String(), "brew services start flightdeck") || !strings.Contains(te.stderr.String(), "--no-brew") {
		t.Errorf("the advice lacks brew services or --no-brew:\n%s", te.output())
	}
	assertNothingWritten(t, te)

	te.sys.brewActive = true
	if code := te.main("install", "--no-brew", "--port", freePort(t), "--data-dir", data); code != ExitUnsupported {
		t.Fatalf("install --no-brew beside Homebrew's loaded service exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stderr.String(), "brew services stop flightdeck") {
		t.Errorf("the refusal does not say how to stop Homebrew's service:\n%s", te.output())
	}
	assertNothingWritten(t, te)

	te.sys.brewActive = false
	if code := te.main("install", "--no-brew", "--port", freePort(t), "--data-dir", data); code != ExitOK {
		t.Fatalf("install --no-brew exited %d:\n%s", code, te.output())
	}
	if got := unitArgv(t, te, systemdOf(te))[0]; got != filepath.Join(opt, "bin", "flightdeck") {
		t.Errorf("the unit runs %s, want Homebrew's opt path %s", got, filepath.Join(opt, "bin", "flightdeck"))
	}
}

// A binary that may be gone at the next login is refused.
func TestInstall_RefusesABinaryInATemporaryOrCacheDirectory(t *testing.T) {
	for name, dir := range map[string]func(*testEnv) string{
		"the temporary directory": func(te *testEnv) string { return filepath.Join(te.rt.TempDir, "go-run-123") },
		"uvx's cache":             func(te *testEnv) string { return filepath.Join(te.rt.Home, ".cache", "uv", "archive-v0", "abc", "bin") },
		"uv's environments": func(te *testEnv) string {
			return filepath.Join(te.rt.Home, "elsewhere", "environments-v2", "fd-123", "lib", "python3.12", "site-packages", "flightdeck_cli", "bin")
		},
		"a UV_CACHE_DIR of its own": func(te *testEnv) string {
			te.env["UV_CACHE_DIR"] = filepath.Join(te.rt.Home, "uvc")
			return filepath.Join(te.rt.Home, "uvc", "sdists-v9", "x")
		},
		"a PIPX_HOME of its own": func(te *testEnv) string {
			te.env["PIPX_HOME"] = filepath.Join(te.rt.Home, "px")
			return filepath.Join(te.rt.Home, "px", ".cache", "abc", "bin")
		},
		"a go run build": func(te *testEnv) string { return filepath.Join(te.rt.Home, "gotmp", "go-build123", "b001", "exe") },
	} {
		t.Run(name, func(t *testing.T) {
			te := newTestEnv(t, "linux")
			te.binary = filepath.Join(dir(te), "flightdeck")
			if err := os.MkdirAll(filepath.Dir(te.binary), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(te.binary, nil, 0o755); err != nil {
				t.Fatal(err)
			}
			if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitUnsupported {
				t.Fatalf("exited %d:\n%s", code, te.output())
			}
			assertNothingWritten(t, te)
		})
	}
}

func TestInstall_ResolvesASymbolicLinkToTheBinary(t *testing.T) {
	te := newTestEnv(t, "linux")
	link := filepath.Join(te.rt.Home, "links", "fd")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(te.binary, link); err != nil {
		t.Fatal(err)
	}
	real := te.binary
	te.binary = link
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if got := unitArgv(t, te, systemdOf(te))[0]; got != real {
		t.Errorf("the unit runs %s, want the link's target %s", got, real)
	}
}

func TestRemove_RemovesTheServiceAndLeavesTheDataDir(t *testing.T) {
	te := newTestEnv(t, "linux")
	data := te.dataDir("data")
	if code := te.main("install", "--port", freePort(t), "--data-dir", data); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	kept := map[string]string{"flightdeck.db": "the database", "secrets.json": "{}", "flightdeck.log": "a log"}
	for name, content := range kept {
		if err := os.WriteFile(filepath.Join(data, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if code := te.main("remove", "--dry-run"); code != ExitOK || !strings.Contains(te.stdout.String(), "systemctl --user disable --now flightdeck.service") {
		t.Fatalf("remove --dry-run exited %d:\n%s", code, te.output())
	}
	if te.sys.running() == nil {
		t.Fatal("remove --dry-run stopped the service")
	}
	if code := te.main("remove"); code != ExitOK {
		t.Fatalf("remove exited %d:\n%s", code, te.output())
	}
	if _, err := os.Stat(systemdOf(te).path()); !os.IsNotExist(err) {
		t.Errorf("the unit is still there after remove (%v)", err)
	}
	if te.sys.running() != nil || te.sys.enabled {
		t.Error("the service still runs or starts at login after remove")
	}
	for name, content := range kept {
		if got, err := os.ReadFile(filepath.Join(data, name)); err != nil || string(got) != content {
			t.Errorf("remove changed %s in the data dir: %q, %v", name, got, err)
		}
	}
	if !strings.Contains(te.stdout.String(), "Its data dir, "+data+", is as it was") {
		t.Errorf("remove does not say the data dir stays:\n%s", te.output())
	}
	if code := te.main("remove"); code != ExitOK || !strings.Contains(te.stdout.String(), "not installed; nothing changed") {
		t.Errorf("a second remove exited %d:\n%s", code, te.output())
	}
}

// A unit file deleted by hand leaves the manager running the service
// until it is stopped: remove stops it all the same.
func TestRemove_StopsAServiceWhoseFileWasDeleted(t *testing.T) {
	te := newTestEnv(t, "linux")
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if err := os.Remove(systemdOf(te).path()); err != nil {
		t.Fatal(err)
	}
	if code := te.main("remove"); code != ExitOK {
		t.Fatalf("remove exited %d:\n%s", code, te.output())
	}
	if te.sys.running() != nil || !te.sys.called("systemctl --user stop flightdeck.service") {
		t.Errorf("the service still runs after remove: %q", te.sys.calls)
	}
	if _, err := os.Lstat(te.sys.wantsLink()); !os.IsNotExist(err) {
		t.Errorf("remove left the link that enables the unit (%v)", err)
	}
}

// Before remove, status says what is there: the manager still runs a
// service whose file is gone.
func TestStatus_AServiceWhoseFileIsGoneIsNotNotInstalled(t *testing.T) {
	te := newTestEnv(t, "linux")
	if code := te.main("install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	if err := os.Remove(systemdOf(te).path()); err != nil {
		t.Fatal(err)
	}
	if code := te.main("status"); code != ExitFailed || !strings.Contains(te.stdout.String(), "is gone, but the systemd user unit still has it") ||
		!strings.Contains(te.stdout.String(), "flightdeck service remove") {
		t.Errorf("status exited %d:\n%s", code, te.output())
	}
}

// An interrupt (Ctrl+C, SIGTERM) while install waits still rolls back:
// the manager's commands run on a context of their own, and nothing of
// a first install is left, the link that enables it and the process
// included.
func TestInstall_AnInterruptDuringTheWaitRemovesAFirstInstall(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			te := newTestEnv(t, goos)
			ctx := te.interruptDuringTheWait()
			if code := te.mainCtx(ctx, "install", "--port", freePort(t), "--data-dir", te.dataDir("d")); code != ExitFailed {
				t.Fatalf("an interrupted install exited %d:\n%s", code, te.output())
			}
			for _, want := range []string{"interrupted before the service answered", "Nothing is installed"} {
				if !strings.Contains(te.stderr.String(), want) {
					t.Errorf("the output lacks %q:\n%s", want, te.output())
				}
			}
			m, _ := managerFor(te.rt)
			if _, err := os.Stat(m.path()); !os.IsNotExist(err) {
				t.Errorf("the service file is still there (%v)", err)
			}
			if te.sys.running() != nil || te.sys.enabled || te.sys.loaded != nil || te.sys.plist != nil {
				t.Errorf("the manager still has the service: running %v, enabled %v; calls %q", te.sys.running(), te.sys.enabled, te.sys.calls)
			}
			if _, err := os.Lstat(te.sys.wantsLink()); !os.IsNotExist(err) {
				t.Errorf("the link that enables the unit is still there (%v)", err)
			}
		})
	}
}

// On a re-install the same interrupt puts the earlier service back,
// loaded and running where it ran.
func TestInstall_AnInterruptDuringTheWaitPutsTheEarlierServiceBack(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			te := newTestEnv(t, goos)
			data := te.dataDir("d")
			port := freePort(t)
			if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
				t.Fatalf("first install exited %d:\n%s", code, te.output())
			}
			m, _ := managerFor(te.rt)
			before, _ := os.ReadFile(m.path())
			ctx := te.interruptDuringTheWait()
			if code := te.mainCtx(ctx, "install", "--port", freePort(t), "--data-dir", data); code != ExitFailed {
				t.Fatalf("an interrupted re-install exited %d:\n%s", code, te.output())
			}
			if got, _ := os.ReadFile(m.path()); string(got) != string(before) {
				t.Errorf("the earlier file is not back:\n%s", got)
			}
			if proc := te.sys.running(); proc == nil || proc.listen != "127.0.0.1:"+port {
				t.Errorf("the earlier service does not run on its port again: %+v", proc)
			}
			if !strings.Contains(te.stderr.String(), "The service is back as it was before this install") {
				t.Errorf("the output does not say the earlier service is back:\n%s", te.output())
			}
		})
	}
}

// status is about this service: an answer on its port from something
// else, while the service does not run, is said to be that.
func TestStatus_AnAnswerFromSomethingElseIsNotTheService(t *testing.T) {
	te := newTestEnv(t, "linux")
	port := freePort(t)
	if code := te.main("install", "--port", port, "--data-dir", te.dataDir("d")); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	te.sys.mu.Lock()
	te.sys.proc = nil
	te.sys.mu.Unlock()
	te.rt.Answers = func(context.Context, string) (string, error) { return "http://127.0.0.1:" + port, nil }
	if code := te.main("status"); code != ExitFailed {
		t.Errorf("status of a stopped service exited %d:\n%s", code, te.output())
	}
	if !strings.Contains(te.stdout.String(), "the service is not running; something else answers on port "+port) ||
		strings.Contains(te.stdout.String(), "healthy:") {
		t.Errorf("status takes another server for the service:\n%s", te.output())
	}
}

// The first line says who wrote a file: one that only mentions the
// marker further down is someone else's.
func TestOurs_TheOpeningLineDecides(t *testing.T) {
	sd, ld := &systemd{}, &launchd{}
	if !sd.ours(sd.render(awkward)) || !ld.ours(ld.render(awkward)) {
		t.Fatal("a rendered file is not recognised as this command's")
	}
	if sd.ours([]byte("[Service]\n# " + marker + "\nExecStart=/bin/true\n")) {
		t.Error("a unit with the marker below its first line is taken for this command's")
	}
	if ld.ours([]byte("<?xml version=\"1.0\"?>\n<plist><!-- " + marker + " --></plist>\n")) {
		t.Error("a plist whose first comment is not the marker's is taken for this command's")
	}
}

func TestStatusAndRestart(t *testing.T) {
	te := newTestEnv(t, "linux")
	if code := te.main("status"); code != ExitNotInstalled || !strings.Contains(te.stdout.String(), "not installed") {
		t.Errorf("status before install exited %d:\n%s", code, te.output())
	}
	if code := te.main("restart"); code != ExitNotInstalled {
		t.Errorf("restart before install exited %d:\n%s", code, te.output())
	}
	port := freePort(t)
	data := te.dataDir("data")
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	pid := te.sys.running().pid
	if code := te.main("status"); code != ExitOK {
		t.Fatalf("status of a running service exited %d:\n%s", code, te.output())
	}
	for _, want := range []string{
		"running, pid " + itoa(pid) + "; starts at login",
		te.binary + " --port " + port + " --data-dir " + data,
		"healthy: http://127.0.0.1:" + port,
		"http://localhost:" + port,
		"journalctl --user -u flightdeck",
	} {
		if !strings.Contains(te.stdout.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, te.output())
		}
	}
	if code := te.main("restart"); code != ExitOK {
		t.Fatalf("restart exited %d:\n%s", code, te.output())
	}
	if te.sys.running().pid == pid || !strings.Contains(te.stdout.String(), "restarted and runs") {
		t.Errorf("restart did not start a new process:\n%s", te.output())
	}
	te.sys.mu.Lock()
	te.sys.proc, te.sys.failed = nil, true
	te.sys.mu.Unlock()
	if code := te.main("status"); code != ExitFailed || !strings.Contains(te.stdout.String(), "failed") {
		t.Errorf("status of a failed service exited %d:\n%s", code, te.output())
	}
}

// Running is what the server asks when its port or data dir is taken.
func TestRunning_ReportsTheServicesSettingsAndPID(t *testing.T) {
	te := newTestEnv(t, "linux")
	if _, _, ok := Running(context.Background(), te.rt); ok {
		t.Fatal("Running says a service runs before install")
	}
	port := freePort(t)
	data := te.dataDir("data")
	if code := te.main("install", "--port", port, "--data-dir", data); code != ExitOK {
		t.Fatalf("install exited %d:\n%s", code, te.output())
	}
	c, pid, ok := Running(context.Background(), te.rt)
	if !ok || pid != te.sys.running().pid || c.Listen != "127.0.0.1:"+port || c.DataDir != data {
		t.Errorf("Running = %+v, %d, %v", c, pid, ok)
	}
	te.sys.mu.Lock()
	te.sys.proc = nil
	te.sys.mu.Unlock()
	if _, _, ok := Running(context.Background(), te.rt); ok {
		t.Error("Running says a stopped service runs")
	}
}

func TestMain_UsageAndOtherSystems(t *testing.T) {
	te := newTestEnv(t, "linux")
	if code := te.main(); code != ExitUsage || !strings.Contains(te.stderr.String(), "Usage: flightdeck service install") {
		t.Errorf("no command exited %d:\n%s", code, te.output())
	}
	if code := te.main("--help"); code != ExitOK || !strings.Contains(te.stdout.String(), "Exit status") {
		t.Errorf("--help exited %d:\n%s", code, te.output())
	}
	if code := te.main("start"); code != ExitUsage || !strings.Contains(te.stderr.String(), `no command "start"`) {
		t.Errorf("an unknown command exited %d:\n%s", code, te.output())
	}
	if code := te.main("install", "--help"); code != ExitOK || !strings.Contains(te.stderr.String(), "-no-brew") ||
		!strings.Contains(te.stderr.String(), "-database-url-file") {
		t.Errorf("install --help exited %d:\n%s", code, te.output())
	}
	for _, goos := range []string{"windows", "freebsd"} {
		other := newTestEnv(t, goos)
		if code := other.main("install", "--port", freePort(t)); code != ExitUnsupported {
			t.Errorf("install on %s exited %d:\n%s", goos, code, other.output())
		}
		if code := other.main("status"); code != ExitUnsupported {
			t.Errorf("status on %s exited %d:\n%s", goos, code, other.output())
		}
	}
}
