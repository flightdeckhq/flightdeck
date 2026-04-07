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
}

// Load reads configuration from environment variables.
// Panics on missing required values -- fail fast on misconfiguration.
func Load() Config {
	cfg := Config{
		PostgresURL:         envRequired("FLIGHTDECK_POSTGRES_URL"),
		NatsURL:             envOrDefault("FLIGHTDECK_NATS_URL", "nats://nats:4222"),
		WorkerPoolSize:      envIntOrDefault("FLIGHTDECK_WORKER_POOL_SIZE", 10),
		ShutdownTimeoutSecs: envIntOrDefault("SHUTDOWN_TIMEOUT_SECS", 30),
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
