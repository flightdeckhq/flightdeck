// Package metrics times the requests the ingestion API serves and
// exposes the result as a Prometheus histogram.
//
// Like the workers' counter registry it is dependency-free: the
// histogram is a mutex-guarded map of bucket counts rendered in the
// Prometheus text format by hand, so the service does not take on the
// Prometheus client library for one metric family. The query API keeps
// a twin of this package (api/internal/metrics); the two services share
// no Go module, so a change to one is made to both.
//
// Every series is labelled by route (the pattern the request matched on
// the service's ServeMux, without its method), method and status class.
// All three are bounded: a path parameter stays a placeholder in the
// pattern, a request no pattern matched is labelled UnmatchedRoute, and
// a method outside the known set is labelled OtherMethod.
package metrics

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RequestDurationName is the histogram family's name. The flightdeck_
// namespace keeps it apart from the HTTP latency families other
// services in the same cluster export under a generic name.
const RequestDurationName = "flightdeck_http_request_duration_seconds"

// requestDurationHelp is the family's # HELP text.
const requestDurationHelp = "Time the ingestion API took to serve a request, by route pattern, method and status class."

// UnmatchedRoute is the route label of a request no registered pattern
// matched (a 404 or a 405), and of a request whose method is not in
// knownMethods.
const UnmatchedRoute = "unmatched"

// OtherMethod is the method label of any method outside knownMethods,
// so a client sending made-up methods cannot mint label values.
const OtherMethod = "OTHER"

// knownMethods are the methods recorded under their own name. CONNECT
// and TRACE are left out on purpose: the ServeMux's answer to a CONNECT
// names the raw request path instead of a registered pattern, so those
// requests are labelled UnmatchedRoute to keep the route label bounded.
var knownMethods = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodPost:    true,
	http.MethodPut:     true,
	http.MethodPatch:   true,
	http.MethodDelete:  true,
	http.MethodOptions: true,
}

// RequestDurationBuckets are the histogram's upper bounds in seconds.
// The query API uses the same set so the two services' percentiles
// compare. The 1 ms and 2.5 ms buckets resolve the ingestion hot path
// (validate, publish to NATS, look up a directive), which takes one to
// two milliseconds on the dev stack; the default Prometheus set starts
// at 5 ms and would put nearly every ingestion request in its first
// bucket. 10 s is the ingestion server's write timeout and 30 s the
// query API's REST timeout, so a request that ran to either limit
// lands in a bucket of its own rather than only in +Inf.
var RequestDurationBuckets = []float64{
	0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
}

// now is the clock Middleware reads; tests replace it to time a request
// deterministically.
var now = time.Now

// readHeaderTimeout bounds how long the metrics listener waits for a
// request's headers. A scrape sends a few hundred bytes at once, so
// five seconds is generous for any real client while stopping a slow
// or idle connection from holding a goroutine open indefinitely.
const readHeaderTimeout = 5 * time.Second

// seriesKey identifies one labelled series of the histogram.
type seriesKey struct {
	route, method, statusClass string
}

// series holds one labelled series. counts[i] is the number of
// observations in (bounds[i-1], bounds[i]]; counts[len(bounds)] is the
// overflow above the last bound. Rendering makes them cumulative.
type series struct {
	counts []uint64
	sum    float64
	count  uint64
}

// RequestDurations is the request-latency histogram. The zero value is
// not usable; build one with NewRequestDurations. A nil
// *RequestDurations is valid everywhere and records nothing, so a test
// server can be built without one.
//
// One mutex guards every series. An observation is a map lookup and
// three increments, well under a microsecond, and the ingestion API's
// request rate is bounded by its per-token rate limit, so the lock is
// never contended enough to matter; it also keeps a scrape's bucket,
// sum and count of a series consistent with each other.
type RequestDurations struct {
	mu     sync.Mutex
	bounds []float64
	series map[seriesKey]*series
}

// NewRequestDurations returns an empty histogram with
// RequestDurationBuckets as its bounds.
func NewRequestDurations() *RequestDurations {
	return &RequestDurations{
		bounds: RequestDurationBuckets,
		series: map[seriesKey]*series{},
	}
}

// Observe records one request of the given duration. route, method and
// statusClass are used as given, so callers pass the bounded values
// Middleware derives.
func (d *RequestDurations) Observe(route, method, statusClass string, elapsed time.Duration) {
	if d == nil {
		return
	}
	seconds := elapsed.Seconds()
	// The first bound the observation does not exceed; len(bounds) is
	// the overflow slot.
	idx := sort.SearchFloat64s(d.bounds, seconds)
	key := seriesKey{route: route, method: method, statusClass: statusClass}

	d.mu.Lock()
	defer d.mu.Unlock()
	s, ok := d.series[key]
	if !ok {
		s = &series{counts: make([]uint64, len(d.bounds)+1)}
		d.series[key] = s
	}
	s.counts[idx]++
	s.sum += seconds
	s.count++
}

// Count returns how many requests the series with these labels has
// recorded. Used by tests.
func (d *RequestDurations) Count(route, method, statusClass string) uint64 {
	if d == nil {
		return 0
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if s, ok := d.series[seriesKey{route: route, method: method, statusClass: statusClass}]; ok {
		return s.count
	}
	return 0
}

// WriteText renders the histogram in the Prometheus text format: the
// # HELP and # TYPE lines, then for each series in sorted label order
// its cumulative _bucket samples ending in le="+Inf", its _sum and its
// _count.
func (d *RequestDurations) WriteText(w io.Writer) error {
	if _, err := fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s histogram\n",
		RequestDurationName, requestDurationHelp, RequestDurationName); err != nil {
		return err
	}
	if d == nil {
		return nil
	}

	d.mu.Lock()
	keys := make([]seriesKey, 0, len(d.series))
	snap := make(map[seriesKey]series, len(d.series))
	for k, s := range d.series {
		keys = append(keys, k)
		snap[k] = series{counts: append([]uint64(nil), s.counts...), sum: s.sum, count: s.count}
	}
	d.mu.Unlock()

	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.route != b.route {
			return a.route < b.route
		}
		if a.method != b.method {
			return a.method < b.method
		}
		return a.statusClass < b.statusClass
	})

	var b strings.Builder
	for _, k := range keys {
		s := snap[k]
		labels := fmt.Sprintf("route=%q,method=%q,status_class=%q", k.route, k.method, k.statusClass)
		var cumulative uint64
		for i, bound := range d.bounds {
			cumulative += s.counts[i]
			fmt.Fprintf(&b, "%s_bucket{%s,le=%q} %d\n", RequestDurationName, labels,
				strconv.FormatFloat(bound, 'g', -1, 64), cumulative)
		}
		fmt.Fprintf(&b, "%s_bucket{%s,le=\"+Inf\"} %d\n", RequestDurationName, labels, s.count)
		fmt.Fprintf(&b, "%s_sum{%s} %s\n", RequestDurationName, labels,
			strconv.FormatFloat(s.sum, 'g', -1, 64))
		fmt.Fprintf(&b, "%s_count{%s} %d\n", RequestDurationName, labels, s.count)
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// Handler serves the histogram in the Prometheus text format.
func Handler(d *RequestDurations) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		// A write error means the scraper went away; there is nothing
		// to answer it with.
		_ = d.WriteText(w)
	})
}

// NewServer returns the ingestion API's metrics listener: Handler at
// /metrics on addr, and 404 for every other path. The caller starts it
// with ListenAndServe and stops it with Shutdown.
func NewServer(addr string, d *RequestDurations) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", Handler(d))
	return &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
	}
}

// Middleware times every request next serves and records it in d. next
// must be, or pass the same *http.Request down to, the ServeMux: the mux
// writes the matched pattern to the request's Pattern field, which
// Middleware reads once the handler returns. A request whose connection
// the handler hijacks (a WebSocket upgrade) is not recorded, since its
// duration is the connection's lifetime rather than a latency. With a
// nil d, Middleware returns next unchanged.
func Middleware(d *RequestDurations, next http.Handler) http.Handler {
	if d == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		if sw.hijacked {
			return
		}
		method, route := Labels(r.Method, r.Pattern)
		d.Observe(route, method, StatusClass(sw.statusOrDefault()), now().Sub(start))
	})
}

// Labels maps a request's method and the pattern it matched to the
// bounded method and route labels.
func Labels(method, pattern string) (methodLabel, route string) {
	if !knownMethods[method] {
		return OtherMethod, UnmatchedRoute
	}
	return method, RouteLabel(pattern)
}

// RouteLabel turns a ServeMux pattern into the route label: the pattern
// without its leading method ("POST /v1/events" becomes "/v1/events"),
// or UnmatchedRoute for the empty pattern of a request nothing matched.
func RouteLabel(pattern string) string {
	if pattern == "" {
		return UnmatchedRoute
	}
	// A pattern is "[METHOD ][HOST]/PATH"; the path starts at the first
	// slash. These services register no host patterns.
	if i := strings.IndexByte(pattern, '/'); i >= 0 {
		return pattern[i:]
	}
	return UnmatchedRoute
}

// StatusClass returns the status class label ("2xx", "4xx", ...) of an
// HTTP status code. A code outside 100 to 599 is "other".
func StatusClass(code int) string {
	if code < 100 || code > 599 {
		return "other"
	}
	return strconv.Itoa(code/100) + "xx"
}

// statusWriter records the status the handler wrote and whether it
// hijacked the connection.
type statusWriter struct {
	http.ResponseWriter
	status   int
	hijacked bool
}

func (w *statusWriter) WriteHeader(code int) {
	// Only the first final status counts; a 1xx informational header
	// is followed by the real one.
	if w.status == 0 && code >= 200 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(p)
}

// statusOrDefault is the status the client received: a handler that
// wrote neither a header nor a body answered 200.
func (w *statusWriter) statusOrDefault() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Flush passes through to the underlying writer when it can flush.
func (w *statusWriter) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack passes through to the underlying writer and marks the request
// as hijacked, so Middleware does not record it.
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	conn, rw, err := h.Hijack()
	if err == nil {
		w.hijacked = true
	}
	return conn, rw, err
}
