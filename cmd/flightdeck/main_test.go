package main

import (
	"errors"
	"net/http"
	"os"
	"testing"

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
	opts := cli.Options{DatabaseURL: "postgres://x/db"}

	if err := setServiceEnv(opts, true, secrets); err != nil {
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
	if err := setServiceEnv(opts, false, secrets); err != nil {
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
	if code := run(nil, devnull, devnull); code != 2 {
		t.Fatalf("no database: exit %d, want 2", code)
	}
	if code := run([]string{"--version"}, devnull, devnull); code != 0 {
		t.Fatalf("--version: exit %d, want 0", code)
	}
	if code := run([]string{"-h"}, devnull, devnull); code != 0 {
		t.Fatalf("-h: exit %d, want 0", code)
	}
}
