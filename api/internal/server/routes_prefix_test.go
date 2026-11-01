package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
