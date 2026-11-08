package router

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// recordingHandler records the path it was called with, as the services
// would see it, and answers 200 with its name.
type recordingHandler struct {
	name  string
	paths []string
}

func (h *recordingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.paths = append(h.paths, r.URL.Path)
	_, _ = io.WriteString(w, h.name)
}

func testUI() fstest.MapFS {
	return fstest.MapFS{
		"index.html":            {Data: []byte("<!doctype html><title>Flightdeck</title>")},
		"assets/index-abc.js":   {Data: []byte("console.log(1)")},
		"assets/favicon-16.png": {Data: []byte{0x89, 'P', 'N', 'G'}},
		"runtime-config.json":   {Data: []byte(`{"access_token":"tok_dev"}`)}, // the bundle's copy is never served
	}
}

func newTestRouter(t *testing.T) (http.Handler, *recordingHandler, *recordingHandler) {
	t.Helper()
	api := &recordingHandler{name: "api"}
	ingest := &recordingHandler{name: "ingest"}
	h := New(Config{API: api, Ingest: ingest, UI: testUI(), Token: "ftd_0123456789abcdef0123456789abcdef"})
	return h, api, ingest
}

func get(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestRoot_ServesIndexWithSecurityHeaders(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := get(t, h, http.MethodGet, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<title>Flightdeck</title>") {
		t.Fatalf("body %q is not index.html", rec.Body.String())
	}
	for k, want := range securityHeaders {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("index Cache-Control = %q", got)
	}
}

func TestSPARoutes_FallBackToIndex(t *testing.T) {
	h, api, ingest := newTestRouter(t)
	for _, p := range []string{"/events", "/agents/123", "/settings?tab=tokens", "/apifoo", "/ingestion", "/no/such/file.js"} {
		rec := get(t, h, http.MethodGet, p)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<title>Flightdeck</title>") {
			t.Errorf("%s: status %d body %q, want index.html", p, rec.Code, rec.Body.String())
		}
	}
	if len(api.paths)+len(ingest.paths) != 0 {
		t.Fatalf("a dashboard path reached a service: api %v ingest %v", api.paths, ingest.paths)
	}
}

func TestAssets_AreImmutable(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := get(t, h, http.MethodGet, "/assets/index-abc.js")
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("status %d body %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != assetsCacheControl {
		t.Fatalf("Cache-Control = %q", got)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("assets carry no security headers: %q", got)
	}
}

func TestRuntimeConfig_IsGeneratedAndUncacheable(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := get(t, h, http.MethodGet, "/runtime-config.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	if body["access_token"] != "ftd_0123456789abcdef0123456789abcdef" {
		t.Fatalf("token %q: the bundle's own runtime-config.json must not be served", body["access_token"])
	}
	for k, want := range map[string]string{
		"Cache-Control": runtimeConfigCacheControl,
		"Pragma":        "no-cache",
		"Expires":       "0",
		"Content-Type":  "application/json",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	head := get(t, h, http.MethodHead, "/runtime-config.json")
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD: status %d body %d bytes", head.Code, head.Body.Len())
	}
	post := get(t, h, http.MethodPost, "/runtime-config.json")
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status %d, want 405", post.Code)
	}
}

func TestInvestigate_RedirectsToEventsWithQuery(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := get(t, h, http.MethodGet, "/investigate?agent_id=abc")
	if rec.Code != http.StatusMovedPermanently {
		t.Fatalf("status %d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/events?agent_id=abc" {
		t.Fatalf("Location %q", loc)
	}
	plain := get(t, h, http.MethodGet, "/investigate")
	if loc := plain.Header().Get("Location"); loc != "/events" {
		t.Fatalf("Location %q", loc)
	}
}

func TestBareV1_IsNotRouted(t *testing.T) {
	h, api, ingest := newTestRouter(t)
	for _, m := range []string{http.MethodGet, http.MethodPost} {
		rec := get(t, h, m, "/v1/events")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s /v1/events: status %d, want 404", m, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "/ingest") || !strings.Contains(rec.Body.String(), "/api") {
			t.Fatalf("hint %q names neither prefix", rec.Body.String())
		}
	}
	if len(api.paths)+len(ingest.paths) != 0 {
		t.Fatalf("a bare /v1 path reached a service: api %v ingest %v", api.paths, ingest.paths)
	}
}

func TestServices_GetThePathAsSent(t *testing.T) {
	h, api, ingest := newTestRouter(t)
	cases := []struct {
		path string
		want *recordingHandler
	}{
		{"/api/v1/fleet", api},
		{"/api/docs/", api},
		{"/api", api},
		{"/ingest/v1/events", ingest},
		{"/ingest/health", ingest},
		{"/ingest", ingest},
	}
	for _, c := range cases {
		rec := get(t, h, http.MethodGet, c.path)
		if rec.Code != http.StatusOK || rec.Body.String() != c.want.name {
			t.Errorf("%s: status %d, answered by %q, want %q", c.path, rec.Code, rec.Body.String(), c.want.name)
		}
		if got := c.want.paths[len(c.want.paths)-1]; got != c.path {
			t.Errorf("%s: service saw %q, want the path as sent", c.path, got)
		}
	}
}

func TestDashboard_RefusesOtherMethods(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := get(t, h, http.MethodPost, "/events")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rec.Code)
	}
	if rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("Allow %q", rec.Header().Get("Allow"))
	}
}

func TestMissingBundle_Is503WithInstructions(t *testing.T) {
	api := &recordingHandler{name: "api"}
	h := New(Config{API: api, Ingest: api, UI: fstest.MapFS{".gitkeep": {}}, Token: "tok_dev"})
	rec := get(t, h, http.MethodGet, "/")
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "make build-flightdeck") {
		t.Fatalf("status %d body %q", rec.Code, rec.Body.String())
	}
	// The services and the token still work without a bundle.
	if rec := get(t, h, http.MethodGet, "/api/health"); rec.Code != http.StatusOK {
		t.Fatalf("/api/health status %d", rec.Code)
	}
	if rec := get(t, h, http.MethodGet, "/runtime-config.json"); rec.Code != http.StatusOK {
		t.Fatalf("/runtime-config.json status %d", rec.Code)
	}
}

func TestNilUI_Is503(t *testing.T) {
	api := &recordingHandler{name: "api"}
	h := New(Config{API: api, Ingest: api, UI: nil, Token: "tok_dev"})
	if rec := get(t, h, http.MethodGet, "/events"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", rec.Code)
	}
}

// refusingHandler answers 413 without reading the body, as the ingestion
// receivers do for a body over their cap.
type refusingHandler struct{}

func (refusingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	http.Error(w, "too large", http.StatusRequestEntityTooLarge)
}

func TestIngest_RefusedBodyIsDrainedSoTheClientSeesTheStatus(t *testing.T) {
	h := New(Config{API: &recordingHandler{name: "api"}, Ingest: refusingHandler{}, UI: testUI(), Token: "tok_dev"})
	srv := httptest.NewServer(h)
	defer srv.Close()

	// Well over net/http's own 256 KiB leftover drain, under edgeDrainBytes.
	body := bytes.Repeat([]byte(" "), 2<<20)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/ingest/v1/logs", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.ContentLength = int64(len(body))
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatalf("the client saw an error instead of the status: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413", resp.StatusCode)
	}
}

func TestDrainRefusedBody_StopsAtTheBound(t *testing.T) {
	var left int64
	h := drainRefusedBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
	}))
	body := &countingReader{n: edgeDrainBytes + 1024}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/ingest/v1/events", body)
	h.ServeHTTP(rec, req)
	left = body.n
	if left != 1024 {
		t.Fatalf("%d bytes left unread, want 1024 (the drain stops at edgeDrainBytes)", left)
	}
}

// countingReader yields n bytes and counts down what is left.
type countingReader struct{ n int64 }

func (c *countingReader) Read(p []byte) (int, error) {
	if c.n <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > c.n {
		p = p[:c.n]
	}
	c.n -= int64(len(p))
	return len(p), nil
}

func TestAssets_MissingHashIs404NotIndex(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := get(t, h, http.MethodGet, "/assets/index-stale.js")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404 (index.html must not be served for a stale asset)", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<title>Flightdeck</title>") {
		t.Fatal("a missing asset was answered with index.html")
	}
}

// stalledRequest opens a raw connection, sends a POST with a declared
// body length and one byte of it, and returns the time until the server
// closes the connection or answers.
func stalledRequest(t *testing.T, addr, path string, bound time.Duration) (elapsed time.Duration, answered bool) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	start := time.Now()
	_, _ = fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{", path)
	_ = conn.SetReadDeadline(time.Now().Add(bound))
	buf := make([]byte, 1)
	n, _ := conn.Read(buf)
	return time.Since(start), n > 0
}

func TestIngest_StalledBodyIsCutAtTheReadDeadline(t *testing.T) {
	// The handler reads the whole body, as the ingestion receivers do;
	// the client sends one byte of a thousand and stops.
	reading := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	})
	const deadline = 300 * time.Millisecond
	h := New(Config{API: reading, Ingest: reading, UI: testUI(), Token: "tok_dev",
		IngestReadTimeout: deadline, IngestWriteTimeout: deadline, APIReadTimeout: deadline})
	srv := httptest.NewServer(h)
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")

	for _, path := range []string{"/ingest/v1/events", "/api/v1/policies"} {
		elapsed, _ := stalledRequest(t, addr, path, 10*time.Second)
		if elapsed >= 5*time.Second {
			t.Fatalf("%s: the stalled request held the connection for %s; the read deadline is %s", path, elapsed, deadline)
		}
	}
}

func TestWithDeadlines_ExemptsTheWebSocketAndZeroIsAPassThrough(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	if h := withDeadlines(inner, 0, 0, nil); fmt.Sprintf("%p", h) != fmt.Sprintf("%p", inner) {
		t.Fatal("zero deadlines must return the handler itself")
	}
	var exempted bool
	h := withDeadlines(inner, time.Second, 0, func(r *http.Request) bool {
		exempted = r.URL.Path == websocketPath
		return exempted
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, websocketPath, nil))
	if !exempted || rec.Code != http.StatusNoContent {
		t.Fatalf("exempt=%v status=%d", exempted, rec.Code)
	}
}
