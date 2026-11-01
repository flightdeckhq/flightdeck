package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/server"
)

// The ingestion server answers its routes both bare (behind the compose
// nginx, which strips /ingest) and under /ingest (behind a Kubernetes
// Ingress, which forwards the path as sent).
func TestIngestionServesRoutesUnderPublicPrefix(t *testing.T) {
	srv := server.New(":0", &mockValidator{valid: true}, &mockPublisher{}, &mockDirStore{}, nil,
		&panickingDialect{}, handlers.DefaultRateLimitPerMinute)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	do := func(method, path, body string) int {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer tok")
		req.Header.Set("Content-Type", "application/json")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}

	cases := []struct {
		method, path, body string
		want               int
	}{
		{http.MethodGet, "/health", "", http.StatusOK},
		{http.MethodGet, "/ingest/health", "", http.StatusOK},
		{http.MethodPost, "/v1/logs", "{}", http.StatusOK},
		{http.MethodPost, "/ingest/v1/logs", "{}", http.StatusOK},
		{http.MethodGet, "/ingest/docs/swagger.json", "", http.StatusOK},
		// A malformed event is refused by the events handler itself, so
		// the prefixed path reached it.
		{http.MethodPost, "/ingest/v1/events", "{}", http.StatusBadRequest},
		{http.MethodGet, "/ingestx/health", "", http.StatusNotFound},
	}
	for _, tc := range cases {
		if got := do(tc.method, tc.path, tc.body); got != tc.want {
			t.Errorf("%s %s: status %d, want %d", tc.method, tc.path, got, tc.want)
		}
	}
}

// Token validation applies under the prefix exactly as on the bare path.
func TestIngestionAuthAppliesUnderPublicPrefix(t *testing.T) {
	srv := server.New(":0", &mockValidator{valid: false}, &mockPublisher{}, &mockDirStore{}, nil,
		&panickingDialect{}, handlers.DefaultRateLimitPerMinute)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	for _, path := range []string{"/v1/events", "/ingest/v1/events", "/v1/logs", "/ingest/v1/logs"} {
		req, err := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer bad")
		req.Header.Set("Content-Type", "application/json")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("POST %s with a bad token: status %d, want 401", path, resp.StatusCode)
		}
	}
}

// Swagger UI's redirects (the mux's /docs to /docs/, then http-swagger's
// to index.html, which it builds from the path as sent) end on the UI
// page under both forms, with the prefix appearing once.
func TestIngestionSwaggerUIRedirectsUnderPublicPrefix(t *testing.T) {
	srv := server.New(":0", &mockValidator{valid: true}, &mockPublisher{}, &mockDirStore{}, nil,
		&panickingDialect{}, handlers.DefaultRateLimitPerMinute)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	for start, want := range map[string]string{
		"/docs":         "/docs/index.html",
		"/ingest/docs":  "/ingest/docs/index.html",
		"/ingest/docs/": "/ingest/docs/index.html",
	} {
		resp, err := ts.Client().Get(ts.URL + start)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK || resp.Request.URL.Path != want {
			t.Errorf("GET %s ended at %s with %d, want %s with 200",
				start, resp.Request.URL.Path, resp.StatusCode, want)
		}
	}
}
