package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/handlers"
)

// A dashboard served from another origin reads how many runs a
// directive reached from X-Directive-Count. Browsers hide a header
// outside the CORS safelist from such a page unless the response lists
// it in Access-Control-Expose-Headers, on the preflight and on the
// request itself.
func TestCORSExposesDirectiveCount(t *testing.T) {
	srv := NewForTesting(":0", nil, nil, "https://dashboard.example.com", nil)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	for _, method := range []string{http.MethodGet, http.MethodOptions} {
		req, err := http.NewRequest(method, ts.URL+"/health", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Expose-Headers"); got != handlers.DirectiveCountHeader {
			t.Errorf("%s /health: Access-Control-Expose-Headers %q, want %q",
				method, got, handlers.DirectiveCountHeader)
		}
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://dashboard.example.com" {
			t.Errorf("%s /health: Access-Control-Allow-Origin %q", method, got)
		}
	}
}
