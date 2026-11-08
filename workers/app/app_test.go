package app

import (
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/config"
)

func TestDefaultConfig_MatchesTheEnvironmentDefaults(t *testing.T) {
	c := DefaultConfig()
	if c.WorkerPoolSize != 10 || c.ReconcilerInterval != time.Minute || c.OrphanTimeout != 24*time.Hour ||
		c.MigrationsDir != "/migrations" || c.ShutdownTimeout != 30*time.Second || c.MetricsPort != 0 {
		t.Fatalf("%+v", c)
	}
}

func TestFromEnv_MapsEveryField(t *testing.T) {
	c := FromEnv(config.Config{
		PostgresURL: "postgres://x", NatsURL: "nats://y", WorkerPoolSize: 3, ShutdownTimeoutSecs: 20,
		MigrationsDir: "/m", OrphanTimeoutHours: 2, ReconcilerIntervalSecs: 5, MetricsPort: 9102,
	})
	want := Config{
		PostgresURL: "postgres://x", NatsURL: "nats://y", WorkerPoolSize: 3, ReconcilerInterval: 5 * time.Second,
		OrphanTimeout: 2 * time.Hour, MigrationsDir: "/m", MetricsPort: 9102, ShutdownTimeout: 20 * time.Second,
	}
	if c != want {
		t.Fatalf("got %+v\nwant %+v", c, want)
	}
}

func TestLoadEnv_ReturnsTheEnvironmentsRefusalAsAnError(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "")
	if _, err := LoadEnv(); err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_POSTGRES_URL") {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://x")
	t.Setenv("FLIGHTDECK_RECONCILER_INTERVAL_SECS", "0")
	if _, err := LoadEnv(); err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_RECONCILER_INTERVAL_SECS") {
		t.Fatalf("err = %v", err)
	}
}

func TestMigrate_EmbeddedSourceAgainstAnInvalidURL(t *testing.T) {
	fsys := fstest.MapFS{
		"000001_init.up.sql":   {Data: []byte("SELECT 1;")},
		"000001_init.down.sql": {Data: []byte("SELECT 1;")},
	}
	err := Migrate(Config{PostgresURL: "not a database url"}, Deps{Migrations: fsys})
	if err == nil || !strings.Contains(err.Error(), "database migration") {
		t.Fatalf("err = %v", err)
	}
	// Without an embedded source the directory is read, and a missing
	// one is an error too.
	err = Migrate(Config{PostgresURL: "not a database url", MigrationsDir: t.TempDir() + "/none"}, Deps{})
	if err == nil {
		t.Fatal("want an error for a missing migrations directory")
	}
}
