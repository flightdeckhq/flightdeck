package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/metrics"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/server"
)

// The ingestion server times every request by the pattern its router
// matched: a prefixed path counts under the same route as the bare one,
// a panic counts as the 500 the recovery answers, and a path no route
// matches counts as unmatched. The metrics listener then serves those
// series.
func TestIngestionServerRecordsRequestLatencyByRoute(t *testing.T) {
	durations := metrics.NewRequestDurations()
	srv := server.New(":0", &mockValidator{valid: true}, &mockPublisher{}, &mockDirStore{}, nil,
		&panickingDialect{panics: 1}, handlers.DefaultRateLimitPerMinute, durations)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	do := func(method, path, body string) {
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
	}
	do(http.MethodGet, "/health", "")
	do(http.MethodGet, "/ingest/health", "")
	do(http.MethodPost, "/ingest/v1/events", "{}") // malformed: 400
	do(http.MethodPost, "/v1/logs", "{}")          // the dialect panics: 500
	do(http.MethodPost, "/v1/logs", "{}")          // then maps nothing: 200
	do(http.MethodGet, "/ingest/v1/nothing-here", "")

	cases := []struct {
		route, method, class string
		want                 uint64
	}{
		{"/health", http.MethodGet, "2xx", 2},
		{"/v1/events", http.MethodPost, "4xx", 1},
		{"/v1/logs", http.MethodPost, "5xx", 1},
		{"/v1/logs", http.MethodPost, "2xx", 1},
		{metrics.UnmatchedRoute, http.MethodGet, "4xx", 1},
	}
	for _, tc := range cases {
		if got := durations.Count(tc.route, tc.method, tc.class); got != tc.want {
			t.Errorf("count{route=%q,method=%q,status_class=%q} = %d, want %d",
				tc.route, tc.method, tc.class, got, tc.want)
		}
	}

	rec := httptest.NewRecorder()
	metrics.NewServer(":0", durations).Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	for _, want := range []string{
		"# TYPE flightdeck_http_request_duration_seconds histogram",
		`flightdeck_http_request_duration_seconds_count{route="/health",method="GET",status_class="2xx"} 2`,
		`flightdeck_http_request_duration_seconds_bucket{route="/v1/events",method="POST",status_class="4xx",le="+Inf"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("scrape lacks %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "/ingest/") || strings.Contains(body, "nothing-here") {
		t.Errorf("a raw request path leaked into a label:\n%s", body)
	}
}
