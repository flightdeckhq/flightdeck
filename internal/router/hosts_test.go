package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// guarded is the router of an instance with the given host policy,
// over stand-in services that answer 200 to everything.
func guarded(policy HostPolicy) http.Handler {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	return New(Config{
		API:    ok,
		Ingest: ok,
		UI:     fstest.MapFS{"index.html": {Data: []byte("<title>Flightdeck</title>")}},
		Token:  "ftd_secret_token",
		Hosts:  policy,
	})
}

func answer(h http.Handler, method, path, host string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Host = host
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHostPolicy_ByListenMode(t *testing.T) {
	loopback := NewHostPolicy(true, "", nil)
	domain := NewHostPolicy(false, "FD.Example.com", nil)
	open := NewHostPolicy(false, "", nil)
	listed := NewHostPolicy(false, "", []string{"fd.internal", ".corp.example"})
	loopbackListed := NewHostPolicy(true, "", []string{"dev.box"})
	anyHost := NewHostPolicy(true, "", []string{"dev.box", "*"})

	cases := []struct {
		name   string
		policy HostPolicy
		host   string
		want   int
	}{
		// A loopback listen: the names of this machine, any port.
		{"loopback: localhost and the port", loopback, "localhost:4000", 200},
		{"loopback: 127.0.0.1 and the port", loopback, "127.0.0.1:4000", 200},
		{"loopback: IPv6 loopback", loopback, "[::1]:4000", 200},
		{"loopback: IPv6 loopback without a port", loopback, "[::1]", 200},
		{"loopback: localhost without a port", loopback, "localhost", 200},
		{"loopback: another port (a forwarded or published one)", loopback, "localhost:8080", 200},
		{"loopback: mixed case", loopback, "LocalHost:4000", 200},
		{"loopback: a trailing dot", loopback, "localhost.:4000", 200},
		{"loopback: a name under localhost", loopback, "fd.localhost:4000", 200},
		{"loopback: any IP address, as a forwarder sends", loopback, "10.0.0.5:4000", 200},
		{"loopback: a rebinding page's name", loopback, "evil.example:4000", 421},
		{"loopback: a rebinding page's name, no port", loopback, "evil.example", 421},
		{"loopback: a name that ends in localhost without the dot", loopback, "evillocalhost:4000", 421},
		{"loopback: a name that starts with localhost", loopback, "localhost.evil.example:4000", 421},
		{"loopback: a name that starts with an address", loopback, "127.0.0.1.evil.example:4000", 421},
		{"loopback: no Host at all", loopback, "", 421},
		{"loopback: a port alone", loopback, ":4000", 421},
		{"loopback: a port that is not a number", loopback, "localhost:http", 421},
		{"loopback: an IPv6 literal without brackets", loopback, "::1:4000", 421},
		{"loopback: an unclosed bracket", loopback, "[::1:4000", 421},
		{"loopback: a bracketed name", loopback, "[evil.example]:4000", 421},
		{"loopback: userinfo in the Host", loopback, "localhost@evil.example", 421},
		{"loopback: a single-label name", loopback, "flightdeck:4000", 421},

		// A loopback listen with a list: the list adds to the defaults.
		{"loopback with a list: the listed name", loopbackListed, "dev.box:4000", 200},
		{"loopback with a list: localhost still", loopbackListed, "localhost:4000", 200},
		{"loopback with a list: another name", loopbackListed, "evil.example:4000", 421},

		// --domain: the domain, and this machine's own names.
		{"domain: the domain", domain, "fd.example.com", 200},
		{"domain: the domain in another case, with the port", domain, "FD.EXAMPLE.COM:443", 200},
		{"domain: the domain with a trailing dot", domain, "fd.example.com.", 200},
		{"domain: the health command's probe", domain, "fd.example.com", 200},
		{"domain: localhost", domain, "localhost", 200},
		{"domain: another name on the same address", domain, "evil.example", 421},
		{"domain: a name under the domain", domain, "x.fd.example.com", 421},

		// Beyond loopback with no list: the operator decided who
		// reaches it, and every name is answered.
		{"open: a LAN name", open, "nas.lan:4000", 200},
		{"open: a reverse proxy's name", open, "fd.example.com", 200},
		{"open: no Host at all", open, "", 200},

		// Beyond loopback with a list: the check is on.
		{"listed: an exact entry", listed, "fd.internal:4000", 200},
		{"listed: an exact entry, mixed case and a trailing dot", listed, "FD.Internal.:4000", 200},
		{"listed: a name under a dotted entry", listed, "a.b.corp.example", 200},
		{"listed: the dotted entry's own name", listed, "corp.example", 200},
		{"listed: a name that only ends in the entry's letters", listed, "evilcorp.example", 421},
		{"listed: a name under an exact entry", listed, "x.fd.internal", 421},
		{"listed: an IP address", listed, "192.168.1.10:4000", 200},
		{"listed: localhost", listed, "localhost:4000", 200},
		{"listed: another name", listed, "evil.example:4000", 421},

		// "*" answers every name, on loopback too.
		{"any: a name", anyHost, "evil.example:4000", 200},
	}
	paths := []struct{ method, path string }{
		{http.MethodGet, "/runtime-config.json"},
		{http.MethodGet, "/"},
		{http.MethodGet, "/api/health"},
		{http.MethodGet, "/ingest/health"},
		{http.MethodPost, "/ingest/v1/events"},
		{http.MethodGet, "/api/v1/sessions"},
		{http.MethodGet, "/v1/events"},
	}
	for _, c := range cases {
		h := guarded(c.policy)
		for _, p := range paths {
			rec := answer(h, p.method, p.path, c.host, nil)
			refused := rec.Code == http.StatusMisdirectedRequest
			if refused != (c.want == http.StatusMisdirectedRequest) {
				t.Errorf("%s: %s %s with Host %q answered %d, want %d", c.name, p.method, p.path, c.host, rec.Code, c.want)
			}
			if refused {
				body := rec.Body.String()
				if strings.Contains(body, "ftd_secret_token") {
					t.Errorf("%s: the refusal carries the token: %s", c.name, body)
				}
				if c.host != "" && strings.Contains(body, c.host) {
					t.Errorf("%s: the refusal repeats the request's Host: %s", c.name, body)
				}
				if strings.Count(body, "\n") != 1 || !strings.Contains(body, "--allowed-hosts (FLIGHTDECK_ALLOWED_HOSTS)") {
					t.Errorf("%s: the refusal is not one line naming the setting: %q", c.name, body)
				}
			}
		}
	}
}

// The token is the reason for the check: a refused request must not
// have reached the handler that serves it.
func TestHostPolicy_ARefusedRequestNeverReachesRuntimeConfig(t *testing.T) {
	h := guarded(NewHostPolicy(true, "", nil))
	if rec := answer(h, http.MethodGet, "/runtime-config.json", "localhost:4000", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "ftd_secret_token") {
		t.Fatalf("the dashboard's own request: %d %s", rec.Code, rec.Body.String())
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		rec := answer(h, method, "/runtime-config.json", "evil.example:4000", nil)
		if rec.Code != http.StatusMisdirectedRequest || strings.Contains(rec.Body.String(), "ftd_") {
			t.Fatalf("%s with a rebinding Host: %d %s", method, rec.Code, rec.Body.String())
		}
	}
}

func TestHostPolicy_StreamOrigin(t *testing.T) {
	loopback := NewHostPolicy(true, "", nil)
	domain := NewHostPolicy(false, "fd.example.com", nil)
	open := NewHostPolicy(false, "", nil)
	listed := NewHostPolicy(false, "", []string{"fd.internal", "dash.internal"})

	cases := []struct {
		name         string
		policy       HostPolicy
		host, origin string
		want         int
	}{
		{"loopback: the dashboard's own page", loopback, "localhost:4000", "http://localhost:4000", 200},
		{"loopback: the dashboard's dev server on another port", loopback, "localhost:4000", "http://localhost:5173", 200},
		{"loopback: 127.0.0.1 page, localhost Host", loopback, "localhost:4000", "http://127.0.0.1:4000", 200},
		{"loopback: no Origin, a client that is not a browser", loopback, "127.0.0.1:4000", "", 200},
		{"loopback: a page on another site", loopback, "localhost:4000", "https://evil.example", 403},
		{"loopback: a page whose name starts with localhost", loopback, "localhost:4000", "http://localhost.evil.example:4000", 403},
		{"loopback: an opaque origin", loopback, "localhost:4000", "null", 403},
		{"loopback: an origin that is not http", loopback, "localhost:4000", "file://localhost", 403},
		{"loopback: a rebinding page is stopped at the Host", loopback, "evil.example:4000", "http://evil.example:4000", 421},

		{"domain: the dashboard's own page", domain, "fd.example.com", "https://fd.example.com", 200},
		{"domain: another site", domain, "fd.example.com", "https://evil.example", 403},

		// Every name is answered, but the stream still opens only for
		// the page of the name that was asked for.
		{"open: the dashboard's own page, by a LAN name", open, "nas.lan:4000", "http://nas.lan:4000", 200},
		{"open: the same name behind a TLS proxy on another port", open, "fd.example.com", "https://fd.example.com:8443", 200},
		{"open: a page on another site", open, "nas.lan:4000", "https://evil.example", 403},
		{"open: a page at an address", open, "nas.lan:4000", "http://192.168.1.10:4000", 200},

		{"listed: a page of a listed name, another listed Host", listed, "fd.internal:4000", "https://dash.internal", 200},
		{"listed: a page on another site", listed, "fd.internal:4000", "https://evil.example", 403},
	}
	for _, c := range cases {
		headers := map[string]string{}
		if c.origin != "" {
			headers["Origin"] = c.origin
		}
		rec := answer(guarded(c.policy), http.MethodGet, websocketPath, c.host, headers)
		if rec.Code != c.want {
			t.Errorf("%s: GET %s with Host %q and Origin %q answered %d, want %d", c.name, websocketPath, c.host, c.origin, rec.Code, c.want)
		}
	}
	// The Origin rule is the stream's alone: the REST API has its own
	// CORS policy and a token a page on another site cannot read.
	rec := answer(guarded(loopback), http.MethodGet, "/api/v1/sessions", "localhost:4000", map[string]string{"Origin": "https://evil.example"})
	if rec.Code != 200 {
		t.Errorf("a REST request with a foreign Origin answered %d, want 200: only the stream checks it", rec.Code)
	}
}

func TestHostOf(t *testing.T) {
	good := map[string]string{
		"localhost":         "localhost",
		"localhost:4000":    "localhost",
		"LOCALHOST.:4000":   "localhost",
		"127.0.0.1:65535":   "127.0.0.1",
		"[::1]":             "::1",
		"[::1]:4000":        "::1",
		"[FD00::5]:4000":    "fd00::5",
		"fd.example.com.":   "fd.example.com",
		" fd.example.com ":  "fd.example.com",
		"fd.example.com:80": "fd.example.com",
	}
	for in, want := range good {
		if got, ok := hostOf(in); !ok || got != want {
			t.Errorf("hostOf(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", ".", ":4000", "localhost:", "localhost:port", "localhost:1234567", "::1", "[::1", "[::1]4000", "[localhost]:4000", "a b", "a/b", "user@host"} {
		if got, ok := hostOf(in); ok {
			t.Errorf("hostOf(%q) = %q, want it refused", in, got)
		}
	}
}
