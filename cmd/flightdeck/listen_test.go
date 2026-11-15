package main

import (
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The listen flags against the real binary: --port, and a --listen port
// with no host, serve this machine only, with the development token and
// the Host check on; --public serves every interface with a minted token
// and no Host check; `flightdeck health` finds each with the same flags;
// and the flags that do not combine stop the start with a usage error.

// dialTimeout bounds one probe of an address from this machine. A
// connection to an address of this machine is accepted or refused at
// once; the bound only keeps a firewall that drops the packet from
// hanging the test.
const dialTimeout = 2 * time.Second

// nonLoopbackIPv4 is an IPv4 address of an interface of this machine
// that is up and not loopback (and not link-local, which some machines
// do not route to themselves), or "" when the machine has none.
func nonLoopbackIPv4(t *testing.T) string {
	t.Helper()
	ifaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			if ip := ipNet.IP.To4(); ip != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
				return ip.String()
			}
		}
	}
	return ""
}

// accepts reports whether a TCP connection to addr is accepted.
func accepts(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, dialTimeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// requireThisMachineOnly checks the loopback mode of a running child:
// the development token, the Host check and the start-up block, and no
// listener on the machine's other address.
func requireThisMachineOnly(t *testing.T, c *child, port string) {
	t.Helper()
	if token := c.dashboardToken(t); token != "tok_dev" {
		t.Errorf("the dashboard token is %q, want the development token", token)
	}
	if code := c.get(t, "/api/v1/fleet", "tok_dev", nil); code != http.StatusOK {
		t.Errorf("the development token: %d, want 200", code)
	}
	if code, body := c.getWithHost(t, "/runtime-config.json", "evil.example:"+port); code != http.StatusMisdirectedRequest || strings.Contains(body, "tok_dev") {
		t.Errorf("a foreign Host: %d %q, want 421 without the token", code, body)
	}
	for _, want := range []string{
		"  Dashboard   http://localhost:" + port + "\n",
		"  Token       tok_dev   (development token: the server listens on this machine only; --public lets other machines in)\n",
		"  Hosts       localhost, IP addresses   (a request for any other host name is refused",
	} {
		if !strings.Contains(c.out.String(), want) {
			t.Errorf("the start-up block lacks %q:\n%s", want, c.out.String())
		}
	}
	if ip := nonLoopbackIPv4(t); ip == "" {
		t.Log("this machine has no non-loopback IPv4 address to probe")
	} else if accepts(net.JoinHostPort(ip, port)) {
		t.Errorf("%s accepts a connection; the server must listen on this machine only", net.JoinHostPort(ip, port))
	}
}

func TestBinary_PortServesThisMachineOnly(t *testing.T) {
	port := freePort(t)
	c := startArgs(t, nil, port, "--port", port, "--data-dir", filepath.Join(tempDir(t), "data"))
	requireThisMachineOnly(t, c, port)

	healthy := "healthy: http://127.0.0.1:" + port + " answers /api/health and /ingest/health\n"
	for _, h := range []struct {
		env  []string
		args []string
	}{
		{nil, []string{"--port", port}},
		{nil, []string{"-p", port}},
		{[]string{"FLIGHTDECK_PORT=" + port}, nil},
		{nil, []string{"--listen", ":" + port}},
	} {
		if code, out := runHealthCommand(t, h.env, h.args...); code != 0 || out != healthy {
			t.Errorf("flightdeck health %v (env %v): exit %d, output %q; want 0 and %q", h.args, h.env, code, out, healthy)
		}
	}
	// The default port is not this one.
	if code, _ := runHealthCommand(t, []string{"FLIGHTDECK_PORT=" + freePort(t)}); code != 1 {
		t.Errorf("flightdeck health on another port: exit %d, want 1", code)
	}
}

// A port with no host is loopback: the mode --port is, not every
// interface.
func TestBinary_ListenPortWithoutHostIsLoopback(t *testing.T) {
	port := freePort(t)
	c := start(t, ":"+port, port, filepath.Join(tempDir(t), "data"))
	requireThisMachineOnly(t, c, port)

	healthy := "healthy: http://127.0.0.1:" + port + " answers /api/health and /ingest/health\n"
	for _, h := range [][]string{{"FLIGHTDECK_LISTEN=:" + port}, {"FLIGHTDECK_PORT=" + port}} {
		if code, out := runHealthCommand(t, h); code != 0 || out != healthy {
			t.Errorf("flightdeck health (env %v): exit %d, output %q; want 0 and %q", h, code, out, healthy)
		}
	}
}

func TestBinary_PublicServesEveryInterface(t *testing.T) {
	port := freePort(t)
	c := startArgs(t, nil, port, "--public", "--port", port, "--data-dir", filepath.Join(tempDir(t), "data"))
	token := c.dashboardToken(t)
	if !strings.HasPrefix(token, "ftd_") {
		t.Fatalf("--public serves the token %q, want a minted ftd_ token", token)
	}
	if code := c.get(t, "/api/v1/fleet", "tok_dev", nil); code != http.StatusUnauthorized {
		t.Errorf("the development token on --public: %d, want 401", code)
	}
	if code, _ := c.getWithHost(t, "/api/health", "nas.lan:"+port); code != http.StatusOK {
		t.Errorf("a LAN name with no list: %d, want 200 (a listen beyond loopback answers any name)", code)
	}
	for _, want := range []string{
		"  Dashboard   http://<this-host>:" + port + "   (every interface of this machine",
		"  Token       " + token + "   (minted now",
		"  Hosts       any host name",
	} {
		if !strings.Contains(c.out.String(), want) {
			t.Errorf("the start-up block lacks %q:\n%s", want, c.out.String())
		}
	}
	if ip := nonLoopbackIPv4(t); ip == "" {
		t.Log("this machine has no non-loopback IPv4 address to probe")
	} else {
		resp, err := http.Get("http://" + net.JoinHostPort(ip, port) + "/api/health")
		if err != nil {
			t.Errorf("%s: %v; --public must serve the machine's other addresses", net.JoinHostPort(ip, port), err)
		} else {
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("%s/api/health: %d, want 200", net.JoinHostPort(ip, port), resp.StatusCode)
			}
		}
	}

	healthy := "healthy: http://127.0.0.1:" + port + " answers /api/health and /ingest/health\n"
	for _, h := range []struct {
		env  []string
		args []string
	}{
		{nil, []string{"--public", "--port", port}},
		{[]string{"FLIGHTDECK_PUBLIC=true", "FLIGHTDECK_PORT=" + port}, nil},
	} {
		if code, out := runHealthCommand(t, h.env, h.args...); code != 0 || out != healthy {
			t.Errorf("flightdeck health %v (env %v): exit %d, output %q; want 0 and %q", h.args, h.env, code, out, healthy)
		}
	}
}

// --listen names the whole address: given with --port or --public, or
// set beside their variables with no flag deciding, it stops the start
// with status 2 before anything is bound or written. The health command
// reports the same as unhealthy, in one line.
func TestBinary_ListenFlagsThatDoNotCombineAreAUsageError(t *testing.T) {
	port := freePort(t)
	for _, c := range []struct {
		env  []string
		args []string
		want string
	}{
		{nil, []string{"--port", port, "--listen", "127.0.0.1:" + port}, "--listen and --port were both given"},
		{nil, []string{"-p", port, "--listen", "127.0.0.1:" + port}, "--listen and -p were both given"},
		{nil, []string{"--public", "--listen", "0.0.0.0:" + port}, "--listen and --public were both given"},
		{[]string{"FLIGHTDECK_LISTEN=127.0.0.1:" + port, "FLIGHTDECK_PORT=" + port}, nil, "FLIGHTDECK_LISTEN and FLIGHTDECK_PORT are both set"},
		{[]string{"FLIGHTDECK_LISTEN=0.0.0.0:" + port, "FLIGHTDECK_PUBLIC=true"}, nil, "FLIGHTDECK_LISTEN and FLIGHTDECK_PUBLIC are both set"},
		{nil, []string{"--port", "0"}, "it takes a port number from 1 to 65535"},
		{nil, []string{"--listen", port}, "for that port on this machine give --port " + port},
	} {
		dataDir := filepath.Join(tempDir(t), "data")
		code, out := runToExit(t, c.env, append(c.args, "--data-dir", dataDir)...)
		if code != 2 || !strings.Contains(out, c.want) {
			t.Errorf("flightdeck %v (env %v): exit %d, output %q; want 2 and %q", c.args, c.env, code, out, c.want)
		}
		if _, err := os.Stat(dataDir); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("flightdeck %v (env %v) created its data dir (stat: %v)", c.args, c.env, err)
		}
		if accepts("127.0.0.1:" + port) {
			t.Fatalf("flightdeck %v (env %v) left a listener on port %s", c.args, c.env, port)
		}

		code, out = runHealthCommand(t, c.env, c.args...)
		if code != 1 || strings.Count(out, "\n") != 1 || !strings.Contains(out, c.want) {
			t.Errorf("flightdeck health %v (env %v): exit %d, output %q; want 1 and one line with %q", c.args, c.env, code, out, c.want)
		}
	}
}
