package serve

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
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
	for _, want := range []string{addr, "already in use", "--listen 127.0.0.1:" + nextPort(port)} {
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

	if https.Addr != HTTPSPort || redirect.Addr != HTTPPort {
		t.Fatalf("addrs %q %q", https.Addr, redirect.Addr)
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

	rec = httptest.NewRecorder()
	redirect.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://fd.example.com/events?x=1", nil))
	if rec.Code != http.StatusFound && rec.Code != http.StatusMovedPermanently {
		t.Fatalf("redirect status %d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "https://fd.example.com/events?x=1" {
		t.Fatalf("Location %q", loc)
	}
	// A POST to :80 is not redirected (the body would be lost); autocert
	// answers it with 400.
	rec = httptest.NewRecorder()
	redirect.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "http://fd.example.com/ingest/v1/events", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST on :80 status %d", rec.Code)
	}
}
