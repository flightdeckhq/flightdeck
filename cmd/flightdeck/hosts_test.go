package main

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// The host check against the real binary. /runtime-config.json hands
// the dashboard its token with no credential asked, so a page on
// another site that points a name of its own at this machine (DNS
// rebinding) must be refused before it is served: the browser sends
// that name as Host.

// getWithHost sends GET path to the child's address with host as the
// Host header and returns the status and the body.
func (c *child) getWithHost(t *testing.T, path, host string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, c.base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = host
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s (Host %s): %v", path, host, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(body)
}

// dialStream opens the fleet stream as a page at origin would.
func dialStream(port, origin string) (*websocket.Conn, int, error) {
	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	ws, resp, err := websocket.DefaultDialer.Dial("ws://127.0.0.1:"+port+"/api/v1/stream?token=tok_dev", header)
	status := 0
	if resp != nil {
		status = resp.StatusCode
		_ = resp.Body.Close()
	}
	return ws, status, err
}

func TestBinary_ALoopbackListenAnswersOnlyForItsOwnNames(t *testing.T) {
	port := freePort(t)
	c := start(t, "127.0.0.1:"+port, port, filepath.Join(tempDir(t), "data"))

	for _, host := range []string{"127.0.0.1:" + port, "localhost:" + port, "LOCALHOST:" + port, "[::1]:" + port, "localhost:8080"} {
		code, body := c.getWithHost(t, "/runtime-config.json", host)
		if code != http.StatusOK || !strings.Contains(body, `"access_token":"tok_dev"`) {
			t.Errorf("Host %s: /runtime-config.json answered %d %q, want the dashboard's token", host, code, body)
		}
	}
	for _, host := range []string{"evil.example:" + port, "evil.example", "localhost.evil.example:" + port, "127.0.0.1.evil.example:" + port} {
		for _, path := range []string{"/runtime-config.json", "/", "/api/health", "/ingest/health", "/api/v1/sessions"} {
			code, body := c.getWithHost(t, path, host)
			if code != http.StatusMisdirectedRequest {
				t.Errorf("Host %s: GET %s answered %d, want 421", host, path, code)
			}
			if strings.Contains(body, "tok_dev") || strings.Contains(body, "access_token") {
				t.Errorf("Host %s: GET %s was refused but carries the token: %q", host, path, body)
			}
		}
	}
	if !strings.Contains(c.out.String(), "a request was refused (421)") {
		t.Errorf("the log does not say why a request was refused:\n%s", c.out.String())
	}

	// The fleet stream: the dashboard's own page and a client that is
	// not a browser open it; a page on another site does not, even
	// with a valid token in the URL.
	for _, origin := range []string{"", "http://127.0.0.1:" + port, "http://localhost:" + port, "http://localhost:5173"} {
		ws, status, err := dialStream(port, origin)
		if err != nil {
			t.Errorf("Origin %q: the stream did not open (status %d): %v", origin, status, err)
			continue
		}
		_ = ws.Close()
	}
	for _, origin := range []string{"https://evil.example", "http://evil.example:" + port, "null"} {
		ws, status, err := dialStream(port, origin)
		if err == nil {
			_ = ws.Close()
			t.Errorf("Origin %q: the stream opened for a page on another site", origin)
			continue
		}
		if status != http.StatusForbidden {
			t.Errorf("Origin %q: the stream answered %d, want 403", origin, status)
		}
	}
}

// Beyond loopback the binary answers any name unless the operator
// lists the ones it is reached by; with a list the check is on.
func TestBinary_AllowedHostsBeyondLoopback(t *testing.T) {
	t.Run("no list: any name is answered", func(t *testing.T) {
		port := freePort(t)
		c := start(t, "0.0.0.0:"+port, port, filepath.Join(tempDir(t), "data"))
		for _, host := range []string{"nas.lan:" + port, "fd.example.com", "127.0.0.1:" + port} {
			if code, _ := c.getWithHost(t, "/api/health", host); code != http.StatusOK {
				t.Errorf("Host %s: /api/health answered %d, want 200", host, code)
			}
		}
	})
	t.Run("a list: the listed names, localhost and addresses", func(t *testing.T) {
		port := freePort(t)
		c := startWithEnv(t, []string{"FLIGHTDECK_ALLOWED_HOSTS=fd.internal,.corp.example"}, "0.0.0.0:"+port, port, filepath.Join(tempDir(t), "data"))
		for _, host := range []string{"fd.internal:" + port, "a.corp.example", "localhost:" + port, "127.0.0.1:" + port, "192.168.1.10:" + port} {
			if code, _ := c.getWithHost(t, "/runtime-config.json", host); code != http.StatusOK {
				t.Errorf("Host %s: /runtime-config.json answered %d, want 200", host, code)
			}
		}
		token := c.dashboardToken(t)
		for _, host := range []string{"evil.example:" + port, "x.fd.internal"} {
			code, body := c.getWithHost(t, "/runtime-config.json", host)
			if code != http.StatusMisdirectedRequest || strings.Contains(body, token) {
				t.Errorf("Host %s: /runtime-config.json answered %d %q, want 421 without the token", host, code, body)
			}
		}
		// The health command probes on loopback by address, which the
		// list never has to name.
		if code, out := runHealthCommand(t, []string{"FLIGHTDECK_ALLOWED_HOSTS=fd.internal"}, "--listen", "0.0.0.0:"+port); code != 0 {
			t.Errorf("flightdeck health: exit %d: %s", code, out)
		}
	})
}
