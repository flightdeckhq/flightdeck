package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/config"
)

func TestFromEnv_MapsEveryField(t *testing.T) {
	c := fromEnv(config.Config{Port: "8081", PostgresURL: "postgres://x", ShutdownTimeoutSecs: 9,
		CORSOrigin: "https://fd.example.com", MetricsPort: 9104})
	want := Config{ListenAddr: ":8081", PostgresURL: "postgres://x", CORSOrigin: "https://fd.example.com",
		MetricsPort: 9104, ShutdownTimeout: 9 * time.Second}
	if c != want {
		t.Fatalf("got %+v\nwant %+v", c, want)
	}
}

func TestLoadEnv_CarriesTheEnvironmentDefaults(t *testing.T) {
	for _, k := range []string{"FLIGHTDECK_PORT", "FLIGHTDECK_CORS_ORIGIN", "FLIGHTDECK_METRICS_PORT", "SHUTDOWN_TIMEOUT_SECS"} {
		t.Setenv(k, "")
	}
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://x")
	c, err := LoadEnv()
	if err != nil {
		t.Fatal(err)
	}
	want := Config{ListenAddr: ":8081", PostgresURL: "postgres://x", CORSOrigin: "*",
		MetricsPort: config.DefaultMetricsPort, ShutdownTimeout: 30 * time.Second}
	if c != want {
		t.Fatalf("got %+v\nwant %+v", c, want)
	}
}

func TestLoadEnv_ReturnsTheEnvironmentsRefusalAsAnError(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "")
	if _, err := LoadEnv(); err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_POSTGRES") {
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

// unreachableDSN parses but names a port nothing listens on; pgxpool
// opens no connection until a query asks for one, so New works and the
// handlers below never touch a database.
const unreachableDSN = "postgres://flightdeck@127.0.0.1:1/none?sslmode=disable"

func TestHandler_HealthUnderBothPrefixesWithCORS(t *testing.T) {
	a, err := New(context.Background(), Config{PostgresURL: unreachableDSN, CORSOrigin: "https://fd.example.com"}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer a.closeOwned()
	if !a.ownsPool {
		t.Fatal("New with a nil Deps.Pool must open and own a pool")
	}
	for _, path := range []string{"/health", "/api/health"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Origin", "https://fd.example.com")
		a.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"service":"api"`) {
			t.Fatalf("GET %s: %d %q", path, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://fd.example.com" {
			t.Fatalf("GET %s: Access-Control-Allow-Origin = %q", path, got)
		}
	}
	// A gated route without a token is refused before any query runs.
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/fleet", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/v1/fleet without a token: %d, want 401", rec.Code)
	}
}

func TestNew_InjectedPoolIsNotOwned(t *testing.T) {
	pool, err := NewPool(context.Background(), unreachableDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	a, err := New(context.Background(), Config{CORSOrigin: "*"}, Deps{Pool: pool})
	if err != nil {
		t.Fatal(err)
	}
	if a.ownsPool || a.pool != pool {
		t.Fatal("an injected pool must be used as is and never closed by the app")
	}
	a.closeOwned()
	if a.pool != pool {
		t.Fatal("closeOwned must leave an injected pool alone")
	}
}
