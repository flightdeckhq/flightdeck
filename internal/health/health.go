// Package health asks a running flightdeck whether it serves: the
// `flightdeck health` command. It exists for container health checks:
// the image is distroless, with no shell and no curl, so the binary
// probes itself.
package health

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/serve"
)

// Timeout bounds the whole check, both probes together. The two health
// routes answer in a millisecond; three seconds is slack for a loaded
// machine and stays under the five-second probe timeout the image's
// HEALTHCHECK and the documented Compose and Kubernetes probes set, so
// the command reports why it failed instead of being killed mid-probe.
const Timeout = 3 * time.Second

// maxBodyBytes bounds how much of a health response is read. The
// services answer about forty bytes; anything larger is not theirs.
const maxBodyBytes = 4 << 10

// loopbackV4 and loopbackV6 are where a listener bound to every
// interface is reached from the machine itself.
const (
	loopbackV4 = "127.0.0.1"
	loopbackV6 = "::1"
)

// endpoints are the health routes of the two services that have one,
// on the binary's one listener, with the service name each answers.
// The workers have no route: they run in the same process, and the
// binary exits when one of its services fails.
var endpoints = []struct{ path, service string }{
	{"/api/health", "api"},
	{"/ingest/health", "ingestion"},
}

// Target is where a running instance is reached from its own machine.
type Target struct {
	// Base is the URL the health routes are appended to.
	Base string
	// ServerName is the instance's --domain: the TLS server name and
	// the Host header the probes send, as a browser's request for the
	// domain carries them; empty over plain HTTP.
	ServerName string
}

// TargetFor returns the target of an instance started with the given
// --listen and --domain, the two settings that decide where it serves.
// With a domain the instance serves TLS on :443 and ignores --listen.
// A listen address on every interface (":4000", "0.0.0.0:4000",
// "[::]:4000") is reached on loopback; one that names an interface or
// a host is reached there, since nothing listens on loopback then.
func TargetFor(listen, domain string) (Target, error) {
	if domain != "" {
		port := strings.TrimPrefix(serve.HTTPSPort, ":")
		return Target{Base: "https://" + net.JoinHostPort(loopbackV4, port), ServerName: domain}, nil
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return Target{}, fmt.Errorf("listen address %q: %w", listen, err)
	}
	if port == "" {
		return Target{}, fmt.Errorf("listen address %q has no port", listen)
	}
	if host == "" {
		host = loopbackV4
	} else if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		if ip.To4() != nil {
			host = loopbackV4
		} else {
			host = loopbackV6
		}
	}
	return Target{Base: "http://" + net.JoinHostPort(host, port)}, nil
}

// Check probes both health routes of t and returns nil when each
// answers 200 with its service's own body. The first failure is
// returned, naming the URL. ctx bounds the check (see Timeout).
//
// The probes send no token: the health routes need none. Over TLS the
// certificate is not verified. The probe goes to this machine's own
// listener, sends nothing secret and trusts nothing it reads beyond
// "the services answer"; verifying would add failures that are not the
// instance's (a clock that is off, a private CA) while a handshake
// that fails for want of any certificate still fails the check.
func Check(ctx context.Context, t Target) error {
	// A transport of its own, not the default one: no proxy from the
	// environment (the target is this machine) and no connection kept
	// past the command.
	transport := &http.Transport{DisableKeepAlives: true}
	if t.ServerName != "" {
		transport.TLSClientConfig = &tls.Config{
			ServerName: t.ServerName,
			// A probe of this machine's own listener; see the
			// function comment for why the chain is not verified.
			InsecureSkipVerify: true,
			MinVersion:         tls.VersionTLS12,
		}
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		// A redirect is not a health answer.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	for _, e := range endpoints {
		if err := probe(ctx, client, t.Base+e.path, t.ServerName, e.service); err != nil {
			return err
		}
	}
	return nil
}

func probe(ctx context.Context, client *http.Client, target, host, service string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return fmt.Errorf("%s: %w", target, err)
	}
	if host != "" {
		// The request is for the domain, on this machine's address.
		req.Host = host
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("%s: no answer in time", target)
		}
		// net/http wraps a transport error as `Get "<url>": ...`; the
		// URL is named once, here.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return fmt.Errorf("%s: %w", target, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: status %d", target, resp.StatusCode)
	}
	var body struct {
		Status  string `json:"status"`
		Service string `json:"service"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(&body); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("%s: no answer in time", target)
		}
		return fmt.Errorf("%s: the answer is not a flightdeck health response", target)
	}
	if body.Status != "ok" || body.Service != service {
		return fmt.Errorf("%s: answered status %q for service %q, want \"ok\" for %q", target, body.Status, body.Service, service)
	}
	return nil
}
