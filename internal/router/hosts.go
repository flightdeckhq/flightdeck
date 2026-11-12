package router

import (
	"encoding/json"
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
	if h == "" || strings.ContainsAny(h, "/\\@ \t") {
		return "", false
	}
	return h, true
}

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

// refusedHostLogLimit is how many distinct refused Host values the
// process logs. One line each tells an operator why a name they use is
// answered 421 and what to set; a scanner sending a different Host on
// every request must not fill the log, and twenty is more names than
// any deployment is reached by.
const refusedHostLogLimit = 20

// hostGuard applies a HostPolicy in front of the router.
type hostGuard struct {
	policy HostPolicy
	next   http.Handler

	mu     sync.Mutex
	logged map[string]bool
}

func (g *hostGuard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, ok := hostOf(r.Host)
	if g.policy.Enforce && (!ok || !g.policy.names(host)) {
		g.logRefused(r.Host)
		refuse(w, http.StatusMisdirectedRequest,
			"this server does not answer for the host name in the request; reach it by localhost or an IP address, "+
				"or start it with that name in --allowed-hosts (FLIGHTDECK_ALLOWED_HOSTS)")
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

func (g *hostGuard) logRefused(host string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.logged[host] || len(g.logged) >= refusedHostLogLimit {
		return
	}
	if g.logged == nil {
		g.logged = map[string]bool{}
	}
	g.logged[host] = true
	slog.Warn("a request was refused (421): its Host header names a host this server does not answer for; "+
		"if this server is reached by that name, start it with --allowed-hosts (FLIGHTDECK_ALLOWED_HOSTS)", "host", host)
}

// refuse answers a request the guard turns away: one line of JSON that
// repeats nothing from the request.
func refuse(w http.ResponseWriter, status int, message string) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
