// Package config provides configuration for the Go event processing workers.
// All values are read from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
)

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
}

// Load reads configuration from environment variables.
// Panics on missing required values -- fail fast on misconfiguration.
func Load() Config {
	cfg := Config{
		PostgresURL:         envRequired("FLIGHTDECK_POSTGRES_URL"),
		NatsURL:             envOrDefault("FLIGHTDECK_NATS_URL", "nats://nats:4222"),
		WorkerPoolSize:      envIntOrDefault("FLIGHTDECK_WORKER_POOL_SIZE", 10),
		ShutdownTimeoutSecs: envIntOrDefault("SHUTDOWN_TIMEOUT_SECS", 30),
		MigrationsDir:       envOrDefault("FLIGHTDECK_MIGRATIONS_DIR", "/migrations"),
		OrphanTimeoutHours:  envIntOrDefault("FLIGHTDECK_ORPHAN_TIMEOUT_HOURS", 24),
	}
	if cfg.OrphanTimeoutHours <= 0 {
		panic(fmt.Sprintf(
			"FLIGHTDECK_ORPHAN_TIMEOUT_HOURS must be > 0, got %d -- "+
				"a non-positive value would close every `lost` session on "+
				"the next reconciler tick regardless of age",
			cfg.OrphanTimeoutHours,
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
