package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/internal/cli"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	background "github.com/flightdeckhq/flightdeck/internal/service"
)

// stubService makes serviceRunning answer c, pid and ok for the test.
func stubService(t *testing.T, c background.Config, pid int, ok bool) {
	t.Helper()
	saved := serviceRunning
	serviceRunning = func(context.Context) (background.Config, int, bool) { return c, pid, ok }
	t.Cleanup(func() { serviceRunning = saved })
}

func TestSameInstance_ThePortOrTheDataDir(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	c := background.Config{Listen: "127.0.0.1:4000", DataDir: dir}
	for _, tc := range []struct {
		name string
		opts cli.Options
		want bool
	}{
		{"the same port", cli.Options{Listen: "127.0.0.1:4000", DataDir: t.TempDir()}, true},
		{"the same port on every interface", cli.Options{Listen: "0.0.0.0:4000", DataDir: t.TempDir()}, true},
		{"the same data dir through a link", cli.Options{Listen: "127.0.0.1:4100", DataDir: link}, true},
		{"neither", cli.Options{Listen: "127.0.0.1:4100", DataDir: t.TempDir()}, false},
	} {
		if got := sameInstance(c, tc.opts); got != tc.want {
			t.Errorf("%s: sameInstance = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestAsService_OnlyWhenTheRunningServiceHoldsIt(t *testing.T) {
	refused := errors.New("127.0.0.1:4000 is already in use")
	opts := cli.Options{Listen: "127.0.0.1:4000", DataDir: t.TempDir()}
	svc := background.Config{Listen: "127.0.0.1:4000", DataDir: t.TempDir()}

	stubService(t, svc, 1234, true)
	var conflict *serviceConflictError
	if err := asService(refused, opts); !errors.As(err, &conflict) || !errors.Is(err, refused) || err.Error() != refused.Error() {
		t.Errorf("the service on the port: %v", err)
	}
	withDomain := opts
	withDomain.Domain = "fd.example.com"
	if err := asService(refused, withDomain); errors.As(err, &conflict) {
		t.Error("--domain binds its own ports, yet the conflict was put on the service")
	}

	stubService(t, svc, os.Getpid(), true)
	if err := asService(refused, opts); errors.As(err, &conflict) {
		t.Error("the service's own process was told that the service runs")
	}
	stubService(t, background.Config{Listen: "127.0.0.1:4100", DataDir: t.TempDir()}, 1234, true)
	if err := asService(refused, opts); errors.As(err, &conflict) {
		t.Error("a service on another port and data dir was blamed")
	}
	stubService(t, background.Config{}, 0, false)
	if err := asService(refused, opts); errors.As(err, &conflict) {
		t.Error("no service runs, yet the conflict was put on one")
	}
}

// A start refused by the service's port says that the service runs, then
// gives the refusal itself.
func TestRun_SaysTheServiceHoldsThePort(t *testing.T) {
	for _, k := range []string{"FLIGHTDECK_LISTEN", "FLIGHTDECK_PORT", "FLIGHTDECK_PUBLIC", "FLIGHTDECK_DATABASE_URL",
		"FLIGHTDECK_DATABASE_URL_FILE", "FLIGHTDECK_DASHBOARD_TOKEN", "FLIGHTDECK_DASHBOARD_TOKEN_FILE", "FLIGHTDECK_DOMAIN"} {
		t.Setenv(k, "")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	stubService(t, background.Config{Listen: "127.0.0.1:" + port, DataDir: t.TempDir()}, 1234, true)

	stderr, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stderr.Close() }()
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = devnull.Close() }()
	data := filepath.Join(t.TempDir(), "data")
	if code := run([]string{"--port", port, "--data-dir", data}, devnull, stderr); code != 1 {
		t.Fatalf("a start on the service's port exited %d, want 1", code)
	}
	out, _ := os.ReadFile(stderr.Name())
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 || lines[0] != "flightdeck: "+serviceRunningLine || !strings.Contains(lines[1], "already in use") {
		t.Errorf("stderr is:\n%s", out)
	}
	if _, err := os.Stat(data); !os.IsNotExist(err) {
		t.Errorf("the refused start created its data dir (%v)", err)
	}
}

// The same on the data dir's lock, the case of a second instance on the
// default data dir and another port.
func TestServeAll_SaysTheServiceHoldsTheDataDir(t *testing.T) {
	t.Setenv("FLIGHTDECK_DASHBOARD_TOKEN", "")
	t.Setenv("FLIGHTDECK_DASHBOARD_TOKEN_FILE", "")
	data := t.TempDir()
	layout, err := datadir.Ensure(data)
	if err != nil {
		t.Fatal(err)
	}
	lock, err := datadir.Acquire(layout.Lock)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	stubService(t, background.Config{Listen: "127.0.0.1:1", DataDir: data}, 1234, true)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = devnull.Close() }()
	err = serveAll(cli.Options{Listen: addr, DataDir: data}, devnull)
	var conflict *serviceConflictError
	if !errors.As(err, &conflict) || !strings.Contains(err.Error(), "is in use by another flightdeck") {
		t.Errorf("serveAll on the service's data dir: %v", err)
	}
}

func TestRun_TheServiceCommandIsDispatched(t *testing.T) {
	out, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = out.Close() }()
	if code := run([]string{"service", "--help"}, out, out); code != 0 {
		t.Fatalf("flightdeck service --help exited %d", code)
	}
	if code := run([]string{"service"}, out, out); code != 2 {
		t.Fatalf("flightdeck service with no command exited %d, want 2", code)
	}
	text, _ := os.ReadFile(out.Name())
	if !strings.Contains(string(text), "Usage: flightdeck service install") {
		t.Errorf("the usage is not printed:\n%s", text)
	}
}
