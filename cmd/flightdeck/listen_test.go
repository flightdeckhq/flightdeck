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
		"  Token       tok_dev   (development token: the server listens on this machine only)\n" +
			"              --public lets other machines in; whoever can reach the server can then read the dashboard token, " +
			"so open it only on a network you trust, or put it behind a proxy that authenticates\n",
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

// hostlessWarning begins the line the binary logs at start-up when the
// listen address was a port with no host.
const hostlessWarning = "the listen address has no host, so the server listens on this machine only"

func TestBinary_PortServesThisMachineOnly(t *testing.T) {
	port := freePort(t)
	c := startArgs(t, nil, port, "--port", port, "--data-dir", filepath.Join(tempDir(t), "data"))
	requireThisMachineOnly(t, c, port)
	if strings.Contains(c.out.String(), hostlessWarning) {
		t.Errorf("--port logged the warning of a host-less listen address:\n%s", c.out.String())
	}

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
	// One warning at start-up, naming the address as it was given and
	// the forms that say what was meant.
	out := c.out.String()
	if n := strings.Count(out, hostlessWarning); n != 1 {
		t.Errorf("%d host-less warnings, want 1:\n%s", n, out)
	}
	for _, want := range []string{"--listen 0.0.0.0:" + port, "--public --port " + port, "--port " + port, `given="--listen :` + port + `"`} {
		if !strings.Contains(out, want) {
			t.Errorf("the warning lacks %q:\n%s", want, out)
		}
	}

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

// A port with no host and a supplied dashboard token stop the start
// before anything is bound or written: the token says the instance
// serves beyond loopback (a reverse proxy on this machine forwarding to
// it), which ":N" no longer does.
func TestBinary_HostlessListenWithASuppliedTokenIsRefused(t *testing.T) {
	port := freePort(t)
	tokenFile := filepath.Join(tempDir(t), "token")
	if err := os.WriteFile(tokenFile, []byte(suppliedTokenA+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		env   []string
		args  []string
		given string
	}{
		{[]string{"FLIGHTDECK_LISTEN=:" + port, "FLIGHTDECK_DASHBOARD_TOKEN=" + suppliedTokenA, "FLIGHTDECK_ALLOWED_HOSTS=fd.example.com"}, nil,
			"FLIGHTDECK_LISTEN=:" + port},
		{[]string{"FLIGHTDECK_DASHBOARD_TOKEN_FILE=" + tokenFile}, []string{"--listen", ":" + port}, "--listen :" + port},
	} {
		dataDir := filepath.Join(tempDir(t), "data")
		code, out := runToExit(t, c.env, append(c.args, "--data-dir", dataDir)...)
		if code != 2 || !strings.Contains(out, c.given+" has no host, which means this machine only") ||
			!strings.Contains(out, "--listen 0.0.0.0:"+port) || !strings.Contains(out, "--listen 127.0.0.1:"+port) {
			t.Errorf("env %v, args %v: exit %d, output %q; want 2 and the forms to write", c.env, c.args, code, out)
		}
		if strings.Contains(out, suppliedTokenA) {
			t.Errorf("the refusal repeats the supplied token: %q", out)
		}
		if _, err := os.Stat(dataDir); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("env %v, args %v: the refused start created its data dir (stat: %v)", c.env, c.args, err)
		}
		if accepts("127.0.0.1:" + port) {
			t.Fatalf("env %v, args %v: the refused start left a listener", c.env, c.args)
		}
	}
	// Written out, the same start goes ahead (here on every interface,
	// with the supplied token).
	c := startArgs(t, []string{"FLIGHTDECK_LISTEN=0.0.0.0:" + port, "FLIGHTDECK_DASHBOARD_TOKEN=" + suppliedTokenA}, port,
		"--data-dir", filepath.Join(tempDir(t), "data"))
	if token := c.dashboardToken(t); token != suppliedTokenA {
		t.Errorf("the written-out start serves token %q, want the supplied one", token)
	}
}

// Kubernetes sets FLIGHTDECK_PORT to tcp://<ClusterIP>:<port> in every
// pod of a namespace with a Service named flightdeck. Beside the image's
// FLIGHTDECK_LISTEN it is read as unset: the server starts where the
// image says and the health check finds it.
func TestBinary_KubernetesServiceLinkPortIsIgnored(t *testing.T) {
	port := freePort(t)
	env := []string{"FLIGHTDECK_LISTEN=0.0.0.0:" + port, "FLIGHTDECK_ALLOWED_HOSTS=localhost", "FLIGHTDECK_PORT=tcp://10.96.0.5:4000"}
	c := startArgs(t, env, port, "--data-dir", filepath.Join(tempDir(t), "data"))
	if token := c.dashboardToken(t); !strings.HasPrefix(token, "ftd_") {
		t.Errorf("the image's environment serves token %q, want a minted ftd_ token", token)
	}
	if want := "  Dashboard   http://<this-host>:" + port + "   (every interface"; !strings.Contains(c.out.String(), want) {
		t.Errorf("the start-up block lacks %q:\n%s", want, c.out.String())
	}
	healthy := "healthy: http://127.0.0.1:" + port + " answers /api/health and /ingest/health\n"
	if code, out := runHealthCommand(t, env); code != 0 || out != healthy {
		t.Errorf("flightdeck health in the image's environment: exit %d, output %q; want 0 and %q", code, out, healthy)
	}
}
