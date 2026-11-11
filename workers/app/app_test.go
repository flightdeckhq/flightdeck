package app

import (
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/config"
)

func TestFromEnv_MapsEveryField(t *testing.T) {
	c := fromEnv(config.Config{
		PostgresURL: "postgres://x", NatsURL: "nats://y", WorkerPoolSize: 3, ShutdownTimeoutSecs: 20,
		OrphanTimeoutHours: 2, ReconcilerIntervalSecs: 5, MetricsPort: 9102,
	})
	want := Config{
		PostgresURL: "postgres://x", NatsURL: "nats://y", WorkerPoolSize: 3, ReconcilerInterval: 5 * time.Second,
		OrphanTimeout: 2 * time.Hour, MetricsPort: 9102, ShutdownTimeout: 20 * time.Second,
	}
	if c != want {
		t.Fatalf("got %+v\nwant %+v", c, want)
	}
}

func TestLoadEnv_CarriesTheEnvironmentDefaults(t *testing.T) {
	for _, k := range []string{"FLIGHTDECK_NATS_URL", "FLIGHTDECK_WORKER_POOL_SIZE", "FLIGHTDECK_RECONCILER_INTERVAL_SECS",
		"FLIGHTDECK_ORPHAN_TIMEOUT_HOURS", "FLIGHTDECK_METRICS_PORT", "SHUTDOWN_TIMEOUT_SECS"} {
		t.Setenv(k, "")
	}
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://x")
	c, err := LoadEnv()
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		PostgresURL: "postgres://x", NatsURL: "nats://nats:4222", WorkerPoolSize: 10, ReconcilerInterval: time.Minute,
		OrphanTimeout: 24 * time.Hour, MetricsPort: 9102, ShutdownTimeout: 30 * time.Second,
	}
	if c != want {
		t.Fatalf("got %+v\nwant %+v", c, want)
	}
}

func TestLoadEnv_ReturnsTheEnvironmentsRefusalAsAnError(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "")
	if _, err := LoadEnv(); err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_POSTGRES") {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://x")
	t.Setenv("FLIGHTDECK_RECONCILER_INTERVAL_SECS", "0")
	if _, err := LoadEnv(); err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_RECONCILER_INTERVAL_SECS") {
		t.Fatalf("err = %v", err)
	}
}

// A URL that names no backend is refused before anything is opened.
func TestMigrate_RefusesAnUnsupportedURL(t *testing.T) {
	err := Migrate(Config{PostgresURL: "not a database url"}, Deps{})
	if err == nil || !strings.Contains(err.Error(), "database migration") {
		t.Fatalf("err = %v", err)
	}
	// A Postgres nobody listens on is refused by the migrator itself.
	err = Migrate(Config{PostgresURL: "postgres://u:p@127.0.0.1:1/x?sslmode=disable&connect_timeout=1"}, Deps{})
	if err == nil || !strings.Contains(err.Error(), "database migration") {
		t.Fatalf("err = %v", err)
	}
}

// DatabaseURL is the URL a caller that shares one handle with the
// workers opens it with: the lock timeout on Postgres, a SQLite URL
// byte for byte (its path is verbatim; re-encoding it would name
// another file).
func TestDatabaseURL_AddsTheLockTimeoutOnPostgresOnly(t *testing.T) {
	got, err := DatabaseURL("postgres://u:p@h/db?sslmode=disable")
	if err != nil || !strings.Contains(got, "lock_timeout=8000") || !strings.Contains(got, "sslmode=disable") {
		t.Fatalf("DatabaseURL = %q, %v", got, err)
	}
	for _, same := range []string{
		"sqlite:///home/o m/a#b/x?y/50%/flightdeck.db",
		`sqlite://C:\Users\omria\AppData\Local\flightdeck\flightdeck.db`,
	} {
		if got, err := DatabaseURL(same); err != nil || got != same {
			t.Errorf("DatabaseURL(%q) = %q, %v; want it unchanged", same, got, err)
		}
	}
	if _, err := DatabaseURL("mysql://u:p@h/db"); err == nil {
		t.Error("a URL of no supported backend must be refused")
	}
}
