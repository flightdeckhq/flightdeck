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
