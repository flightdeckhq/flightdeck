// Package config provides configuration for the ingestion API.
// All values are read from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all configuration for the ingestion API service.
type Config struct {
	Port                string
	PostgresURL         string
	NatsURL             string
	Env                 string
	ShutdownTimeoutSecs int
	// RateLimitPerMinute is the per-token sliding window cap on
	// POST /v1/events and POST /v1/heartbeat. Defaults to
	// handlers.DefaultRateLimitPerMinute (1000); the dev compose
	// override sets it high so the integration test suite -- which
	// shares one token across 50+ back-to-back tests -- never trips
	// the limit. Production deployments that do not set
	// FLIGHTDECK_RATE_LIMIT_PER_MINUTE inherit the default and behave
	// exactly as before.
	RateLimitPerMinute int
	// GenAIClaimInterval is how often the OTLP GenAI assembler claims
	// due traces, from FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS. Zero, the
	// default, keeps assembler.ClaimInterval (one second). It exists so
	// an integration run can claim faster; it is not a tuning knob, and
	// the Helm chart does not set it.
	GenAIClaimInterval time.Duration
}

// MinGenAIClaimInterval is the shortest claim interval
// FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS may set. Every replica claims on
// this interval against the shared database, so a mistyped value of a
// few milliseconds would turn each replica into a tight query loop;
// 50 ms is already twenty claims a second per replica, faster than any
// integration run needs, since a trace is due no sooner than 3 seconds
// after its root.
const MinGenAIClaimInterval = 50 * time.Millisecond

// Load reads configuration from environment variables.
// Panics on missing required values -- fail fast on misconfiguration.
func Load() Config {
	cfg := Config{
		Port:                envOrDefault("FLIGHTDECK_PORT", "8080"),
		PostgresURL:         envRequired("FLIGHTDECK_POSTGRES_URL"),
		NatsURL:             envOrDefault("FLIGHTDECK_NATS_URL", "nats://nats:4222"),
		Env:                 envOrDefault("FLIGHTDECK_ENV", "development"),
		ShutdownTimeoutSecs: envIntOrDefault("SHUTDOWN_TIMEOUT_SECS", 30),
		RateLimitPerMinute:  envIntOrDefault("FLIGHTDECK_RATE_LIMIT_PER_MINUTE", 1000),
		GenAIClaimInterval:  time.Duration(envIntOrDefault("FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS", 0)) * time.Millisecond,
	}
	if cfg.GenAIClaimInterval != 0 && cfg.GenAIClaimInterval < MinGenAIClaimInterval {
		panic(fmt.Sprintf("environment variable FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS must be 0 (the default) or at least %d",
			MinGenAIClaimInterval.Milliseconds()))
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
