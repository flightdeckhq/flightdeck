package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// withPublicPrefix strips the service's public prefix only at a path
// segment boundary, keeps the escaped form in step, and leaves the
// caller's request untouched.
func TestWithPublicPrefix(t *testing.T) {
	cases := []struct {
		name, target, wantPath, wantRaw string
	}{
		{"prefixed route", "/api/v1/events", "/v1/events", ""},
		{"bare route", "/v1/events", "/v1/events", ""},
		{"prefix alone", "/api", "/", ""},
		{"prefix with slash", "/api/", "/", ""},
		{"prefixed docs", "/api/docs/index.html", "/docs/index.html", ""},
		{"not a segment boundary", "/apix/v1/events", "/apix/v1/events", ""},
		{"prefix later in path", "/v1/api/events", "/v1/api/events", ""},
		{"escaped slash kept", "/api/v1/a%2Fb", "/v1/a/b", "/v1/a%2Fb"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath, gotRaw string
			h := withPublicPrefix(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				gotPath, gotRaw = r.URL.Path, r.URL.RawPath
			}), publicPathPrefix)
			req := httptest.NewRequest(http.MethodGet, tc.target, nil)
			origPath := req.URL.Path
			h.ServeHTTP(httptest.NewRecorder(), req)
			if gotPath != tc.wantPath || gotRaw != tc.wantRaw {
				t.Fatalf("path=%q raw=%q, want path=%q raw=%q", gotPath, gotRaw, tc.wantPath, tc.wantRaw)
			}
			if req.URL.Path != origPath {
				t.Fatalf("caller's request was changed: %q -> %q", origPath, req.URL.Path)
			}
		})
	}
}
