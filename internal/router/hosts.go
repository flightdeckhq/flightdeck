package router

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// HostPolicy decides which Host headers the binary answers for, on
// every route. It exists because /runtime-config.json hands the
// dashboard its token with no credential asked: a page on another site
// can point a name of its own at this machine (DNS rebinding), have the
// browser load http://that-name:4000/runtime-config.json as its own
// origin, read the token and call the API. The browser sends the
// attacker's name as Host, so refusing names the server is not known
// by closes that path. Requests are never refused for their port: a
// forwarded or published port changes it, and a rebinding page cannot
// choose it.
type HostPolicy struct {
	// Enforce is false when every Host is answered.
	Enforce bool
	// Domain is the --domain name, lower-case; "" without one.
	Domain string
	// Names are the --allowed-hosts entries, lower-case: a host name,
	// or ".example.com" for that name and every name under it.
	Names []string
}

// AnyHost is the --allowed-hosts entry that turns the check off.
const AnyHost = "*"

// NewHostPolicy returns the policy of an instance. The check is on
// when the instance listens on loopback only (the case a rebinding
// page reaches through the user's own browser), when it serves a
// --domain, and when the operator listed --allowed-hosts. A listen
// address beyond loopback with no list answers every Host: the
// operator decided who reaches it, the names it is reached by (a LAN
// name, a reverse proxy's) are not known to the binary, and refusing
// them would lock a working deployment out. An "*" entry answers every
// Host in any mode.
func NewHostPolicy(loopback bool, domain string, allowed []string) HostPolicy {
	p := HostPolicy{Domain: strings.ToLower(strings.TrimSuffix(domain, "."))}
	for _, name := range allowed {
		if name == AnyHost {
			return HostPolicy{}
		}
		p.Names = append(p.Names, strings.ToLower(name))
	}
	p.Enforce = loopback || p.Domain != "" || len(p.Names) > 0
	return p
}

// Describe is the policy for the start-up block: the hosts answered,
// and whether every other one is refused.
func (p HostPolicy) Describe() (answered string, enforced bool) {
	if !p.Enforce {
		return "any host name", false
	}
	parts := []string{"localhost", "IP addresses"}
	shown := map[string]bool{"localhost": true}
	for _, name := range append([]string{p.Domain}, p.Names...) {
		// The image's list is "localhost", which is answered anyway.
		if name != "" && !shown[name] {
			shown[name] = true
			parts = append(parts, name)
		}
	}
	return strings.Join(parts, ", "), true
}

// names reports whether host (lower-case, no port) is a name the
// instance is known by whatever the mode: an IP address, localhost or
// a name under it, the --domain, or an --allowed-hosts entry. An IP
// address is always one: a rebinding page needs a name whose DNS
// answer it controls, and the origin of an address is whatever serves
// on that address, which is this instance.
func (p HostPolicy) names(host string) bool {
	if net.ParseIP(host) != nil {
		return true
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if p.Domain != "" && host == p.Domain {
		return true
	}
	for _, name := range p.Names {
		if host == name {
			return true
		}
		if strings.HasPrefix(name, ".") && (host == name[1:] || strings.HasSuffix(host, name)) {
			return true
		}
	}
	return false
}

// hostOf returns the host of a Host header or an origin's authority:
// lower-case, without the port, the brackets of an IPv6 literal and a
// trailing dot. ok is false for an empty or malformed value.
func hostOf(hostport string) (host string, ok bool) {
	h := strings.TrimSpace(hostport)
	if strings.HasPrefix(h, "[") {
		end := strings.IndexByte(h, ']')
		if end < 0 || !portOrNone(h[end+1:]) {
			return "", false
		}
		h = h[1:end]
		if net.ParseIP(h) == nil {
			return "", false
		}
		return strings.ToLower(h), true
	}
	if i := strings.LastIndexByte(h, ':'); i >= 0 {
		// One colon separates a port; more are an IPv6 literal without
		// its brackets, which no client sends.
		if strings.Count(h, ":") > 1 || !portOrNone(h[i:]) {
			return "", false
		}
		h = h[:i]
	}
	h = strings.ToLower(strings.TrimSuffix(h, "."))
	if h == "" || len(h) > maxHostNameBytes || strings.ContainsAny(h, "/\\@ \t") {
		return "", false
	}
	return h, true
}

// maxHostNameBytes is the longest host name a Host header may carry:
// 253, the most a DNS name can spell out (RFC 1035's 255 octets on the
// wire). A longer value is no name at all, and the refused host is
// echoed in the 421 body and the log, so this also bounds what a
// request can put there.
const maxHostNameBytes = 253

// portOrNone reports whether s is empty or ":" and a decimal port.
func portOrNone(s string) bool {
	if s == "" {
		return true
	}
	if len(s) < 2 || len(s) > 6 || s[0] != ':' {
		return false
	}
	for _, c := range s[1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// refusedHostLogLimit is how many distinct refused host names the
// process logs and remembers. One line each tells an operator which
// name a client used and what to set; a scanner sending a different
// Host on every request must grow neither the log nor the set past it,
// and twenty is more names than any deployment is reached by. One more
// line says when the limit is reached.
const refusedHostLogLimit = 20

// malformedHost stands for a Host header that is missing or not a host
// name, in the log and as the key of the logged set.
const malformedHost = "(missing or malformed)"

// hostGuard applies a HostPolicy in front of the router.
type hostGuard struct {
	policy HostPolicy
	next   http.Handler

	mu     sync.Mutex
	logged map[string]bool
	// full is set once the limit was reached and said so.
	full bool
}

func (g *hostGuard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, ok := hostOf(r.Host)
	if g.policy.Enforce && (!ok || !g.policy.names(host)) {
		g.logRefused(host, ok)
		refuse(w, http.StatusMisdirectedRequest, misdirected(host, ok))
		return
	}
	// The fleet stream is the one route a browser opens with the token
	// in the URL. A page on another site that opens it must come from a
	// name this instance is known by, whatever the mode; a client that
	// is not a browser sends no Origin.
	if r.URL.Path == websocketPath {
		if origin := r.Header.Get("Origin"); origin != "" && !g.originAllowed(origin, host, ok) {
			refuse(w, http.StatusForbidden, "the fleet stream is not opened from pages of another site")
			return
		}
	}
	g.next.ServeHTTP(w, r)
}

// originAllowed reports whether a page at origin may open the stream of
// the instance asked for as host: the same host (the dashboard itself;
// the port may differ behind a proxy), or a name the instance is known
// by.
func (g *hostGuard) originAllowed(origin, host string, hostOK bool) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	originHost, ok := hostOf(u.Host)
	if !ok {
		return false
	}
	return (hostOK && originHost == host) || g.policy.names(originHost)
}

// misdirected is the 421 body's message: the host that was refused, as
// the server read it (lower-case, without its port: an entry of the
// list names no port), and the exact setting that admits it. host is
// at most maxHostNameBytes and holds none of the characters hostOf
// refuses; the JSON encoding escapes the rest. The names the operator
// listed are not repeated: they are no secret, but the requester has
// no need of them.
func misdirected(host string, ok bool) string {
	if !ok {
		return "this server answers only for the host names it is reached by, and the request's Host header is missing or is not a host name"
	}
	return fmt.Sprintf("this server does not answer for the host name %q; if it is reached by that name, "+
		"add %s to the comma-separated list in FLIGHTDECK_ALLOWED_HOSTS or --allowed-hosts and restart it "+
		"(localhost and IP addresses are always answered)", host, host)
}

// logRefused logs one line for each distinct refused host name, up to
// refusedHostLogLimit, then one line saying no more are logged.
func (g *hostGuard) logRefused(host string, ok bool) {
	if !ok {
		host = malformedHost
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.logged[host] || g.full {
		return
	}
	if len(g.logged) >= refusedHostLogLimit {
		g.full = true
		slog.Warn("further requests for host names this server does not answer for are refused (421) without a log line",
			"distinct_hosts_logged", refusedHostLogLimit)
		return
	}
	if g.logged == nil {
		g.logged = map[string]bool{}
	}
	g.logged[host] = true
	if !ok {
		slog.Warn("a request was refused (421): its Host header is missing or is not a host name", "host", host)
		return
	}
	slog.Warn("a request was refused (421): its Host header names a host this server does not answer for; "+
		"if it is reached by that name, add it to FLIGHTDECK_ALLOWED_HOSTS or --allowed-hosts", "host", host)
}

// refuse answers a request the guard turns away: one line of JSON. It
// carries no secret; the only thing it repeats from the request is the
// refused host name, which misdirected bounds.
func refuse(w http.ResponseWriter, status int, message string) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
