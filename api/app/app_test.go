package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/config"
	"github.com/flightdeckhq/flightdeck/storage"
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

// emptySQLiteURL names a fresh, unmigrated SQLite file: New opens it
// (storage.Open pings, which needs no table) and the handlers below
// never query it.
func emptySQLiteURL(t *testing.T) string {
	t.Helper()
	return "sqlite://" + filepath.Join(t.TempDir(), "empty.db")
}

func TestHandler_HealthUnderBothPrefixesWithCORS(t *testing.T) {
	a, err := New(context.Background(), Config{PostgresURL: emptySQLiteURL(t), CORSOrigin: "https://fd.example.com"}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer a.closeOwned()
	if !a.ownsDB {
		t.Fatal("New with a nil Deps.DB must open and own a database")
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

func TestNew_InjectedDBIsNotOwned(t *testing.T) {
	db, err := storage.Open(context.Background(), emptySQLiteURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	a, err := New(context.Background(), Config{CORSOrigin: "*"}, Deps{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	if a.ownsDB || a.db != db {
		t.Fatal("an injected database must be used as is and never closed by the app")
	}
	a.closeOwned()
	if a.db != db {
		t.Fatal("closeOwned must leave an injected database alone")
	}
	if err := db.PingContext(context.Background()); err != nil {
		t.Fatalf("closeOwned closed the injected database: %v", err)
	}
}

// DatabaseURL adds the API's connection parameter to a Postgres URL and
// returns every other URL byte for byte: a SQLite URL carries its path
// verbatim, so parsing and re-encoding it would name another file.
func TestDatabaseURL_ChangesPostgresURLsOnly(t *testing.T) {
	if got, want := DatabaseURL("postgresql://u:p@h/db"), "postgresql://u:p@h/db?jit=off"; got != want {
		t.Errorf("DatabaseURL = %q, want %q", got, want)
	}
	for _, same := range []string{
		"sqlite:///var/lib/flightdeck/flightdeck.db",
		"sqlite:///home/o m/a#b/x?y/50%/flightdeck.db",
		`sqlite://C:\Users\omria\AppData\Local\flightdeck\flightdeck.db`,
		"mysql://u:p@h/db",
		"",
	} {
		if got := DatabaseURL(same); got != same {
			t.Errorf("DatabaseURL(%q) = %q, want it unchanged", same, got)
		}
	}
}

// A Postgres URL gets jit=off for the API's connections, and an
// existing jit setting is kept.
func TestWithJITOff(t *testing.T) {
	for in, want := range map[string]string{
		"postgres://u:p@h:5432/db?sslmode=disable": "postgres://u:p@h:5432/db?jit=off&sslmode=disable",
		"postgres://u:p@h:5432/db":                 "postgres://u:p@h:5432/db?jit=off",
		"postgres://u:p@h:5432/db?jit=on":          "postgres://u:p@h:5432/db?jit=on",
	} {
		if got := withJITOff(in); got != want {
			t.Errorf("withJITOff(%q) = %q, want %q", in, got, want)
		}
	}
}
