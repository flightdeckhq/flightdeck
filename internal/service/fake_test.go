package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

// The stand-ins below are the service managers the tests run install,
// status, restart and remove against, as internal/connect's fakeclaude
// stands in for Claude Code's CLI: systemctl --user, launchctl, loginctl
// and journalctl, answering what the commands ask with the output the
// real ones give, in-process. They keep the state the manager would: the
// unit or plist as read at daemon-reload or bootstrap, whether it is
// enabled, and the process it runs. Starting that process simulates the
// binary: it writes its PID into the data dir's lock file, as the server
// does once it holds the lock, and Answers then answers for its listen
// address.

// errExit is a command that ran and exited non-zero.
var errExit = errors.New("exit status 1")

// fakeProc is the simulated binary the manager started.
type fakeProc struct {
	pid    int
	listen string
}

type fakeSystem struct {
	t    *testing.T
	home string
	uid  int

	mu    sync.Mutex
	calls []string

	// missing names commands that are not on PATH.
	missing map[string]bool

	// systemd
	envErr     string // show-environment fails with this stderr
	configHome string // XDG_CONFIG_HOME in the manager's environment
	unitPath   string // where the manager reads the unit from
	loaded     []byte // the unit as daemon-reload read it; nil: not-found
	enabled    bool
	linger     string
	brewActive bool

	// launchd
	noGUI           bool
	plist           []byte // the plist as bootstrap read it; nil: not loaded
	disabled        bool
	brewLoaded      bool
	bootstrapFailNo int // the next n bootstraps fail with EIO

	// both
	proc      *fakeProc
	failed    bool // the last start exited at once with an error
	failStart bool // starts exit at once with an error
	otherPID  int  // starts leave this PID in the lock file
	nextPID   int
	journal   string
}

func newFakeSystem(t *testing.T, home string) *fakeSystem {
	t.Helper()
	return &fakeSystem{t: t, home: home, uid: 501, nextPID: 4242, missing: map[string]bool{}, linger: "yes"}
}

func (f *fakeSystem) log(name string, args []string) {
	f.calls = append(f.calls, strings.TrimSpace(name+" "+strings.Join(args, " ")))
}

// called reports whether a command line was run, word for word.
func (f *fakeSystem) called(line string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == line {
			return true
		}
	}
	return false
}

func (f *fakeSystem) callCount(line string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == line {
			n++
		}
	}
	return n
}

func (f *fakeSystem) running() *fakeProc {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.proc
}

func (f *fakeSystem) run(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log(name, args)
	if f.missing[name] {
		return nil, nil, &exec.Error{Name: name, Err: exec.ErrNotFound}
	}
	switch name {
	case "systemctl":
		return f.systemctl(args)
	case "launchctl":
		return f.launchctl(args)
	case "loginctl":
		return []byte(f.linger + "\n"), nil, nil
	case "journalctl":
		return []byte(f.journal), nil, nil
	}
	return nil, []byte("unexpected command " + name), errExit
}

// start simulates the binary of the service file content argv reads: it
// takes the data dir's lock file as the server does, unless the start is
// to fail.
func (f *fakeSystem) start(argv []string, err error) error {
	f.proc = nil
	if err != nil {
		return err
	}
	c, err := configOf(argv)
	if err != nil {
		return err
	}
	if f.failStart {
		f.failed = true
		return nil
	}
	f.failed = false
	pid := f.nextPID
	f.nextPID++
	if err := os.MkdirAll(c.DataDir, 0o700); err != nil {
		return err
	}
	holder := pid
	if f.otherPID != 0 {
		holder = f.otherPID
	}
	if err := os.WriteFile(filepath.Join(c.DataDir, datadir.LockFile), []byte(strconv.Itoa(holder)+"\n"), 0o600); err != nil {
		return err
	}
	f.proc = &fakeProc{pid: pid, listen: c.Listen}
	return nil
}

func (f *fakeSystem) systemctl(args []string) ([]byte, []byte, error) {
	if len(args) == 0 || args[0] != "--user" {
		return nil, []byte("the stand-in answers systemctl --user only"), errExit
	}
	args = args[1:]
	unitFile := filepath.Join(f.unitDir(), systemdUnit)
	switch {
	case len(args) == 1 && args[0] == "show-environment":
		if f.envErr != "" {
			return nil, []byte(f.envErr), errExit
		}
		env := "HOME=" + f.home + "\nLANG=C.UTF-8\n"
		if f.configHome != "" {
			env += "XDG_CONFIG_HOME=" + f.configHome + "\n"
		}
		return []byte(env), nil, nil
	case len(args) == 1 && args[0] == "daemon-reload":
		data, err := os.ReadFile(unitFile)
		if err != nil {
			f.loaded = nil
		} else {
			f.loaded = data
		}
		return nil, nil, nil
	case len(args) == 3 && args[0] == "show":
		return []byte(f.props(args[1])), nil, nil
	case len(args) == 2 && args[0] == "enable" && args[1] == systemdUnit:
		if f.loaded == nil {
			return nil, []byte("Failed to enable unit: Unit file flightdeck.service does not exist."), errExit
		}
		f.enabled = true
		return nil, nil, nil
	case len(args) == 2 && args[0] == "reset-failed":
		f.failed = false
		return nil, nil, nil
	case len(args) == 2 && args[0] == "restart" && args[1] == systemdUnit:
		if f.loaded == nil {
			return nil, []byte("Failed to restart flightdeck.service: Unit flightdeck.service not found."), errExit
		}
		return nil, nil, f.start((&systemd{}).argv(f.loaded))
	case len(args) == 3 && args[0] == "disable" && args[1] == "--now" && args[2] == systemdUnit:
		if _, err := os.Stat(unitFile); err != nil {
			return nil, []byte("Failed to disable unit: Unit file flightdeck.service does not exist."), errExit
		}
		f.proc, f.enabled = nil, false
		return nil, nil, nil
	case len(args) == 2 && args[0] == "stop" && args[1] == systemdUnit:
		f.proc = nil
		return nil, nil, nil
	}
	return nil, []byte("unexpected systemctl --user " + strings.Join(args, " ")), errExit
}

func (f *fakeSystem) unitDir() string {
	if f.unitPath != "" {
		return f.unitPath
	}
	home := f.configHome
	if home == "" {
		home = filepath.Join(f.home, ".config")
	}
	return filepath.Join(home, "systemd", "user")
}

func (f *fakeSystem) props(unit string) string {
	switch unit {
	case homebrewSystemdUnit:
		if f.brewActive {
			return "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=99\nUnitFileState=enabled\n"
		}
		return "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nUnitFileState=\n"
	case systemdUnit:
	default:
		return ""
	}
	load, active, sub, pid, file := "not-found", "inactive", "dead", 0, ""
	if f.loaded != nil {
		load, file = "loaded", "disabled"
		if f.enabled {
			file = "enabled"
		}
	}
	switch {
	case f.proc != nil:
		active, sub, pid = "active", "running", f.proc.pid
	case f.failed:
		active, sub = "activating", "auto-restart"
	}
	return fmt.Sprintf("LoadState=%s\nActiveState=%s\nSubState=%s\nMainPID=%d\nUnitFileState=%s\n", load, active, sub, pid, file)
}

func (f *fakeSystem) launchctl(args []string) ([]byte, []byte, error) {
	domain := "gui/" + strconv.Itoa(f.uid)
	target := domain + "/" + launchdLabel
	plistPath := filepath.Join(f.home, "Library", "LaunchAgents", launchdLabel+".plist")
	switch {
	case len(args) == 2 && args[0] == "print" && args[1] == domain:
		if f.noGUI {
			return nil, []byte("Could not find domain for port identifier: " + domain), errExit
		}
		return []byte(domain + " = {\n\ttype = login\n}\n"), nil, nil
	case len(args) == 2 && args[0] == "print" && args[1] == domain+"/"+homebrewLaunchdLabel:
		if f.brewLoaded {
			return []byte("{\n\tstate = running\n}\n"), nil, nil
		}
		return nil, []byte("Could not find service"), errExit
	case len(args) == 2 && args[0] == "print" && args[1] == target:
		if f.plist == nil {
			return nil, []byte(`Could not find service "` + launchdLabel + `" in domain for port`), errExit
		}
		return []byte(f.launchdPrint()), nil, nil
	case len(args) == 2 && args[0] == "print-disabled" && args[1] == domain:
		state := "enabled"
		if f.disabled {
			state = "disabled"
		}
		return []byte("disabled services = {\n\t\"com.apple.Other\" => disabled\n\t\"" + launchdLabel + "\" => " + state + "\n}\n"), nil, nil
	case len(args) == 2 && args[0] == "enable" && args[1] == target:
		f.disabled = false
		return nil, nil, nil
	case len(args) == 3 && args[0] == "bootstrap" && args[1] == domain && args[2] == plistPath:
		if f.plist != nil || f.bootstrapFailNo > 0 {
			f.bootstrapFailNo--
			return nil, []byte("Bootstrap failed: 5: Input/output error"), errExit
		}
		data, err := os.ReadFile(plistPath)
		if err != nil {
			return nil, []byte("Bootstrap failed: 2: No such file or directory"), errExit
		}
		f.plist = data
		return nil, nil, f.start((&launchd{}).argv(data))
	case len(args) == 2 && args[0] == "bootout" && args[1] == target:
		if f.plist == nil {
			return nil, []byte("Boot-out failed: 3: No such process"), errExit
		}
		f.plist, f.proc = nil, nil
		return nil, nil, nil
	case len(args) == 3 && args[0] == "kickstart" && args[1] == "-k" && args[2] == target:
		return nil, nil, f.start((&launchd{}).argv(f.plist))
	}
	return nil, []byte("unexpected launchctl " + strings.Join(args, " ")), errExit
}

// launchdPrint is `launchctl print` of a loaded agent, in its own
// layout: the agent's properties one tab in, its sub-sections deeper,
// where a "state" of their own must not be read for the agent's.
func (f *fakeSystem) launchdPrint() string {
	state, pid, exit := "not running", "", "1"
	switch {
	case f.proc != nil:
		state, pid, exit = "running", "\tpid = "+strconv.Itoa(f.proc.pid)+"\n", "(never exited)"
	case !f.failed:
		exit = "0"
	}
	return "gui/" + strconv.Itoa(f.uid) + "/" + launchdLabel + " = {\n" +
		"\tactive count = 1\n" +
		"\tpath = " + filepath.Join(f.home, "Library", "LaunchAgents", launchdLabel+".plist") + "\n" +
		"\ttype = LaunchAgent\n" +
		"\tstate = " + state + "\n" +
		"\n\tprogram = /opt/fd/flightdeck\n" +
		pid +
		"\tlast exit code = " + exit + "\n" +
		"\tendpoints = {\n\t\tstate = active\n\t\tpid = 1\n\t}\n" +
		"}\n"
}

// answers is the stand-in health check: the simulated binary answers on
// its listen address.
func (f *fakeSystem) answers(_ context.Context, listen string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.proc != nil && f.proc.listen == listen {
		return "http://" + listen, nil
	}
	return "", fmt.Errorf("http://%s/api/health: connection refused", listen)
}

// testEnv is one run's IO against a stand-in system, with what it
// printed.
type testEnv struct {
	rt     IO
	sys    *fakeSystem
	stdout *bytes.Buffer
	stderr *bytes.Buffer
	env    map[string]string
	binary string
}

// newTestEnv is a user on goos with a home of its own, a flightdeck
// binary in ~/bin, nothing installed and the stand-in manager.
func newTestEnv(t *testing.T, goos string) *testEnv {
	t.Helper()
	home := t.TempDir()
	te := &testEnv{sys: newFakeSystem(t, home), stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}, env: map[string]string{}}
	te.binary = filepath.Join(home, "bin", "flightdeck")
	if err := os.MkdirAll(filepath.Dir(te.binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(te.binary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	te.rt = IO{
		Stdout:       te.stdout,
		Stderr:       te.stderr,
		Getenv:       func(k string) string { return te.env[k] },
		GOOS:         goos,
		Home:         home,
		UID:          te.sys.uid,
		EUID:         te.sys.uid,
		User:         "ada",
		TempDir:      filepath.Join(home, "tmp"),
		Executable:   func() (string, error) { return te.binary, nil },
		Run:          te.sys.run,
		Answers:      te.sys.answers,
		ReadyTimeout: 5 * time.Second,
		PollInterval: 5 * time.Millisecond,
	}
	return te
}

// main runs `flightdeck service <args>` and returns its exit status.
func (te *testEnv) main(args ...string) int {
	te.stdout.Reset()
	te.stderr.Reset()
	return Main(context.Background(), args, te.rt)
}

func (te *testEnv) output() string { return te.stdout.String() + te.stderr.String() }

func (te *testEnv) dataDir(name string) string { return filepath.Join(te.rt.Home, name) }

// freePort returns a port nothing listens on now.
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	return port
}
