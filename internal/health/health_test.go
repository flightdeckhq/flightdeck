package health

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// checkBudget bounds a check that is expected to get its answer: the
// test servers answer at once, so the bound only turns a hang into a
// failure.
const checkBudget = 10 * time.Second

// slowBudget is the deadline given to a check against a server that
// never answers. It stands in for Timeout, so the test takes a
// fraction of a second instead of three.
const slowBudget = 200 * time.Millisecond

func TestTargetFor(t *testing.T) {
	cases := []struct {
		name, listen, domain string
		want                 Target
	}{
		{"the default listen address", "127.0.0.1:4000", "", Target{Base: "http://127.0.0.1:4000"}},
		{"a port alone, the image's listen address", ":4000", "", Target{Base: "http://127.0.0.1:4000"}},
		{"every IPv4 interface, a custom port", "0.0.0.0:5000", "", Target{Base: "http://127.0.0.1:5000"}},
		{"every IPv6 interface", "[::]:4000", "", Target{Base: "http://[::1]:4000"}},
		{"IPv6 loopback", "[::1]:4000", "", Target{Base: "http://[::1]:4000"}},
		{"one LAN address: nothing listens on loopback", "10.0.0.5:4000", "", Target{Base: "http://10.0.0.5:4000"}},
		{"localhost", "localhost:4100", "", Target{Base: "http://localhost:4100"}},
		{"a host name", "fd.internal:4000", "", Target{Base: "http://fd.internal:4000"}},
		{"a domain: TLS on 443, --listen ignored", ":4000", "fd.example.com", Target{Base: "https://127.0.0.1:443", ServerName: "fd.example.com"}},
		{"a domain with a listen address that would not parse", "nonsense", "fd.example.com", Target{Base: "https://127.0.0.1:443", ServerName: "fd.example.com"}},
	}
	for _, c := range cases {
		got, err := TargetFor(c.listen, c.domain)
		if err != nil {
			t.Errorf("%s: TargetFor(%q, %q): %v", c.name, c.listen, c.domain, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: TargetFor(%q, %q) = %+v, want %+v", c.name, c.listen, c.domain, got, c.want)
		}
	}
	for _, listen := range []string{"nonsense", "127.0.0.1", "127.0.0.1:", ""} {
		if got, err := TargetFor(listen, ""); err == nil {
			t.Errorf("TargetFor(%q) = %+v, want an error: there is no port to probe", listen, got)
		}
	}
}

// flightdeck answers the two health routes as the binary's router does.
func flightdeck(t *testing.T, override map[string]http.HandlerFunc) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	for path, service := range map[string]string{"/api/health": "api", "/ingest/health": "ingestion"} {
		if h, ok := override[path]; ok {
			mux.HandleFunc(path, h)
			continue
		}
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "" {
				t.Errorf("%s: the probe sent an Authorization header; it must need no token", path)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"service":"` + service + `","status":"ok"}` + "\n"))
		})
	}
	return mux
}

func check(t *testing.T, target Target, budget time.Duration) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	return Check(ctx, target)
}

func TestCheck_Healthy(t *testing.T) {
	srv := httptest.NewServer(flightdeck(t, nil))
	defer srv.Close()
	if err := check(t, Target{Base: srv.URL}, checkBudget); err != nil {
		t.Fatalf("a serving instance: %v", err)
	}
}

func TestCheck_Unhealthy(t *testing.T) {
	cases := []struct {
		name    string
		path    string
		handler http.HandlerFunc
		want    string
	}{
		{"the query API answers 503", "/api/health", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "starting", http.StatusServiceUnavailable)
		}, "/api/health: status 503"},
		{"ingestion answers 500", "/ingest/health", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "boom", http.StatusInternalServerError)
		}, "/ingest/health: status 500"},
		{"another program on the port answers 200 with a page", "/api/health", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("<html>hello</html>"))
		}, "/api/health: the answer is not a flightdeck health response"},
		{"a 200 that is not the service's own", "/ingest/health", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"status":"ok","service":"something-else"}`))
		}, `/ingest/health: answered status "ok" for service "something-else"`},
		{"a 200 whose status is not ok", "/api/health", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"status":"degraded","service":"api"}`))
		}, `/api/health: answered status "degraded"`},
		{"a redirect is not followed", "/api/health", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/ingest/health", http.StatusFound)
		}, "/api/health: status 302"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(flightdeck(t, map[string]http.HandlerFunc{c.path: c.handler}))
			defer srv.Close()
			err := check(t, Target{Base: srv.URL}, checkBudget)
			if err == nil {
				t.Fatal("the check passed")
			}
			if want := srv.URL + c.want; !strings.HasPrefix(err.Error(), want) {
				t.Fatalf("error = %q, want it to start with %q", err, want)
			}
		})
	}
}

func TestCheck_Refused(t *testing.T) {
	// A port nothing listens on: bound, then closed.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	err = check(t, Target{Base: base}, checkBudget)
	if err == nil {
		t.Fatal("the check passed with nothing listening")
	}
	if !strings.HasPrefix(err.Error(), base+"/api/health: ") || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("error = %q, want the URL once and the refusal", err)
	}
	if strings.Count(err.Error(), base) != 1 {
		t.Fatalf("error = %q names the URL more than once", err)
	}
}

func TestCheck_Slow(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(release) }) }
	srv := httptest.NewServer(flightdeck(t, map[string]http.HandlerFunc{
		// Accepts the request and never answers, as a wedged instance.
		"/api/health": func(_ http.ResponseWriter, r *http.Request) {
			select {
			case <-release:
			case <-r.Context().Done():
			}
		},
	}))
	defer srv.Close()
	defer stop()

	began := time.Now()
	err := check(t, Target{Base: srv.URL}, slowBudget)
	if err == nil {
		t.Fatal("the check passed against an instance that never answers")
	}
	if want := srv.URL + "/api/health: no answer in time"; err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}
	if took := time.Since(began); took > checkBudget {
		t.Fatalf("the check took %s; its deadline was %s", took, slowBudget)
	}
}

func TestCheck_TLSSendsTheDomainAndNeedsNoTrustedCertificate(t *testing.T) {
	var mu sync.Mutex
	var names, hosts []string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hosts = append(hosts, r.Host)
		mu.Unlock()
		flightdeck(t, nil).ServeHTTP(w, r)
	}))
	srv.TLS = &tls.Config{
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			mu.Lock()
			names = append(names, hello.ServerName)
			mu.Unlock()
			return nil, nil
		},
	}
	// httptest's certificate is self-signed and names example.com, not
	// the domain below: the check must pass all the same.
	srv.StartTLS()
	defer srv.Close()

	if err := check(t, Target{Base: srv.URL, ServerName: "fd.example.org"}, checkBudget); err != nil {
		t.Fatalf("a serving TLS instance: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(names) == 0 {
		t.Fatal("no TLS handshake reached the server")
	}
	for _, name := range names {
		if name != "fd.example.org" {
			t.Errorf("the handshake named %q, want the instance's domain: its certificate policy admits no other name", name)
		}
	}
	if len(hosts) != len(endpoints) {
		t.Fatalf("%d requests reached the server, want %d", len(hosts), len(endpoints))
	}
	for _, host := range hosts {
		if host != "fd.example.org" {
			t.Errorf("a request carried Host %q, want the instance's domain", host)
		}
	}
}
