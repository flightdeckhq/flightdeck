// Package config provides configuration for the query API.
// All values are read from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds all configuration for the query API service.
type Config struct {
	Port                string
	PostgresURL         string
	Env                 string
	JWTSecret           string
	AdminEmail          string
	AdminPassword       string
	ShutdownTimeoutSecs int
	CORSOrigin          string
}

// Load reads configuration from environment variables.
// Panics on missing required values -- fail fast on misconfiguration.
//
// JWTSecret, AdminEmail, and AdminPassword are scaffolding for a
// dashboard-side login flow that is not implemented in v0.3.0. No
// handler, middleware, or dashboard component reads them. They are
// kept as optional fields so the plumbing (env wiring, Helm chart
// Secret, future login handler) survives the v0.3.0 cut; no panic
// gate because panicking for a feature that does not exist would
// only misdirect operators. See README "Self-hosting" and DECISIONS
// for the v0.3.0 auth posture (bearer ftd_ tokens only).
func Load() Config {
	env := envOrDefault("FLIGHTDECK_ENV", "development")
	cfg := Config{
		Port:                envOrDefault("FLIGHTDECK_PORT", "8081"),
		PostgresURL:         envRequired("FLIGHTDECK_POSTGRES_URL"),
		Env:                 env,
		JWTSecret:           os.Getenv("FLIGHTDECK_JWT_SECRET"),
		AdminEmail:          os.Getenv("FLIGHTDECK_ADMIN_EMAIL"),
		AdminPassword:       os.Getenv("FLIGHTDECK_ADMIN_PASSWORD"),
		ShutdownTimeoutSecs: envIntOrDefault("SHUTDOWN_TIMEOUT_SECS", 30),
		CORSOrigin:          envOrDefault("FLIGHTDECK_CORS_ORIGIN", "*"),
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
