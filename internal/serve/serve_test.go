package serve

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
)

func TestListen_BusyPortNamesTheNextOne(t *testing.T) {
	first, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Close() }()
	addr := first.Addr().String()
	_, port, _ := net.SplitHostPort(addr)

	_, err = Listen(addr)
	if err == nil {
		t.Fatal("want an error on a busy port")
	}
	msg := err.Error()
	for _, want := range []string{addr, "already in use", "pick another port with --port " + nextPort(port)} {
		if !strings.Contains(msg, want) {
			t.Errorf("%q lacks %q", msg, want)
		}
	}
}

func TestListen_FreePort(t *testing.T) {
	ln, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_ = ln.Close()
}

func TestAddrInUse_MatchesTheErrnoAndTheWindowsText(t *testing.T) {
	cases := map[error]bool{
		syscall.EADDRINUSE: true,
		fmt.Errorf("listen tcp 127.0.0.1:4000: bind: %w", syscall.EADDRINUSE):                                                                       true,
		errors.New("listen tcp 127.0.0.1:4000: bind: address already in use"):                                                                       true,
		errors.New("listen tcp 127.0.0.1:4000: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted."): true,
		errors.New("listen tcp 10.0.0.9:4000: bind: cannot assign requested address"):                                                               false,
		syscall.EACCES: false,
	}
	for err, want := range cases {
		if got := addrInUse(err); got != want {
			t.Errorf("addrInUse(%v) = %v, want %v", err, got, want)
		}
	}
}

// The hint names the flags that serve the next port on the same
// interfaces: --port alone moves the loopback listener --port opens,
// --public --port the one on every interface, --listen any other
// address. The fixed ports of --domain have no flag to move them.
func TestPortFlags(t *testing.T) {
	for _, c := range []struct{ host, want string }{
		{"127.0.0.1", "--port 4001"},
		{"0.0.0.0", "--public --port 4001"},
		{"::", "--public --port 4001"},
		{"10.0.0.5", "--listen 10.0.0.5:4001"},
		{"::1", "--listen [::1]:4001"},
		{"localhost", "--listen localhost:4001"},
		{"", ""},
	} {
		if got := portFlags(c.host, "4001"); got != c.want {
			t.Errorf("portFlags(%q) = %q, want %q", c.host, got, c.want)
		}
	}
}

// A busy fixed port of --domain says to stop what holds it, and names no
// flag: none moves it.
func TestListen_BusyDomainPortNamesNoFlag(t *testing.T) {
	first, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Close() }()
	_, port, _ := net.SplitHostPort(first.Addr().String())
	_, err = Listen(":" + port)
	if err == nil {
		t.Fatal("want an error on a busy port")
	}
	if msg := err.Error(); !strings.Contains(msg, "already in use") || !strings.HasSuffix(msg, "stop it") || strings.Contains(msg, "--") {
		t.Errorf("%q: want the busy port and no flag", msg)
	}
}

func TestNextPort(t *testing.T) {
	for in, want := range map[string]string{"4000": "4001", "80": "81", "65535": "4001", "x": "4001"} {
		if got := nextPort(in); got != want {
			t.Errorf("nextPort(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestServer_Timeouts(t *testing.T) {
	s := Server(http.NotFoundHandler())
	if s.ReadHeaderTimeout != readHeaderTimeout || s.IdleTimeout != idleTimeout || s.WriteTimeout != 0 {
		t.Fatalf("%+v", s)
	}
}

// Live ACME cannot run in a test: it needs a public host name, :80 and
// :443, and Let's Encrypt. The test covers the wiring: the two servers'
// addresses, the TLS configuration autocert installs, and the redirect
// the :80 server answers.
func TestACME_Wiring(t *testing.T) {
	app := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	https, redirect := ACME("fd.example.com", t.TempDir(), app)

	if https.Addr != "" || redirect.Addr != "" {
		t.Fatalf("the caller binds the listeners; addrs %q %q", https.Addr, redirect.Addr)
	}
	if https.TLSConfig == nil || https.TLSConfig.GetCertificate == nil {
		t.Fatal("https server has no autocert TLS config")
	}
	if https.WriteTimeout != 0 || https.ReadHeaderTimeout != readHeaderTimeout {
		t.Fatalf("https timeouts %+v", https)
	}
	rec := httptest.NewRecorder()
	https.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "https://fd.example.com/events", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("https serves %d, want the app", rec.Code)
	}

	// The redirect is pinned to the domain, whatever Host the request
	// carried: a request for another name on this address is not sent
	// on to that name.
	for _, host := range []string{"fd.example.com", "evil.example.net", "203.0.113.9"} {
		rec = httptest.NewRecorder()
		redirect.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://"+host+"/events?x=1", nil))
		if rec.Code != http.StatusFound {
			t.Fatalf("Host %s: redirect status %d", host, rec.Code)
		}
		if loc := rec.Header().Get("Location"); loc != "https://fd.example.com/events?x=1" {
			t.Fatalf("Host %s: Location %q", host, loc)
		}
	}
	// A POST to :80 is not redirected (the body would be lost); it is
	// answered with 400.
	rec = httptest.NewRecorder()
	redirect.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "http://fd.example.com/ingest/v1/events", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST on :80 status %d", rec.Code)
	}
}

func TestListen_PrivilegedPortNamesTheRemedy(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: binding :80 is allowed")
	}
	// Port 1 is privileged on every Unix; the message must say so.
	_, err := Listen("127.0.0.1:1")
	if err == nil {
		t.Skip("binding a privileged port succeeded (CAP_NET_BIND_SERVICE or unprivileged port range)")
	}
	if !errors.Is(err, syscall.EACCES) && !strings.Contains(err.Error(), "privileged") {
		t.Skipf("the bind failed for another reason: %v", err)
	}
	for _, want := range []string{"privileged", "CAP_NET_BIND_SERVICE", "a port above 1023: --port <port>"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%q lacks %q", err.Error(), want)
		}
	}
}
