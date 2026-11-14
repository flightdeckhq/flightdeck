package router

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
				requireMisdirectedBody(t, c.name, rec, c.host)
			}
		}
	}
}

// requireMisdirectedBody checks a 421: one line of JSON with no secret,
// naming the refused host as the server read it (lower-case, without a
// port or a trailing dot) and the setting that admits it, or saying the
// Host was missing or malformed.
func requireMisdirectedBody(t *testing.T, name string, rec *httptest.ResponseRecorder, sentHost string) {
	t.Helper()
	body := rec.Body.String()
	if strings.Contains(body, "ftd_secret_token") {
		t.Errorf("%s: the refusal carries the token: %s", name, body)
	}
	if strings.Count(body, "\n") != 1 || rec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("%s: the refusal is not one line of JSON: %q", name, body)
	}
	var msg struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &msg); err != nil {
		t.Fatalf("%s: the refusal does not parse: %v: %q", name, err, body)
	}
	host, ok := hostOf(sentHost)
	if !ok {
		if !strings.Contains(msg.Error, "missing or is not a host name") {
			t.Errorf("%s: the refusal of a malformed Host does not say so: %q", name, msg.Error)
		}
		return
	}
	for _, want := range []string{
		`does not answer for the host name "` + host + `"`,
		"add " + host + " to the comma-separated list in FLIGHTDECK_ALLOWED_HOSTS or --allowed-hosts",
	} {
		if !strings.Contains(msg.Error, want) {
			t.Errorf("%s: the refusal lacks %q: %q", name, want, msg.Error)
		}
	}
	if _, port, err := net.SplitHostPort(sentHost); err == nil && port != "" && strings.Contains(msg.Error, ":"+port) {
		t.Errorf("%s: the refusal names the port, which no list entry takes: %q", name, msg.Error)
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

		// The Host check off: the Origin is not checked either, as before
		// the Host check existed, and the stream needs its token alone.
		{"open: the dashboard's own page, by a LAN name", open, "nas.lan:4000", "http://nas.lan:4000", 200},
		{"open: the same name behind a TLS proxy on another port", open, "fd.example.com", "https://fd.example.com:8443", 200},
		{"open: a proxy that rewrites the Host to its upstream", open, "127.0.0.1:4000", "https://fd.example.com", 200},
		{"open: a proxy that rewrites the Host to a service name", open, "flightdeck:4000", "https://fd.example.com", 200},
		{"open: a page on another site", open, "nas.lan:4000", "https://evil.example", 200},
		{"open: a page at an address", open, "nas.lan:4000", "http://192.168.1.10:4000", 200},

		{"listed: a page of a listed name, another listed Host", listed, "fd.internal:4000", "https://dash.internal", 200},
		{"listed: a page on another site", listed, "fd.internal:4000", "https://evil.example", 403},
		// The Host-rewriting proxy with the check on: the upstream Host
		// is an address (always answered); the page's name must be listed.
		{"listed: a proxy's upstream Host, the page's name listed", listed, "127.0.0.1:4000", "https://dash.internal", 200},
		{"listed: a proxy's upstream Host, the page's name not listed", listed, "127.0.0.1:4000", "https://fd.example.com", 403},
		{"domain: a proxy's upstream Host, the domain's page", domain, "127.0.0.1:443", "https://fd.example.com", 200},
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
	// A refusal names the page's host and the setting that admits it.
	rec := answer(guarded(listed), http.MethodGet, websocketPath, "127.0.0.1:4000", map[string]string{"Origin": "https://FD.Example.com:8443"})
	for _, want := range []string{`\"fd.example.com\"`, "add fd.example.com to the comma-separated list in FLIGHTDECK_ALLOWED_HOSTS or --allowed-hosts"} {
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), want) {
			t.Errorf("a foreign page's refusal: %d %s, want 403 with %s", rec.Code, rec.Body.String(), want)
		}
	}
	if rec := answer(guarded(listed), http.MethodGet, websocketPath, "127.0.0.1:4000", map[string]string{"Origin": "null"}); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "FLIGHTDECK_ALLOWED_HOSTS or --allowed-hosts") {
		t.Errorf("an opaque origin's refusal: %d %s", rec.Code, rec.Body.String())
	}

	// The Origin rule is the stream's alone: the REST API has its own
	// CORS policy and a token a page on another site cannot read.
	rec = answer(guarded(loopback), http.MethodGet, "/api/v1/sessions", "localhost:4000", map[string]string{"Origin": "https://evil.example"})
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

// capturedLog is the default logger's output for the length of a test.
type capturedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *capturedLog) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Write(p)
}

func (c *capturedLog) lines(substr string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, line := range strings.Split(c.buf.String(), "\n") {
		if strings.Contains(line, substr) {
			out = append(out, line)
		}
	}
	return out
}

func captureLog(t *testing.T) *capturedLog {
	t.Helper()
	c := &capturedLog{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(c, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return c
}

// One WARN line per distinct refused host name, whatever its port, case
// or trailing dot, up to refusedHostLogLimit names; then one line that
// says no more are logged, and nothing after it. The set behind it
// never grows past the limit.
func TestHostGuard_LogsEachRefusedHostOnceAndStopsAtTheLimit(t *testing.T) {
	log := captureLog(t)
	h := guarded(NewHostPolicy(true, "", nil))
	g, ok := h.(*hostGuard)
	if !ok {
		t.Fatalf("New returned %T, want the host guard in front", h)
	}

	for _, host := range []string{"evil.example:4000", "EVIL.example:8080", "evil.example.", "evil.example"} {
		answer(h, http.MethodGet, "/runtime-config.json", host, nil)
	}
	if got := log.lines(`host=evil.example`); len(got) != 1 {
		t.Fatalf("%d log lines for one host name sent four ways, want 1:\n%s", len(got), strings.Join(got, "\n"))
	}
	if got := log.lines("a request was refused (421)"); len(got) != 1 || !strings.Contains(got[0], "FLIGHTDECK_ALLOWED_HOSTS or --allowed-hosts") {
		t.Fatalf("the line does not name the setting: %v", got)
	}
	// A malformed Host counts as one name, however it is malformed.
	for _, host := range []string{"", ":4000", "[::1", strings.Repeat("a", maxHostNameBytes+1)} {
		answer(h, http.MethodGet, "/", host, nil)
	}
	if got := log.lines("missing or is not a host name"); len(got) != 1 {
		t.Fatalf("%d log lines for malformed hosts, want 1:\n%s", len(got), strings.Join(got, "\n"))
	}

	// A scanner: a new name on every request.
	for i := range 3 * refusedHostLogLimit {
		answer(h, http.MethodGet, "/", fmt.Sprintf("scan-%d.example", i), nil)
	}
	if got := log.lines("a request was refused (421)"); len(got) != refusedHostLogLimit {
		t.Fatalf("%d refused hosts were logged, want the limit of %d", len(got), refusedHostLogLimit)
	}
	if got := log.lines("without a log line"); len(got) != 1 {
		t.Fatalf("%d lines say the limit was reached, want 1", len(got))
	}
	g.mu.Lock()
	remembered := len(g.logged)
	g.mu.Unlock()
	if remembered > refusedHostLogLimit {
		t.Fatalf("the guard remembers %d hosts, more than the limit of %d", remembered, refusedHostLogLimit)
	}
	// Past the limit every request is still refused, with its own name.
	rec := answer(h, http.MethodGet, "/runtime-config.json", "late.example:4000", nil)
	if rec.Code != http.StatusMisdirectedRequest || !strings.Contains(rec.Body.String(), `\"late.example\"`) {
		t.Fatalf("past the log limit: %d %s", rec.Code, rec.Body.String())
	}
}

// What a request can make the server repeat is bounded: a Host longer
// than any DNS name is refused as malformed, so neither the 421 body
// nor the log carries it.
func TestHostGuard_ALongHostIsNotRepeated(t *testing.T) {
	log := captureLog(t)
	h := guarded(NewHostPolicy(true, "", nil))
	long := strings.Repeat("a", 300) + ".example"
	rec := answer(h, http.MethodGet, "/", long+":4000", nil)
	if rec.Code != http.StatusMisdirectedRequest {
		t.Fatalf("a %d-byte Host answered %d, want 421", len(long), rec.Code)
	}
	if strings.Contains(rec.Body.String(), strings.Repeat("a", 64)) {
		t.Fatalf("the 421 body repeats the long Host: %s", rec.Body.String())
	}
	if got := log.lines(strings.Repeat("a", 64)); len(got) != 0 {
		t.Fatalf("the log repeats the long Host: %v", got)
	}
	// The longest DNS name is still a name.
	edge := strings.Repeat("a", maxHostNameBytes)
	if got, ok := hostOf(edge + ":4000"); !ok || got != edge {
		t.Fatalf("a %d-byte name was refused as malformed", maxHostNameBytes)
	}
}

func TestHostPolicy_Describe(t *testing.T) {
	cases := []struct {
		policy   HostPolicy
		answered string
		enforced bool
	}{
		{NewHostPolicy(true, "", nil), "localhost, IP addresses", true},
		{NewHostPolicy(false, "FD.Example.com.", nil), "localhost, IP addresses, fd.example.com", true},
		{NewHostPolicy(false, "", []string{"fd.internal", ".corp.example"}), "localhost, IP addresses, fd.internal, .corp.example", true},
		{NewHostPolicy(false, "", nil), "any host name", false},
		{NewHostPolicy(true, "", []string{"*"}), "any host name", false},
		{NewHostPolicy(false, "", []string{"localhost"}), "localhost, IP addresses", true},
		{NewHostPolicy(false, "fd.example.com", []string{"fd.example.com", "a", "a"}), "localhost, IP addresses, fd.example.com, a", true},
	}
	for _, c := range cases {
		answered, enforced := c.policy.Describe()
		if answered != c.answered || enforced != c.enforced {
			t.Errorf("Describe(%+v) = %q, %v; want %q, %v", c.policy, answered, enforced, c.answered, c.enforced)
		}
	}
}
