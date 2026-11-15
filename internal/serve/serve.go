// Package serve builds the flightdeck binary's HTTP servers: one plain
// server on --listen, or, with --domain, an HTTPS server with
// certificates from Let's Encrypt and an HTTP server that answers the
// ACME challenge and redirects everything else.
package serve

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

const (
	// readHeaderTimeout bounds a client's request line and headers so an
	// idle opener cannot hold a connection; bodies are bounded per
	// request by the router (the services' read deadlines) and by the
	// handlers (the ingestion limits).
	readHeaderTimeout = 15 * time.Second
	// idleTimeout closes keep-alive connections a client stopped using;
	// the query API's standalone server used the same value.
	idleTimeout = 120 * time.Second
	// There is no server-wide write timeout: /api/v1/stream is a
	// WebSocket that stays open for as long as the dashboard does, and a
	// server-wide write deadline would cut it. The router sets write
	// deadlines per request on /ingest.
)

// HTTPSPort and HTTPPort are the ports the --domain mode serves on: the
// defaults a browser and the ACME HTTP-01 challenge use, and the
// reason the mode needs no port in its URL.
const (
	HTTPSPort = ":443"
	HTTPPort  = ":80"
)

// portFlagHost is the host the binary's --port serves on (cli.LoopbackHost):
// a busy port there is moved with --port alone.
const portFlagHost = "127.0.0.1"

// Server returns an HTTP server for h with the binary's timeouts.
func Server(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}
}

// Listen binds addr, turning the common failures into the message a
// first-time user needs: the port is taken (another Flightdeck, or the
// compose stack on :4000) and the flags that pick another are named; or
// the port is privileged (below 1024, as :80 and :443 of --domain are)
// and the process may not bind it.
func Listen(addr string) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		host, port, _ := net.SplitHostPort(addr)
		switch {
		case addrInUse(err):
			msg := fmt.Sprintf("%s is already in use (another flightdeck, or the compose stack, may be listening on port %s); stop it", addr, port)
			if flags := portFlags(host, nextPort(port)); flags != "" {
				msg += " or pick another port with " + flags
			}
			return nil, errors.New(msg)
		case errors.Is(err, syscall.EACCES):
			msg := fmt.Sprintf("no permission to bind %s: port %s is privileged; run as root or grant the binary "+
				"CAP_NET_BIND_SERVICE (setcap 'cap_net_bind_service=+ep' flightdeck)", addr, port)
			if flags := portFlags(host, "<port>"); flags != "" {
				msg += ", or use a port above 1023: " + flags
			}
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	return ln, nil
}

// portFlags spells the flags that serve port on the interfaces host
// names: --port for the loopback address it uses, --public --port for
// every interface, --listen for any other address. A host-less address
// is one of the fixed ports of --domain (HTTPSPort, HTTPPort), which no
// flag moves, so it has none.
func portFlags(host, port string) string {
	ip := net.ParseIP(host)
	switch {
	case host == "":
		return ""
	case host == portFlagHost:
		return "--port " + port
	case ip != nil && ip.IsUnspecified():
		return "--public --port " + port
	}
	return "--listen " + net.JoinHostPort(host, port)
}

// addrInUse reports whether a listen error means the port is taken. The
// errno matches on Unix; Windows reports WSAEADDRINUSE, which syscall's
// Errno.Is does not fold into EADDRINUSE, so its message is matched too.
func addrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "Only one usage of each socket address")
}

func nextPort(port string) string {
	var n int
	if _, err := fmt.Sscanf(port, "%d", &n); err != nil || n <= 0 || n >= 65535 {
		return "4001"
	}
	return fmt.Sprint(n + 1)
}

// ACME returns the two servers of the --domain mode: https serves h with
// a certificate autocert obtains for domain and caches in cacheDir;
// redirect answers the HTTP-01 challenge and sends every other GET or
// HEAD to https://domain with the same path and query, whatever Host
// the request carried (a request for another name on this address is
// not sent on to that name). The caller binds the listeners (Listen on
// HTTPSPort and HTTPPort, so a permission or busy-port error surfaces
// before any other work) and runs ServeTLS(ln, "", "") and Serve(ln).
func ACME(domain, cacheDir string, h http.Handler) (https, redirect *http.Server) {
	m := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(domain),
		Cache:      autocert.DirCache(cacheDir),
	}
	https = Server(h)
	https.TLSConfig = m.TLSConfig()
	redirect = &http.Server{
		Handler:           m.HTTPHandler(redirectTo(domain)),
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}
	return https, redirect
}

// redirectTo sends GET and HEAD requests to https://domain, keeping path
// and query; any other method is answered 400, since its body would be
// lost in a redirect (the same rule autocert's default handler applies).
func redirectTo(domain string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Use HTTPS", http.StatusBadRequest)
			return
		}
		target := "https://" + domain + r.URL.RequestURI()
		http.Redirect(w, r, target, http.StatusFound)
	})
}
