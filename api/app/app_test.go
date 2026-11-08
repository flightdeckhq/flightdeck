package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/config"
)

func TestDefaultConfig_MatchesTheEnvironmentDefaults(t *testing.T) {
	c := DefaultConfig()
	if c.ListenAddr != "" || c.CORSOrigin != "*" || c.ShutdownTimeout != 30*time.Second || c.MetricsPort != 0 {
		t.Fatalf("%+v", c)
	}
}

func TestFromEnv_MapsEveryField(t *testing.T) {
	c := FromEnv(config.Config{Port: "8081", PostgresURL: "postgres://x", ShutdownTimeoutSecs: 9,
		CORSOrigin: "https://fd.example.com", MetricsPort: 9104})
	want := Config{ListenAddr: ":8081", PostgresURL: "postgres://x", CORSOrigin: "https://fd.example.com",
		MetricsPort: 9104, ShutdownTimeout: 9 * time.Second}
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
	t.Setenv("FLIGHTDECK_METRICS_PORT", "70000")
	if _, err := LoadEnv(); err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_METRICS_PORT") {
		t.Fatalf("err = %v", err)
	}
}

func TestTokenValid_NeverAcceptsTheDevTokenOrNothing(t *testing.T) {
	t.Setenv("ENVIRONMENT", "dev")
	for _, raw := range []string{"", "tok_dev"} {
		ok, err := TokenValid(context.Background(), nil, raw)
		if err != nil || ok {
			t.Fatalf("TokenValid(%q) = %v, %v", raw, ok, err)
		}
	}
}
