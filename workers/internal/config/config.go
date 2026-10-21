// Package config provides configuration for the Go event processing workers.
// All values are read from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
)

// maxReconcilerIntervalSecs caps the reconciler period at an hour: the
// reconciler enforces thresholds of minutes (stale) to a day (orphan
// timeout), so a longer period cannot be intended and would leave
// silent sessions unreconciled for hours; a value above it is read as
// a typo and refused at startup rather than honoured silently.
const maxReconcilerIntervalSecs = 3600

// Config holds all configuration for the worker service.
type Config struct {
	PostgresURL         string
	NatsURL             string
	WorkerPoolSize      int
	ShutdownTimeoutSecs int
	MigrationsDir       string
	// OrphanTimeoutHours is the silence window before the reconciler
	// transitions a `lost` session to `closed` with
	// close_reason="orphan_timeout". The plugin's SessionEnd /
	// sensor's shutdown is the happy path; the reaper is the safety
	// net for crashes / missed lifecycle hooks. Default 24 hours
	// gives plenty of headroom for legitimate long pauses while still
	// reaping dead rows within an operational day.
	//
	// Env: FLIGHTDECK_ORPHAN_TIMEOUT_HOURS. Must be > 0 — a zero or
	// negative value would close every `lost` row on the next tick
	// regardless of age, defeating the safety-net intent. Load()
	// panics if the configured value is non-positive.
	OrphanTimeoutHours int
	// ReconcilerIntervalSecs is the period of the background
	// reconciler tick. Each tick runs one pass that moves silent
	// sessions active → stale (2 minutes of silence) and stale → lost
	// (30 minutes), then closes `lost` rows older than
	// OrphanTimeoutHours. Default 60 seconds: the thresholds it
	// enforces are minutes to hours long, so a finer tick cannot make
	// a transition land meaningfully sooner in production and only
	// adds one more sweep of the sessions table per tick. The dev
	// stack sets it low (docker/docker-compose.dev.yml) so the
	// integration tests that wait for a tick finish in seconds
	// instead of idling for most of a minute each.
	//
	// Env: FLIGHTDECK_RECONCILER_INTERVAL_SECS. Must be between 1 and
	// maxReconcilerIntervalSecs — the ticker cannot run on a zero or
	// negative period, a reconciler that never ticks would leave every
	// silent session pinned as `active` forever, and a period above an
	// hour is a typo (see the constant). Load() panics on a value
	// outside that range.
	ReconcilerIntervalSecs int
}

// Load reads configuration from environment variables.
// Panics on missing required values -- fail fast on misconfiguration.
func Load() Config {
	cfg := Config{
		PostgresURL:            envRequired("FLIGHTDECK_POSTGRES_URL"),
		NatsURL:                envOrDefault("FLIGHTDECK_NATS_URL", "nats://nats:4222"),
		WorkerPoolSize:         envIntOrDefault("FLIGHTDECK_WORKER_POOL_SIZE", 10),
		ShutdownTimeoutSecs:    envIntOrDefault("SHUTDOWN_TIMEOUT_SECS", 30),
		MigrationsDir:          envOrDefault("FLIGHTDECK_MIGRATIONS_DIR", "/migrations"),
		OrphanTimeoutHours:     envIntOrDefault("FLIGHTDECK_ORPHAN_TIMEOUT_HOURS", 24),
		ReconcilerIntervalSecs: envIntOrDefault("FLIGHTDECK_RECONCILER_INTERVAL_SECS", 60),
	}
	if cfg.OrphanTimeoutHours <= 0 {
		panic(fmt.Sprintf(
			"FLIGHTDECK_ORPHAN_TIMEOUT_HOURS must be > 0, got %d -- "+
				"a non-positive value would close every `lost` session on "+
				"the next reconciler tick regardless of age",
			cfg.OrphanTimeoutHours,
		))
	}
	if cfg.ReconcilerIntervalSecs > maxReconcilerIntervalSecs {
		panic(fmt.Sprintf(
			"FLIGHTDECK_RECONCILER_INTERVAL_SECS must be at most %d, got %d -- "+
				"a longer interval would leave stale and lost sessions "+
				"unreconciled for hours, which reads as a typo, not a choice",
			maxReconcilerIntervalSecs, cfg.ReconcilerIntervalSecs,
		))
	}
	if cfg.ReconcilerIntervalSecs <= 0 {
		panic(fmt.Sprintf(
			"FLIGHTDECK_RECONCILER_INTERVAL_SECS must be > 0, got %d -- "+
				"the reconciler ticker cannot run on a non-positive period "+
				"and silent sessions would never be marked stale or lost",
			cfg.ReconcilerIntervalSecs,
		))
	}
	return cfg
}

func envRequired(key string) string {
	val := os.Getenv(key)
	if val == "" {
		panic(fmt.Sprintf("required environment variable %s is not set", key))
	}
	return val
}

func envOrDefault(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func envIntOrDefault(key string, defaultVal int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(raw)
	if err != nil {
		panic(fmt.Sprintf("environment variable %s must be an integer, got %q", key, raw))
	}
	return val
}
