// Package router is the flightdeck binary's public HTTP surface: the
// embedded dashboard at /, the generated /runtime-config.json, the query
// API under /api and the ingestion API under /ingest, each path forwarded
// as sent (the services strip their own prefix). A bare /v1/... path is
// answered 404 with a hint, never routed to a service.
package router

import (
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"
)

// Config is what the router serves.
type Config struct {
	// API is the query API's handler, mounted at /api.
	API http.Handler
	// Ingest is the ingestion API's handler, mounted at /ingest.
	Ingest http.Handler
	// UI is the dashboard bundle with index.html at its root. A bundle
	// without index.html (the dashboard was not built into the binary)
	// is reported as 503 on every dashboard path.
	UI fs.FS
	// Token is the access token /runtime-config.json hands the dashboard.
	Token string
	// IngestReadTimeout and IngestWriteTimeout are the per-request
	// deadlines on /ingest, the ingestion service's own; APIReadTimeout
	// is the read deadline on /api other than the WebSocket. Zero leaves
	// a deadline unset.
	IngestReadTimeout  time.Duration
	IngestWriteTimeout time.Duration
	APIReadTimeout     time.Duration
}

// Security headers for every dashboard response: the SPA is never
// framed, content types are not sniffed, referrers stay on the origin,
// and the CSP admits only
// same-origin scripts, styles, fonts and connections (inline scripts and
// styles are what Vite's bundle and Tailwind emit).
var securityHeaders = map[string]string{
	"X-Frame-Options":         "DENY",
	"X-Content-Type-Options":  "nosniff",
	"Referrer-Policy":         "strict-origin-when-cross-origin",
	"Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
}

// assetsCacheControl is the cache policy of /assets/*: Vite puts a
// content hash in every file name, so a path's content never changes
// and a year is the longest max-age caches honour.
const assetsCacheControl = "public, max-age=31536000, immutable"

// runtimeConfigCacheControl keeps the token response out of every cache
// (HTTP/1.1), with Pragma and Expires covering HTTP/1.0 intermediaries,
// so a rotated token is never served stale.
const runtimeConfigCacheControl = "no-store, no-cache, must-revalidate"

// websocketPath is the one /api route that stays open for as long as the
// dashboard does; a read deadline would cut it.
const websocketPath = "/api/v1/stream"

// New builds the router.
func New(c Config) http.Handler {
	mux := http.NewServeMux()
	api := withDeadlines(c.API, c.APIReadTimeout, 0, func(r *http.Request) bool { return r.URL.Path == websocketPath })
	mux.Handle("/api", api)
	mux.Handle("/api/", api)
	ingest := withDeadlines(drainRefusedBody(c.Ingest), c.IngestReadTimeout, c.IngestWriteTimeout, nil)
	mux.Handle("/ingest", ingest)
	mux.Handle("/ingest/", ingest)
	mux.HandleFunc("GET /runtime-config.json", runtimeConfig(c.Token))
	mux.HandleFunc("HEAD /runtime-config.json", runtimeConfig(c.Token))
	// /investigate was the events page's earlier route; bookmarks and
	// links keep working, and the query string travels with them.
	mux.HandleFunc("GET /investigate", func(w http.ResponseWriter, r *http.Request) {
		target := "/events"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	})
	mux.HandleFunc("/v1/", v1Hint)
	mux.Handle("/", &ui{fsys: c.UI, built: fsHas(c.UI, "index.html")})
	return mux
}

// withDeadlines sets the connection's read and write deadlines for the
// request (a zero duration leaves one unset), except for requests
// exempt reports, so a client that stalls mid-body or never reads its
// response holds a connection no longer than the services' own
// listeners allowed. The deadlines come from the services' named
// constants; the one server here cannot carry them server-wide because
// the query API's WebSocket must stay open.
func withDeadlines(h http.Handler, read, write time.Duration, exempt func(*http.Request) bool) http.Handler {
	if read == 0 && write == 0 {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if exempt == nil || !exempt(r) {
			rc := http.NewResponseController(w)
			now := time.Now()
			if read > 0 {
				if err := rc.SetReadDeadline(now.Add(read)); err != nil {
					slog.Debug("read deadline not supported on this connection", "err", err)
				}
			}
			if write > 0 {
				if err := rc.SetWriteDeadline(now.Add(write)); err != nil {
					slog.Debug("write deadline not supported on this connection", "err", err)
				}
			}
		}
		h.ServeHTTP(w, r)
	})
}

// edgeDrainBytes bounds how much of a request body the edge reads after
// the ingestion handler answered without reading it, as a refused
// over-cap body (413) is. net/http drains only 256 KiB of leftover body
// before it closes the connection, and a client still sending the rest
// then sees a reset instead of the status, where a reverse proxy in
// front would have read the whole body itself. 16 MiB is the receivers' inflated
// body cap, four times the 4 MiB they accept as sent, so every body a
// well-behaved exporter could send is drained and the status reaches it;
// past that the connection closes, as it would otherwise. The drain
// runs under the request's read deadline (withDeadlines), so a stalled
// client cannot hold it open.
const edgeDrainBytes = 16 << 20

// drainRefusedBody reads what the handler left of the request body, up
// to edgeDrainBytes, so the client receives the response that was
// written rather than a connection reset.
func drainRefusedBody(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r)
		if r.Body != nil {
			_, _ = io.CopyN(io.Discard, r.Body, edgeDrainBytes)
		}
	})
}

func fsHas(fsys fs.FS, name string) bool {
	if fsys == nil {
		return false
	}
	info, err := fs.Stat(fsys, name)
	return err == nil && !info.IsDir()
}

func setSecurityHeaders(h http.Header) {
	for k, v := range securityHeaders {
		h.Set(k, v)
	}
}

func runtimeConfig(token string) http.HandlerFunc {
	body, _ := json.Marshal(map[string]string{"access_token": token})
	body = append(body, '\n')
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		setSecurityHeaders(h)
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", runtimeConfigCacheControl)
		h.Set("Pragma", "no-cache")
		h.Set("Expires", "0")
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write(body)
	}
}

// v1Hint answers a request for a bare /v1/... path: the services are
// published under /api and /ingest only, and a sensor pointed at the
// origin without the prefix should learn which one it meant.
func v1Hint(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": "no route at " + r.URL.Path + ": the ingestion API is under /ingest (FLIGHTDECK_SERVER=http://<host>/ingest) and the query API under /api",
	})
}

// ui serves the dashboard bundle: a file when the path names one, with
// the immutable cache policy under /assets/; a 404 for an /assets/ path
// that names no file (a stale hash from an old bundle must not be
// answered with HTML the browser would try to run); and index.html for
// every other path so the SPA's own router handles it.
type ui struct {
	fsys  fs.FS
	built bool
}

func (u *ui) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w.Header())
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !u.built {
		http.Error(w, "the dashboard bundle is not built into this binary; run `make build-flightdeck` (make build-webui, then go build ./cmd/flightdeck)",
			http.StatusServiceUnavailable)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name != "" && fsHas(u.fsys, name) {
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", assetsCacheControl)
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeFileFS(w, r, u.fsys, name)
		return
	}
	if strings.HasPrefix(name, "assets/") {
		http.NotFound(w, r)
		return
	}
	// The SPA's client-side routes (/events, /agents, ...) and unknown
	// paths alike load the app, which renders its own not-found page.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFileFS(w, r, u.fsys, "index.html")
}
