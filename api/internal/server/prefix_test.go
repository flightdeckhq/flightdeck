package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// withPublicPrefix strips the service's public prefix only when it is
// the whole first segment of the escaped path, keeps the rest's escaping,
// and leaves the caller's request untouched.
func TestWithPublicPrefix(t *testing.T) {
	p := publicPathPrefix
	// escPrefix spells the prefix's first letter as a percent escape.
	escPrefix := "/%" + strings.ToUpper(hexByte(p[1])) + p[2:]
	cases := []struct {
		name, target, wantPath, wantRaw string
	}{
		{"prefixed route", p + "/v1/events", "/v1/events", ""},
		{"bare route", "/v1/events", "/v1/events", ""},
		{"prefix alone", p, "/", ""},
		{"prefix with slash", p + "/", "/", ""},
		{"prefixed docs", p + "/docs/index.html", "/docs/index.html", ""},
		{"query kept apart", p + "/health?x=1", "/health", ""},
		{"not a segment boundary", p + "x/v1/events", p + "x/v1/events", ""},
		{"prefix later in path", "/v1" + p + "/events", "/v1" + p + "/events", ""},
		{"encoded slash after prefix", p + "%2Fv1/events", p + "/v1/events", p + "%2Fv1/events"},
		{"escaped slash kept", p + "/v1/a%2Fb", "/v1/a/b", "/v1/a%2Fb"},
		{"escaped prefix", escPrefix + "/v1/events", "/v1/events", ""},
		{"escaped prefix, escaped slash kept", escPrefix + "/v1/a%2Fb", "/v1/a/b", "/v1/a%2Fb"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath, gotRaw string
			h := withPublicPrefix(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				gotPath, gotRaw = r.URL.Path, r.URL.RawPath
			}), p)
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

// A redirect answered for a prefixed request keeps the prefix; one for
// a bare request is left as it is.
func TestWithPublicPrefixRedirectKeepsPrefix(t *testing.T) {
	p := publicPathPrefix
	mux := http.NewServeMux()
	mux.HandleFunc("GET /docs/", func(http.ResponseWriter, *http.Request) {})
	h := withPublicPrefix(mux, p)
	for target, want := range map[string]string{
		p + "/docs":    p + "/docs/",
		"/docs":        "/docs/",
		p + "//docs/x": p + "/docs/x",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code < 300 || rec.Code >= 400 {
			t.Fatalf("GET %s: status %d, want a redirect", target, rec.Code)
		}
		if got := rec.Header().Get("Location"); got != want {
			t.Errorf("GET %s: Location %q, want %q", target, got, want)
		}
	}
}

func hexByte(b byte) string {
	const digits = "0123456789abcdef"
	return string([]byte{digits[b>>4], digits[b&0xf]})
}
