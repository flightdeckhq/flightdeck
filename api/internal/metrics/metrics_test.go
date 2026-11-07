package metrics

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeClock replaces the middleware's clock for one test: each handler
// advances it by the duration the request should take.
func fakeClock(t *testing.T) *time.Time {
	t.Helper()
	clock := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	prev := now
	now = func() time.Time { return clock }
	t.Cleanup(func() { now = prev })
	return &clock
}

func TestRouteLabel(t *testing.T) {
	cases := map[string]string{
		"POST /v1/events":                   "/v1/events",
		"GET /v1/agents/{agent_id}/summary": "/v1/agents/{agent_id}/summary",
		"GET /v1/sessions/":                 "/v1/sessions/",
		"/health":                           "/health",
		"":                                  UnmatchedRoute,
		"GET":                               UnmatchedRoute,
	}
	for pattern, want := range cases {
		if got := RouteLabel(pattern); got != want {
			t.Errorf("RouteLabel(%q) = %q, want %q", pattern, got, want)
		}
	}
}

// A method outside the known set is OTHER and its route unmatched, so a
// client cannot mint method values and a CONNECT (whose router answer
// names the raw path) cannot mint route values.
func TestLabelsBoundMethodAndRoute(t *testing.T) {
	cases := []struct {
		method, pattern, wantMethod, wantRoute string
	}{
		{http.MethodGet, "GET /health", http.MethodGet, "/health"},
		{http.MethodHead, "GET /health", http.MethodHead, "/health"},
		{http.MethodPost, "", http.MethodPost, UnmatchedRoute},
		{"BREW", "", OtherMethod, UnmatchedRoute},
		{http.MethodConnect, "/v1/sessions/0b8f", OtherMethod, UnmatchedRoute},
		{http.MethodTrace, "", OtherMethod, UnmatchedRoute},
	}
	for _, tc := range cases {
		m, r := Labels(tc.method, tc.pattern)
		if m != tc.wantMethod || r != tc.wantRoute {
			t.Errorf("Labels(%q, %q) = (%q, %q), want (%q, %q)",
				tc.method, tc.pattern, m, r, tc.wantMethod, tc.wantRoute)
		}
	}
}

func TestStatusClass(t *testing.T) {
	cases := map[int]string{
		101: "1xx", 200: "2xx", 204: "2xx", 307: "3xx", 404: "4xx",
		429: "4xx", 500: "5xx", 503: "5xx", 99: "other", 600: "other",
	}
	for code, want := range cases {
		if got := StatusClass(code); got != want {
			t.Errorf("StatusClass(%d) = %q, want %q", code, got, want)
		}
	}
}

// Requests are labelled by the pattern they matched, so two ids under
// one pattern share a series; unmatched and wrong-method requests fall
// into the unmatched route; the status class is the one the handler
// wrote, 200 when it wrote nothing.
func TestMiddlewareLabelsByRoutePatternAndStatusClass(t *testing.T) {
	fakeClock(t)
	d := NewRequestDurations()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/agents/{agent_id}/summary", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{}"))
	})
	mux.HandleFunc("POST /v1/events", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	mux.HandleFunc("GET /health", func(http.ResponseWriter, *http.Request) {})
	mux.HandleFunc("GET /boom", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	h := Middleware(d, mux)

	serve := func(method, path string) {
		t.Helper()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, path, nil))
	}
	serve(http.MethodGet, "/v1/agents/agent-1/summary")
	serve(http.MethodGet, "/v1/agents/agent-2/summary")
	serve(http.MethodPost, "/v1/events")
	serve(http.MethodGet, "/health")
	serve(http.MethodGet, "/boom")
	serve(http.MethodGet, "/v1/sessions/1f6c1a5e-0000-4000-8000-000000000000")
	serve(http.MethodDelete, "/v1/events")
	serve("BREW", "/health")

	cases := []struct {
		route, method, class string
		want                 uint64
	}{
		{"/v1/agents/{agent_id}/summary", http.MethodGet, "2xx", 2},
		{"/v1/events", http.MethodPost, "4xx", 1},
		{"/health", http.MethodGet, "2xx", 1},
		{"/boom", http.MethodGet, "5xx", 1},
		{UnmatchedRoute, http.MethodGet, "4xx", 1},    // 404
		{UnmatchedRoute, http.MethodDelete, "4xx", 1}, // 405
		{UnmatchedRoute, OtherMethod, "4xx", 1},
	}
	for _, tc := range cases {
		if got := d.Count(tc.route, tc.method, tc.class); got != tc.want {
			t.Errorf("count{route=%q,method=%q,status_class=%q} = %d, want %d",
				tc.route, tc.method, tc.class, got, tc.want)
		}
	}
	text := scrape(t, d)
	if strings.Contains(text, "agent-1") || strings.Contains(text, "1f6c1a5e") {
		t.Errorf("an id from a request path leaked into a label:\n%s", text)
	}
}

// The middleware records the time the handler took into the right
// buckets and the sum.
func TestMiddlewareRecordsDuration(t *testing.T) {
	clock := fakeClock(t)
	d := NewRequestDurations()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/events", func(_ http.ResponseWriter, r *http.Request) {
		elapsed, _ := time.ParseDuration(r.URL.Query().Get("took"))
		*clock = clock.Add(elapsed)
	})
	h := Middleware(d, mux)
	for _, took := range []string{"3ms", "40ms", "12s"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/events?took="+took, nil))
	}

	text := scrape(t, d)
	labels := `route="/v1/events",method="POST",status_class="2xx"`
	for _, want := range []string{
		RequestDurationName + `_bucket{` + labels + `,le="0.0025"} 0`,
		RequestDurationName + `_bucket{` + labels + `,le="0.005"} 1`,
		RequestDurationName + `_bucket{` + labels + `,le="0.05"} 2`,
		RequestDurationName + `_bucket{` + labels + `,le="10"} 2`,
		RequestDurationName + `_bucket{` + labels + `,le="30"} 3`,
		RequestDurationName + `_bucket{` + labels + `,le="+Inf"} 3`,
		RequestDurationName + `_sum{` + labels + `} 12.043`,
		RequestDurationName + `_count{` + labels + `} 3`,
	} {
		if !strings.Contains(text, want+"\n") {
			t.Errorf("scrape lacks %q:\n%s", want, text)
		}
	}
}

// An observation on a bucket's bound counts in that bucket (le is
// inclusive), and one above the last bound only in +Inf.
func TestObserveBucketBoundsInclusive(t *testing.T) {
	d := NewRequestDurations()
	d.Observe("/x", http.MethodGet, "2xx", 10*time.Millisecond)
	d.Observe("/x", http.MethodGet, "2xx", time.Minute)
	text := scrape(t, d)
	labels := `route="/x",method="GET",status_class="2xx"`
	for _, want := range []string{
		`_bucket{` + labels + `,le="0.005"} 0`,
		`_bucket{` + labels + `,le="0.01"} 1`,
		`_bucket{` + labels + `,le="30"} 1`,
		`_bucket{` + labels + `,le="+Inf"} 2`,
	} {
		if !strings.Contains(text, RequestDurationName+want+"\n") {
			t.Errorf("scrape lacks %q:\n%s", want, text)
		}
	}
}

// A request whose connection the handler hijacks is not recorded,
// whether it hijacks through the writer or a ResponseController; a
// refused upgrade on the same route is.
func TestMiddlewareSkipsHijackedConnections(t *testing.T) {
	d := NewRequestDurations()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/stream", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("via") {
		case "writer":
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			_ = conn.Close()
		case "controller":
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			_ = conn.Close()
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	})
	ts := httptest.NewServer(Middleware(d, mux))
	defer ts.Close()

	for _, via := range []string{"writer", "controller", "refuse"} {
		resp, err := ts.Client().Get(ts.URL + "/v1/stream?via=" + via)
		if err == nil {
			_ = resp.Body.Close()
		}
	}
	if got := d.Count("/v1/stream", http.MethodGet, "4xx"); got != 1 {
		t.Errorf("refused upgrade: count %d, want 1", got)
	}
	text := scrape(t, d)
	if n := strings.Count(text, "_count{"); n != 1 {
		t.Errorf("want only the refused upgrade recorded, got %d series:\n%s", n, text)
	}
}

// Flush passes through and counts as a 200, so a streamed response is
// recorded with its class.
func TestStatusWriterFlush(t *testing.T) {
	d := NewRequestDurations()
	h := Middleware(d, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.(http.Flusher).Flush()
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !rec.Flushed {
		t.Error("Flush did not reach the underlying writer")
	}
	if got := d.Count(UnmatchedRoute, http.MethodGet, "2xx"); got != 1 {
		t.Errorf("count %d, want 1", got)
	}
}

// The metrics listener serves the histogram family at GET /metrics with
// its HELP and TYPE lines, and nothing else.
func TestNewServerExposesHistogram(t *testing.T) {
	d := NewRequestDurations()
	d.Observe("/v1/events", http.MethodPost, "2xx", time.Millisecond)
	srv := NewServer(":0", d)
	if srv.ReadHeaderTimeout != readHeaderTimeout {
		t.Errorf("ReadHeaderTimeout %v, want %v", srv.ReadHeaderTimeout, readHeaderTimeout)
	}

	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /metrics: status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; version=0.0.4; charset=utf-8" {
		t.Errorf("Content-Type %q", ct)
	}
	body := rec.Body.String()
	sc := bufio.NewScanner(strings.NewReader(body))
	var lines []string
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	if len(lines) < 2 ||
		lines[0] != "# HELP "+RequestDurationName+" "+requestDurationHelp ||
		lines[1] != "# TYPE "+RequestDurationName+" histogram" {
		t.Errorf("missing HELP/TYPE header:\n%s", body)
	}
	// One _bucket line per bound plus +Inf, then _sum and _count.
	if want := 2 + len(RequestDurationBuckets) + 1 + 2; len(lines) != want {
		t.Errorf("got %d lines, want %d:\n%s", len(lines), want, body)
	}
	if !strings.Contains(body, RequestDurationName+`_count{route="/v1/events",method="POST",status_class="2xx"} 1`) {
		t.Errorf("missing the observed series:\n%s", body)
	}

	for _, path := range []string{"/", "/v1/events", "/metrics/x"} {
		rec := httptest.NewRecorder()
		srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: status %d, want 404", path, rec.Code)
		}
	}
}

// A nil histogram records nothing and the middleware is a pass-through,
// so a test server built without one behaves as before.
func TestNilRequestDurations(t *testing.T) {
	var d *RequestDurations
	called := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })
	Middleware(d, next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if !called {
		t.Error("next was not called")
	}
	d.Observe("/x", http.MethodGet, "2xx", time.Second)
	if d.Count("/x", http.MethodGet, "2xx") != 0 {
		t.Error("a nil histogram counted")
	}
	if text := scrape(t, d); strings.Contains(text, "_count") {
		t.Errorf("a nil histogram rendered series:\n%s", text)
	}
}

// Series render in sorted label order so scrapes diff cleanly.
func TestWriteTextSortsSeries(t *testing.T) {
	d := NewRequestDurations()
	d.Observe("/v1/logs", http.MethodPost, "2xx", time.Millisecond)
	d.Observe("/health", http.MethodGet, "2xx", time.Millisecond)
	d.Observe("/v1/events", http.MethodPost, "4xx", time.Millisecond)
	d.Observe("/v1/events", http.MethodPost, "2xx", time.Millisecond)
	var order []string
	for _, line := range strings.Split(scrape(t, d), "\n") {
		if strings.HasPrefix(line, RequestDurationName+"_count{") {
			order = append(order, line[len(RequestDurationName+"_count"):strings.IndexByte(line, '}')+1])
		}
	}
	want := []string{
		`{route="/health",method="GET",status_class="2xx"}`,
		`{route="/v1/events",method="POST",status_class="2xx"}`,
		`{route="/v1/events",method="POST",status_class="4xx"}`,
		`{route="/v1/logs",method="POST",status_class="2xx"}`,
	}
	if strings.Join(order, " ") != strings.Join(want, " ") {
		t.Errorf("order %v, want %v", order, want)
	}
}

func scrape(t *testing.T, d *RequestDurations) string {
	t.Helper()
	var b strings.Builder
	if err := d.WriteText(&b); err != nil {
		t.Fatal(err)
	}
	return b.String()
}
