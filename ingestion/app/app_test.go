package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/config"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

func TestFromEnv_MapsEveryField(t *testing.T) {
	c := fromEnv(config.Config{
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

func TestLoadEnv_CarriesTheEnvironmentDefaults(t *testing.T) {
	for _, k := range []string{"FLIGHTDECK_PORT", "FLIGHTDECK_NATS_URL", "FLIGHTDECK_RATE_LIMIT_PER_MINUTE",
		"FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS", "FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS",
		"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", "FLIGHTDECK_NATS_STREAM_REPLICAS",
		"FLIGHTDECK_METRICS_PORT", "SHUTDOWN_TIMEOUT_SECS"} {
		t.Setenv(k, "")
	}
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://x")
	c, err := LoadEnv()
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		ListenAddr: ":8080", PostgresURL: "postgres://x", NatsURL: "nats://nats:4222",
		RateLimitPerMinute: 1000, GenAIClaimInterval: 0,
		StreamMaxAge:   config.DefaultStreamMaxAgeHours * time.Hour,
		StreamMaxBytes: config.DefaultStreamMaxSizeMiB << 20, StreamReplicas: 1,
		MetricsPort: config.DefaultMetricsPort, ShutdownTimeout: 30 * time.Second,
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

// The handler checks below run on a SQLite database from storagetest
// (a migrated file in the test's temp directory): the token validator
// is on the storage boundary, and the pgx stores point at the
// unavailable URL, which no health or auth check reaches.

// embeddedNATS runs a JetStream-enabled nats-server in the test process
// with no listener and returns an in-process connection to it, so New
// can create the FLIGHTDECK stream on a bus of the test's own.
func embeddedNATS(t *testing.T) *nats.Conn {
	t.Helper()
	ns, err := server.NewServer(&server.Options{
		DontListen: true, JetStream: true, StoreDir: t.TempDir(), NoSigs: true,
		JetStreamMaxMemory: 64 << 20, JetStreamMaxStore: 256 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(10 * time.Second) {
		t.Fatal("embedded NATS did not start")
	}
	t.Cleanup(ns.Shutdown)
	nc, err := nats.Connect("", nats.InProcessServer(ns))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	return nc
}

// testConfig is a Config with the stream settings the environment
// defaults to and no listener.
func testConfig() Config {
	return Config{
		RateLimitPerMinute: 1000,
		StreamMaxAge:       config.DefaultStreamMaxAgeHours * time.Hour,
		StreamMaxBytes:     64 << 20, // small: the embedded store is bounded
		StreamReplicas:     1,
		ShutdownTimeout:    10 * time.Second,
	}
}

func TestHandler_HealthUnderBothPrefixesAndAuthBeforeAnyQuery(t *testing.T) {
	nc := embeddedNATS(t)
	db := storagetest.OpenSQLite(t)
	a, err := New(context.Background(), testConfig(), Deps{DB: db, NATS: nc})
	if err != nil {
		t.Fatal(err)
	}
	defer a.closeOwned()
	if a.ownsDB || !a.ownsPool || a.ownsNATS {
		t.Fatalf("ownsDB=%v ownsPool=%v ownsNATS=%v: New owns what it opened (the unavailable pgx pool) and nothing else", a.ownsDB, a.ownsPool, a.ownsNATS)
	}
	for _, path := range []string{"/health", "/ingest/health"} {
		rec := httptest.NewRecorder()
		a.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ok") {
			t.Fatalf("GET %s: %d %q", path, rec.Code, rec.Body.String())
		}
	}
	for _, path := range []string{"/v1/events", "/ingest/v1/events"} {
		rec := httptest.NewRecorder()
		a.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}")))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("POST %s without a token: %d, want 401", path, rec.Code)
		}
	}
	// The stream exists on the injected bus.
	js, err := nc.JetStream()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.StreamInfo("FLIGHTDECK"); err != nil {
		t.Fatalf("New did not create the FLIGHTDECK stream: %v", err)
	}
}

func TestNew_UnreachableNATSIsAnErrorAndTheOwnedPoolIsClosed(t *testing.T) {
	cfg := testConfig()
	cfg.NatsURL = "nats://127.0.0.1:1"
	_, err := New(context.Background(), cfg, Deps{DB: storagetest.OpenSQLite(t)})
	if err == nil || !strings.Contains(err.Error(), "NATS connection") {
		t.Fatalf("err = %v, want the NATS dial error", err)
	}
}

func TestNew_RefusesAnUnsupportedDatabaseURL(t *testing.T) {
	cfg := testConfig()
	cfg.PostgresURL = "mysql://nope"
	_, err := New(context.Background(), cfg, Deps{NATS: embeddedNATS(t)})
	if err == nil || !strings.Contains(err.Error(), "database connection") {
		t.Fatalf("err = %v, want the storage open error", err)
	}
}
