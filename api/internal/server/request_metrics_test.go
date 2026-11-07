package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/metrics"
)

// The query API times every routed request by the pattern it matched:
// two agent ids share the agent-summary series, a prefixed path counts
// under the bare route, a refused WebSocket upgrade is an ordinary 401
// under /v1/stream, an unknown path is unmatched, and a CORS preflight
// (answered before routing) is not timed. The metrics listener then
// serves those series.
func TestAPIServerRecordsRequestLatencyByRoute(t *testing.T) {
	durations := metrics.NewRequestDurations()
	// A request with no token is refused before the validator looks the
	// token up, so no pool is needed.
	srv := New(":0", nil, nil, auth.NewValidator(nil), "*", durations)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	do := func(method, path string) {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	}
	do(http.MethodGet, "/api/v1/agents/agent-one/summary")
	do(http.MethodGet, "/v1/agents/agent-two/summary")
	do(http.MethodGet, "/api/v1/stream")
	do(http.MethodGet, "/api/health")
	do(http.MethodGet, "/api/v1/no-such-route")
	do(http.MethodOptions, "/api/v1/fleet")

	cases := []struct {
		route, method, class string
		want                 uint64
	}{
		{"/v1/agents/{agent_id}/summary", http.MethodGet, "4xx", 2},
		{"/v1/stream", http.MethodGet, "4xx", 1},
		{"/health", http.MethodGet, "2xx", 1},
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
	if !strings.Contains(body, `flightdeck_http_request_duration_seconds_count{route="/v1/agents/{agent_id}/summary",method="GET",status_class="4xx"} 2`) {
		t.Errorf("scrape lacks the agent-summary series:\n%s", body)
	}
	for _, leak := range []string{"agent-one", "agent-two", "/api/", "no-such-route", `method="OPTIONS"`} {
		if strings.Contains(body, leak) {
			t.Errorf("scrape contains %q:\n%s", leak, body)
		}
	}
}
