package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/cli"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

func TestMaskURL(t *testing.T) {
	cases := map[string]string{
		"postgres://flightdeck:flightdeck_dev@localhost:5432/fd?sslmode=disable": "postgres://flightdeck:***@localhost:5432/fd?sslmode=disable",
		"postgres://flightdeck@localhost/fd":                                     "postgres://flightdeck@localhost/fd",
		"nats://tok3n@nats:4222":                                                 "nats://tok3n@nats:4222",
		"not a url at all":                                                       "not a url at all",
	}
	for in, want := range cases {
		if got := maskURL(in); got != want {
			t.Errorf("maskURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPublicURL(t *testing.T) {
	host, _ := os.Hostname()
	cases := []struct {
		opts cli.Options
		want string
	}{
		{cli.Options{Listen: "127.0.0.1:4000"}, "http://localhost:4000"},
		{cli.Options{Listen: "localhost:4100"}, "http://localhost:4100"},
		{cli.Options{Listen: ":4000"}, "http://" + host + ":4000"},
		{cli.Options{Listen: "0.0.0.0:4000"}, "http://" + host + ":4000"},
		{cli.Options{Listen: "10.0.0.5:4000"}, "http://10.0.0.5:4000"},
		{cli.Options{Listen: ":4000", Domain: "fd.example.com"}, "https://fd.example.com"},
	}
	for _, c := range cases {
		if got := publicURL(c.opts); got != c.want {
			t.Errorf("publicURL(%+v) = %q, want %q", c.opts, got, c.want)
		}
	}
}

func TestSetServiceEnv_DevAndProductionModes(t *testing.T) {
	for _, k := range []string{"FLIGHTDECK_POSTGRES_URL", "FLIGHTDECK_NATS_URL", "FLIGHTDECK_JWT_SECRET",
		"ENVIRONMENT", "FLIGHTDECK_METRICS_PORT", "FLIGHTDECK_MIGRATIONS_DIR"} {
		t.Setenv(k, "inherited")
	}
	secrets := &datadir.Secrets{JWTSecret: "abc"}
	opts := cli.Options{}

	if err := setServiceEnv(opts, "postgres://x/db", true, secrets); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"FLIGHTDECK_POSTGRES_URL":   "postgres://x/db",
		"FLIGHTDECK_NATS_URL":       "inherited", // untouched: the embedded bus is injected
		"FLIGHTDECK_JWT_SECRET":     "abc",
		"ENVIRONMENT":               "dev",
		"FLIGHTDECK_METRICS_PORT":   "0",
		"FLIGHTDECK_MIGRATIONS_DIR": "",
	}
	for k, v := range want {
		if got := os.Getenv(k); got != v {
			t.Errorf("dev: %s = %q, want %q", k, got, v)
		}
	}

	opts.NatsURL = "nats://external:4222"
	opts.Metrics = true
	if err := setServiceEnv(opts, "sqlite:///data/flightdeck.db", false, secrets); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("ENVIRONMENT"); got != "" {
		t.Errorf("production: ENVIRONMENT = %q, want unset", got)
	}
	if got := os.Getenv("FLIGHTDECK_METRICS_PORT"); got != "" {
		t.Errorf("production with --metrics: FLIGHTDECK_METRICS_PORT = %q, want unset so each default applies", got)
	}
	if got := os.Getenv("FLIGHTDECK_NATS_URL"); got != "nats://external:4222" {
		t.Errorf("FLIGHTDECK_NATS_URL = %q", got)
	}
	// The services' database variable carries the URL of either backend.
	if got := os.Getenv("FLIGHTDECK_POSTGRES_URL"); got != "sqlite:///data/flightdeck.db" {
		t.Errorf("FLIGHTDECK_POSTGRES_URL = %q", got)
	}
}

func TestUseUTC(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Jerusalem")
	if err != nil {
		t.Skip("no zone database")
	}
	previous := time.Local
	defer func() { time.Local = previous }()
	time.Local = loc
	useUTC()
	if got := time.Now().Format(time.RFC3339); !strings.HasSuffix(got, "Z") {
		t.Fatalf("time.Now() formats as %q, want a UTC Z suffix", got)
	}
}

func TestServeErr(t *testing.T) {
	if serveErr("x", nil) != nil || serveErr("x", http.ErrServerClosed) != nil {
		t.Fatal("a closed server is not an error")
	}
	err := serveErr("https", errors.New("boom"))
	if err == nil || err.Error() != "https server: boom" {
		t.Fatalf("%v", err)
	}
}

func TestRun_UsageErrorsExitTwo(t *testing.T) {
	t.Setenv("FLIGHTDECK_DATABASE_URL", "")
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = devnull.Close() }()
	if code := run([]string{"--database-url", "mysql://u:p@h/db"}, devnull, devnull); code != 2 {
		t.Fatalf("a database of no supported kind: exit %d, want 2", code)
	}
	if code := run([]string{"serve"}, devnull, devnull); code != 2 {
		t.Fatalf("a stray argument: exit %d, want 2", code)
	}
	if code := run([]string{"--version"}, devnull, devnull); code != 0 {
		t.Fatalf("--version: exit %d, want 0", code)
	}
	if code := run([]string{"-h"}, devnull, devnull); code != 0 {
		t.Fatalf("-h: exit %d, want 0", code)
	}
}

// fakeService records when its context was cancelled and blocks until
// then (or returns the error it was given at once).
type fakeService struct {
	name      string
	cancelled atomic.Int64 // UnixNano of the cancellation, 0 until then
	fail      error
}

func (f *fakeService) run(ctx context.Context) error {
	if f.fail != nil {
		return f.fail
	}
	<-ctx.Done()
	f.cancelled.Store(time.Now().UnixNano())
	return nil
}

func TestSupervise_DrainsHTTPBeforeCancellingTheServices(t *testing.T) {
	a, b := &fakeService{name: "a"}, &fakeService{name: "b"}
	var drained atomic.Int64
	shutdownHTTP := func(context.Context) error {
		// The services must still be running while the drain happens.
		if a.cancelled.Load() != 0 || b.cancelled.Load() != 0 {
			t.Error("a service was cancelled before the HTTP drain")
		}
		drained.Store(time.Now().UnixNano())
		return nil
	}
	serveStarted := make(chan struct{})
	serveFn := func() error {
		close(serveStarted)
		select {} // a server blocks until Shutdown; the fake never returns
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- supervise(ctx, []service{{"a", a.run}, {"b", b.run}}, []func() error{serveFn}, shutdownHTTP, 5*time.Second)
	}()
	<-serveStarted
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a stop on ctx returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("supervise did not return")
	}
	if drained.Load() == 0 || a.cancelled.Load() == 0 || b.cancelled.Load() == 0 {
		t.Fatalf("drain=%d a=%d b=%d: every step must have run", drained.Load(), a.cancelled.Load(), b.cancelled.Load())
	}
	if a.cancelled.Load() < drained.Load() || b.cancelled.Load() < drained.Load() {
		t.Fatal("services were cancelled before the HTTP drain finished")
	}
}

func TestSupervise_AServiceFailureDrainsHTTPThenStopsTheRest(t *testing.T) {
	boom := errors.New("consumer setup: stream gone")
	bad, good := &fakeService{name: "bad", fail: boom}, &fakeService{name: "good"}
	var drained atomic.Bool
	shutdownHTTP := func(context.Context) error {
		if good.cancelled.Load() != 0 {
			t.Error("the healthy service was cancelled before the HTTP drain")
		}
		drained.Store(true)
		return nil
	}
	serveFn := func() error { select {} }
	err := supervise(context.Background(), []service{{"bad", bad.run}, {"good", good.run}}, []func() error{serveFn}, shutdownHTTP, 5*time.Second)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the failing service's error", err)
	}
	if !drained.Load() || good.cancelled.Load() == 0 {
		t.Fatalf("drained=%v good cancelled=%d", drained.Load(), good.cancelled.Load())
	}
}

func TestSupervise_AnHTTPServerFailureStopsTheServices(t *testing.T) {
	svc := &fakeService{name: "svc"}
	serveFn := func() error { return errors.New("https server: tls handshake listener closed") }
	err := supervise(context.Background(), []service{{"svc", svc.run}}, []func() error{serveFn}, func(context.Context) error { return nil }, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "https server") {
		t.Fatalf("err = %v", err)
	}
	if svc.cancelled.Load() == 0 {
		t.Fatal("the service was not stopped after the server failed")
	}
}

func TestBind_PlainModeBindsTheListenAddress(t *testing.T) {
	lns, err := bind(cli.Options{Listen: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	defer lns.closeAll()
	if lns.plain == nil || lns.https != nil || lns.redirect != nil {
		t.Fatalf("%+v", lns)
	}
	busy := lns.plain.Addr().String()
	if _, err := bind(cli.Options{Listen: busy}); err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("second bind of %s: %v", busy, err)
	}
}
