package app

import (
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/config"
)

func TestDefaultConfig_MatchesTheEnvironmentDefaults(t *testing.T) {
	c := DefaultConfig()
	if c.ListenAddr != "" {
		t.Fatalf("default config has a listener: %q", c.ListenAddr)
	}
	if c.RateLimitPerMinute != 1000 || c.StreamMaxAge != 72*time.Hour || c.StreamMaxBytes != 5120<<20 ||
		c.StreamReplicas != 1 || c.ShutdownTimeout != 30*time.Second || c.GenAIClaimInterval != 0 {
		t.Fatalf("%+v", c)
	}
}

func TestFromEnv_MapsEveryField(t *testing.T) {
	c := FromEnv(config.Config{
		Port: "8080", PostgresURL: "postgres://x", NatsURL: "nats://y", ShutdownTimeoutSecs: 7,
		RateLimitPerMinute: 5, GenAIClaimInterval: 50 * time.Millisecond,
		StreamMaxAge: time.Hour, StreamMaxBytes: 64 << 20, StreamReplicas: 3, MetricsPort: 9103,
	})
	want := Config{
		ListenAddr: ":8080", PostgresURL: "postgres://x", NatsURL: "nats://y", RateLimitPerMinute: 5,
		GenAIClaimInterval: 50 * time.Millisecond, StreamMaxAge: time.Hour, StreamMaxBytes: 64 << 20,
		StreamReplicas: 3, MetricsPort: 9103, ShutdownTimeout: 7 * time.Second,
	}
	if c != want {
		t.Fatalf("got %+v\nwant %+v", c, want)
	}
}

func TestLoadEnv_ReturnsTheEnvironmentsRefusalAsAnError(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "")
	_, err := LoadEnv()
	if err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_POSTGRES") {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://x")
	t.Setenv("FLIGHTDECK_NATS_STREAM_REPLICAS", "9")
	_, err = LoadEnv()
	if err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_NATS_STREAM_REPLICAS") {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("FLIGHTDECK_NATS_STREAM_REPLICAS", "")
	t.Setenv("FLIGHTDECK_PORT", "18080")
	c, err := LoadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != ":18080" || c.PostgresURL != "postgres://x" {
		t.Fatalf("%+v", c)
	}
}
