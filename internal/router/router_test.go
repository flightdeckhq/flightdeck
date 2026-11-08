package router

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
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
