package connect

import "strings"

// DefaultServer is where an integration reports when no server is saved:
// a flightdeck on this machine, the binary's default listen address.
const DefaultServer = "http://localhost:4000"

// serverBase returns the base URL a server value names, by the one rule
// the sensor, the plugin and the playground share: the cases are in
// contracts/server_urls.json and server_url_test.go runs every one.
// Surrounding white space, credentials, the query, the fragment,
// trailing slashes and the scheme's default port go; the scheme and the
// host are lower-cased; a final /ingest path segment is dropped, so the
// base URL and the ingestion URL the start-up block prints are one
// server. A backslash counts as a slash, as the URL standard reads an
// http(s) URL. A value that is not an http(s) URL is returned trimmed.
func serverBase(value string) string {
	raw := strings.TrimSpace(value)
	scheme, rest, found := strings.Cut(raw, "://")
	scheme = strings.ToLower(scheme)
	if !found || (scheme != "http" && scheme != "https") {
		return raw
	}
	rest = strings.ReplaceAll(rest, "\\", "/")
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	authority, tail := rest[:end], rest[end:]
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		authority = authority[at+1:]
	}
	authority = strings.ToLower(authority)
	if (scheme == "http" && strings.HasSuffix(authority, ":80")) || (scheme == "https" && strings.HasSuffix(authority, ":443")) {
		authority = authority[:strings.LastIndex(authority, ":")]
	}
	path := tail
	if cut := strings.IndexAny(path, "?#"); cut >= 0 {
		path = path[:cut]
	}
	path = strings.TrimRight(path, "/")
	if strings.HasSuffix(path, "/ingest") {
		path = strings.TrimRight(strings.TrimSuffix(path, "/ingest"), "/")
	}
	return scheme + "://" + authority + path
}

// sameServer reports whether two server values name one server; "" is
// the integration's default, DefaultServer.
func sameServer(a, b string) bool {
	if strings.TrimSpace(a) == "" {
		a = DefaultServer
	}
	if strings.TrimSpace(b) == "" {
		b = DefaultServer
	}
	return serverBase(a) == serverBase(b)
}
