package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
)

// The query API answers its routes both bare (behind the compose nginx,
// which strips /api) and under /api (behind a Kubernetes Ingress, which
// forwards the path as sent): each prefixed path gets the same answer
// as its bare form, and CORS applies to both.
func TestAPIServesRoutesUnderPublicPrefix(t *testing.T) {
	srv := NewForTesting(":0", nil, nil, "*")
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	get := func(path string) int {
		t.Helper()
		resp, err := ts.Client().Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("GET %s: Access-Control-Allow-Origin %q, want *", path, got)
		}
		return resp.StatusCode
	}

	// /v1/fleet reaches its handler, which this test server (no store)
	// cannot answer 200; what matters is that both forms get there.
	for _, bare := range []string{"/health", "/docs/swagger.json", "/v1/fleet"} {
		want := get(bare)
		if want == http.StatusNotFound {
			t.Fatalf("GET %s: 404, the route is not registered", bare)
		}
		if got := get("/api" + bare); got != want {
			t.Errorf("GET /api%s: status %d, want %d as for %s", bare, got, want, bare)
		}
	}
	if got := get("/apix/health"); got != http.StatusNotFound {
		t.Errorf("GET /apix/health: status %d, want 404", got)
	}
}

// The bearer-token gate applies under the prefix exactly as on the bare
// path: a request with no token is refused 401 on both forms, and the
// open routes stay open.
func TestAPIAuthAppliesUnderPublicPrefix(t *testing.T) {
	// A request with no token is refused before the validator looks the
	// token up, so no pool is needed.
	srv := New(":0", nil, nil, auth.NewValidator(nil), "*")
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	for path, want := range map[string]int{
		"/v1/fleet":      http.StatusUnauthorized,
		"/api/v1/fleet":  http.StatusUnauthorized,
		"/v1/events":     http.StatusUnauthorized,
		"/api/v1/events": http.StatusUnauthorized,
		"/health":        http.StatusOK,
		"/api/health":    http.StatusOK,
	} {
		resp, err := ts.Client().Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("GET %s: status %d, want %d", path, resp.StatusCode, want)
		}
	}
}

// Swagger UI's redirects (the mux's /docs to /docs/, then http-swagger's
// to index.html, which it builds from the path as sent) end on the UI
// page under both forms, with the prefix appearing once.
func TestAPISwaggerUIRedirectsUnderPublicPrefix(t *testing.T) {
	srv := NewForTesting(":0", nil, nil, "*")
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	for start, want := range map[string]string{
		"/docs":      "/docs/index.html",
		"/api/docs":  "/api/docs/index.html",
		"/api/docs/": "/api/docs/index.html",
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
