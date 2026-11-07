// Package config provides configuration for the ingestion API.
// All values are read from environment variables.
package config

import (
	"fmt"
	"math"
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
	// StreamMaxAge, StreamMaxBytes and StreamReplicas are the limits
	// and the replica count ingestion keeps the FLIGHTDECK JetStream
	// stream at (see the nats package), from
	// FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS,
	// FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB and
	// FLIGHTDECK_NATS_STREAM_REPLICAS. Load() panics on a value outside
	// the bounds the constants below state.
	StreamMaxAge   time.Duration
	StreamMaxBytes int64
	StreamReplicas int
	// MetricsPort is the port of the metrics listener, which serves the
	// request-latency histogram at /metrics. Zero turns the listener
	// off.
	//
	// Env: FLIGHTDECK_METRICS_PORT (default DefaultMetricsPort). Load()
	// panics on a value outside 0..maxPort.
	MetricsPort int
}

// DefaultMetricsPort is where the ingestion API serves /metrics. It is
// a listener of its own, never the API port, because the endpoint
// carries no auth and the API port is the one the edge publishes. 9103
// follows the workers' 9102 in the range Prometheus exporters use, so
// the services can share one host's network without a clash; the query
// API takes 9104.
const DefaultMetricsPort = 9103

// maxPort is the highest TCP port number.
const maxPort = 65535

// DefaultStreamMaxAgeHours is how long the FLIGHTDECK stream keeps a
// message. The stream's retention is by limits, so this is also how
// long the workers can be down before the events published at the
// start of the outage are removed unprocessed. 72 hours covers a
// workers outage that starts on a Friday evening and is fixed on
// Monday morning (about 64 hours). A processed message is never read
// again, so keeping messages longer only costs disk.
const DefaultStreamMaxAgeHours = 72

// MinStreamMaxAgeHours is the shortest max age the stream may be
// given. A workers restart or deploy takes minutes; an age limit below
// an hour would let a routine outage, or a backlog after one, remove
// events before they are processed.
const MinStreamMaxAgeHours = 1

// DefaultStreamMaxSizeMiB is the most the FLIGHTDECK stream stores on
// each NATS server, in MiB (5 GiB). Events average about 2 KiB on the
// wire (the dev stack's stream held 691,171 events in 1.4 GB), so
// 5 GiB holds about 2.6 million events: 72 hours of a sustained 10
// events a second, the age limit's window for a busy fleet. It bounds
// the NATS store on a single compose host, where the stream shares the
// disk with Postgres, to a size any host running the stack can spare.
// The Helm chart sets its own value to fit its NATS volume.
const DefaultStreamMaxSizeMiB = 5120

// MinStreamMaxSizeMiB is the smallest max size the stream may be
// given, in MiB. 64 MiB holds about 30,000 events of the typical 2 KiB,
// but only 64 events of NATS's 1 MiB maximum. Anything smaller reads as
// a unit mistake (a size in GiB typed into a MiB setting) and would
// leave room for a handful of large events.
const MinStreamMaxSizeMiB = 64

// MaxStreamReplicas is the most replicas JetStream allows a stream.
const MaxStreamReplicas = 5

// mib is the number of bytes in a MiB.
const mib = 1 << 20

// maxStreamMaxSizeMiB and maxStreamMaxAgeHours keep the conversions to
// bytes and to a time.Duration from overflowing int64.
const (
	maxStreamMaxSizeMiB  = math.MaxInt64 / mib
	maxStreamMaxAgeHours = math.MaxInt64 / int64(time.Hour)
)

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
		StreamReplicas:      envIntOrDefault("FLIGHTDECK_NATS_STREAM_REPLICAS", 1),
		MetricsPort:         envIntOrDefault("FLIGHTDECK_METRICS_PORT", DefaultMetricsPort),
	}
	if cfg.MetricsPort < 0 || cfg.MetricsPort > maxPort {
		panic(fmt.Sprintf("environment variable FLIGHTDECK_METRICS_PORT must be between 0 (listener off) and %d, got %d",
			maxPort, cfg.MetricsPort))
	}
	if cfg.GenAIClaimInterval != 0 && cfg.GenAIClaimInterval < MinGenAIClaimInterval {
		panic(fmt.Sprintf("environment variable FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS must be 0 (the default) or at least %d",
			MinGenAIClaimInterval.Milliseconds()))
	}
	ageHours := envIntOrDefault("FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS", DefaultStreamMaxAgeHours)
	if ageHours < MinStreamMaxAgeHours || int64(ageHours) > maxStreamMaxAgeHours {
		panic(fmt.Sprintf("environment variable FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS must be between %d and %d, got %d -- "+
			"a shorter age limit would remove events a routine workers restart left unprocessed",
			MinStreamMaxAgeHours, maxStreamMaxAgeHours, ageHours))
	}
	cfg.StreamMaxAge = time.Duration(ageHours) * time.Hour
	sizeMiB := envIntOrDefault("FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", DefaultStreamMaxSizeMiB)
	if sizeMiB < MinStreamMaxSizeMiB || int64(sizeMiB) > maxStreamMaxSizeMiB {
		panic(fmt.Sprintf("environment variable FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB must be between %d and %d (MiB), got %d -- "+
			"a smaller value reads as a unit mistake and would hold only a handful of events",
			MinStreamMaxSizeMiB, maxStreamMaxSizeMiB, sizeMiB))
	}
	cfg.StreamMaxBytes = int64(sizeMiB) * mib
	if cfg.StreamReplicas < 1 || cfg.StreamReplicas > MaxStreamReplicas {
		panic(fmt.Sprintf("environment variable FLIGHTDECK_NATS_STREAM_REPLICAS must be between 1 and %d, got %d",
			MaxStreamReplicas, cfg.StreamReplicas))
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
