package handlers_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/server"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	metricspb "go.opentelemetry.io/proto/slim/otlp/metrics/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// otlpFixtureRoot holds the OTLP requests Claude Code 2.1.316 exported,
// one directory per scenario.
var otlpFixtureRoot = filepath.Join("..", "..", "tests", "fixtures", "otlp", "claude-code-2.1.316")

// The sizes the receiver's limits are stated in.
const (
	otlpTestCompressedCap   = 4 << 20
	otlpTestDecompressedCap = 16 << 20
)

type otlpManifest struct {
	Scenario string `json:"scenario"`
	Requests []struct {
		File         string `json:"file"`
		Path         string `json:"path"`
		ContentType  string `json:"content_type"`
		SentEncoding string `json:"sent_encoding"`
	} `json:"requests"`
}

func loadOTLPManifests(t *testing.T) map[string]otlpManifest {
	t.Helper()
	entries, err := os.ReadDir(otlpFixtureRoot)
	if err != nil {
		t.Fatalf("read OTLP fixtures: %v", err)
	}
	out := map[string]otlpManifest{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(otlpFixtureRoot, e.Name(), "manifest.json"))
		if err != nil {
			t.Fatalf("read manifest of %s: %v", e.Name(), err)
		}
		var m otlpManifest
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("parse manifest of %s: %v", e.Name(), err)
		}
		out[e.Name()] = m
	}
	if len(out) == 0 {
		t.Fatal("no OTLP fixture scenarios found")
	}
	return out
}

// countOTLPRecords is the number of records a request carries, in the
// unit its signal's partial_success counts (log records, spans, data
// points), counted from the decoded request independently of the
// receiver: protobuf through the collector types, JSON by walking the
// generic tree.
func countOTLPRecords(t *testing.T, path, contentType string, body []byte) int64 {
	t.Helper()
	if contentType == "application/x-protobuf" {
		var n int64
		switch path {
		case "/v1/logs":
			req := &collogs.ExportLogsServiceRequest{}
			mustProto(t, body, req)
			for _, rl := range req.GetResourceLogs() {
				for _, sl := range rl.GetScopeLogs() {
					n += int64(len(sl.GetLogRecords()))
				}
			}
		case "/v1/traces":
			req := &coltrace.ExportTraceServiceRequest{}
			mustProto(t, body, req)
			for _, rs := range req.GetResourceSpans() {
				for _, ss := range rs.GetScopeSpans() {
					n += int64(len(ss.GetSpans()))
				}
			}
		case "/v1/metrics":
			req := &colmetrics.ExportMetricsServiceRequest{}
			mustProto(t, body, req)
			for _, rm := range req.GetResourceMetrics() {
				for _, sm := range rm.GetScopeMetrics() {
					for _, m := range sm.GetMetrics() {
						n += protoDataPoints(m)
					}
				}
			}
		}
		return n
	}

	var tree map[string]any
	if err := json.Unmarshal(body, &tree); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	list := func(v any, key string) []any {
		m, _ := v.(map[string]any)
		l, _ := m[key].([]any)
		return l
	}
	var n int64
	switch path {
	case "/v1/logs":
		for _, rl := range list(tree, "resourceLogs") {
			for _, sl := range list(rl, "scopeLogs") {
				n += int64(len(list(sl, "logRecords")))
			}
		}
	case "/v1/traces":
		for _, rs := range list(tree, "resourceSpans") {
			for _, ss := range list(rs, "scopeSpans") {
				n += int64(len(list(ss, "spans")))
			}
		}
	case "/v1/metrics":
		for _, rm := range list(tree, "resourceMetrics") {
			for _, sm := range list(rm, "scopeMetrics") {
				for _, m := range list(sm, "metrics") {
					for _, kind := range []string{"gauge", "sum", "histogram", "exponentialHistogram", "summary"} {
						if data, ok := m.(map[string]any)[kind]; ok {
							n += int64(len(list(data, "dataPoints")))
						}
					}
				}
			}
		}
	}
	return n
}

func protoDataPoints(m *metricspb.Metric) int64 {
	switch {
	case m.GetGauge() != nil:
		return int64(len(m.GetGauge().GetDataPoints()))
	case m.GetSum() != nil:
		return int64(len(m.GetSum().GetDataPoints()))
	case m.GetHistogram() != nil:
		return int64(len(m.GetHistogram().GetDataPoints()))
	case m.GetExponentialHistogram() != nil:
		return int64(len(m.GetExponentialHistogram().GetDataPoints()))
	case m.GetSummary() != nil:
		return int64(len(m.GetSummary().GetDataPoints()))
	}
	return 0
}

func mustProto(t *testing.T, body []byte, msg proto.Message) {
	t.Helper()
	if err := proto.Unmarshal(body, msg); err != nil {
		t.Fatalf("fixture is not protobuf: %v", err)
	}
}

func gzipBytes(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// otlpPartialSuccess is a decoded export response's partial_success.
type otlpPartialSuccess struct {
	present  bool
	rejected int64
	message  string
}

// decodeOTLPResponse decodes the export response for path in the
// encoding of contentType.
func decodeOTLPResponse(t *testing.T, path, contentType string, body []byte) otlpPartialSuccess {
	t.Helper()
	unmarshal := func(msg proto.Message) {
		var err error
		if contentType == "application/x-protobuf" {
			err = proto.Unmarshal(body, msg)
		} else {
			err = protojson.Unmarshal(body, msg)
		}
		if err != nil {
			t.Fatalf("decode %s response %q: %v", path, body, err)
		}
	}
	switch path {
	case "/v1/logs":
		resp := &collogs.ExportLogsServiceResponse{}
		unmarshal(resp)
		ps := resp.GetPartialSuccess()
		return otlpPartialSuccess{ps != nil, ps.GetRejectedLogRecords(), ps.GetErrorMessage()}
	case "/v1/traces":
		resp := &coltrace.ExportTraceServiceResponse{}
		unmarshal(resp)
		ps := resp.GetPartialSuccess()
		return otlpPartialSuccess{ps != nil, ps.GetRejectedSpans(), ps.GetErrorMessage()}
	case "/v1/metrics":
		resp := &colmetrics.ExportMetricsServiceResponse{}
		unmarshal(resp)
		ps := resp.GetPartialSuccess()
		return otlpPartialSuccess{ps != nil, ps.GetRejectedDataPoints(), ps.GetErrorMessage()}
	}
	t.Fatalf("unknown OTLP path %s", path)
	return otlpPartialSuccess{}
}

// stubDialect maps every request to a fixed list of events and a fixed
// rejected count, to drive the receiver's publish path.
type stubDialect struct {
	events   []handlers.OTLPEvent
	rejected int64
}

func (d stubDialect) mapping() handlers.OTLPMapping {
	return handlers.OTLPMapping{Events: d.events, Rejected: d.rejected}
}

func (d stubDialect) MapLogs(context.Context, *collogs.ExportLogsServiceRequest) handlers.OTLPMapping {
	return d.mapping()
}

func (d stubDialect) MapTraces(context.Context, *coltrace.ExportTraceServiceRequest) handlers.OTLPMapping {
	return d.mapping()
}

func (d stubDialect) MapMetrics(context.Context, *colmetrics.ExportMetricsServiceRequest) handlers.OTLPMapping {
	return d.mapping()
}

// failingPublisher fails every publish.
type failingPublisher struct{ calls int }

func (p *failingPublisher) Publish(string, []byte) (uint64, error) {
	p.calls++
	return 0, errors.New("nats unavailable")
}

// otlpTestMux routes the three OTLP paths as the server does.
func otlpTestMux(v handlers.TokenValidator, p handlers.EventPublisher, d handlers.OTLPDialect, l *handlers.RateLimiter) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("POST /v1/logs", handlers.OTLPLogsHandler(v, p, d, l))
	mux.Handle("POST /v1/traces", handlers.OTLPTracesHandler(v, p, d, l))
	mux.Handle("POST /v1/metrics", handlers.OTLPMetricsHandler(v, p, d, l))
	return mux
}

func otlpRequest(path, contentType, encoding string, body []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if encoding != "" {
		req.Header.Set("Content-Encoding", encoding)
	}
	return req
}

// Every recorded Claude Code request is answered 200 in its own
// encoding, with every record counted as rejected: no dialect is mapped.
func TestOTLPFixturesAnswered200AllRejected(t *testing.T) {
	limiter := handlers.NewRateLimiter(handlers.DefaultRateLimitPerMinute)
	defer limiter.Close()
	pub := &mockPublisher{}
	mux := otlpTestMux(&mockValidator{valid: true}, pub, handlers.UnmappedDialect{}, limiter)

	replayed := 0
	for name, m := range loadOTLPManifests(t) {
		for _, r := range m.Requests {
			t.Run(name+"/"+r.File, func(t *testing.T) {
				raw, err := os.ReadFile(filepath.Join(otlpFixtureRoot, name, r.File))
				if err != nil {
					t.Fatal(err)
				}
				want := countOTLPRecords(t, r.Path, r.ContentType, raw)
				if want == 0 {
					t.Fatalf("fixture %s carries no records", r.File)
				}
				body, encoding := raw, ""
				if r.SentEncoding == "gzip" {
					body, encoding = gzipBytes(t, raw), "gzip"
				}

				w := httptest.NewRecorder()
				mux.ServeHTTP(w, otlpRequest(r.Path, r.ContentType, encoding, body))

				if w.Code != http.StatusOK {
					t.Fatalf("status = %d, body %q", w.Code, w.Body.String())
				}
				if ct := w.Header().Get("Content-Type"); ct != r.ContentType {
					t.Errorf("response Content-Type = %q, want the request's %q", ct, r.ContentType)
				}
				ps := decodeOTLPResponse(t, r.Path, r.ContentType, w.Body.Bytes())
				if !ps.present {
					t.Fatal("partial_success missing")
				}
				if ps.rejected != want {
					t.Errorf("rejected = %d, want the request's %d records", ps.rejected, want)
				}
				if !strings.Contains(ps.message, "not mapped") || !strings.Contains(ps.message, `"claude-code"`) {
					t.Errorf("message = %q, want it to name the unmapped source", ps.message)
				}
			})
			replayed++
		}
	}
	if replayed < 5 {
		t.Fatalf("replayed %d fixture requests, want every scenario", replayed)
	}
	if len(pub.published) != 0 {
		t.Errorf("published %d events with no dialect mapped", len(pub.published))
	}
}

// The protobuf fixtures also decode sent uncompressed, and the JSON
// ones sent gzipped: the encoding and the compression are independent.
func TestOTLPFixturesOtherCompression(t *testing.T) {
	mux := otlpTestMux(&mockValidator{valid: true}, &mockPublisher{}, handlers.UnmappedDialect{}, nil)
	for name, m := range loadOTLPManifests(t) {
		r := m.Requests[0]
		raw, err := os.ReadFile(filepath.Join(otlpFixtureRoot, name, r.File))
		if err != nil {
			t.Fatal(err)
		}
		body, encoding := gzipBytes(t, raw), "gzip"
		if r.SentEncoding == "gzip" {
			body, encoding = raw, ""
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, otlpRequest(r.Path, r.ContentType, encoding, body))
		if w.Code != http.StatusOK {
			t.Errorf("%s/%s with encoding %q: status %d, body %q", name, r.File, encoding, w.Code, w.Body.String())
		}
	}
}

// A request with no records is fully accepted: partial_success unset.
func TestOTLPEmptyRequestNoPartialSuccess(t *testing.T) {
	mux := otlpTestMux(&mockValidator{valid: true}, &mockPublisher{}, handlers.UnmappedDialect{}, nil)
	for _, path := range []string{"/v1/logs", "/v1/traces", "/v1/metrics"} {
		for _, ct := range []string{"application/json", "application/x-protobuf"} {
			body := []byte("{}")
			if ct == "application/x-protobuf" {
				body = nil
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, otlpRequest(path, ct, "", body))
			if w.Code != http.StatusOK {
				t.Fatalf("%s %s: status %d", path, ct, w.Code)
			}
			if ps := decodeOTLPResponse(t, path, ct, w.Body.Bytes()); ps.present {
				t.Errorf("%s %s: partial_success set on an empty request: %+v", path, ct, ps)
			}
		}
	}
}

// A media type with parameters and in another case is still the OTLP
// JSON media type.
func TestOTLPContentTypeParameters(t *testing.T) {
	mux := otlpTestMux(&mockValidator{valid: true}, &mockPublisher{}, handlers.UnmappedDialect{}, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "Application/JSON; charset=utf-8", "", []byte("{}")))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("response Content-Type = %q", ct)
	}
}

// decodeStatus decodes a google.rpc.Status error body in the encoding
// of contentType.
func decodeStatus(t *testing.T, contentType string, body []byte) (int32, string) {
	t.Helper()
	if contentType != "application/x-protobuf" {
		var st handlers.OTLPStatus
		if err := json.Unmarshal(body, &st); err != nil {
			t.Fatalf("error body %q is not a JSON Status: %v", body, err)
		}
		return st.Code, st.Message
	}
	var (
		code int32
		msg  string
	)
	for len(body) > 0 {
		num, typ, n := protowire.ConsumeTag(body)
		if n < 0 {
			t.Fatalf("error body is not a protobuf Status")
		}
		body = body[n:]
		switch {
		case num == 1 && typ == protowire.VarintType:
			v, m := protowire.ConsumeVarint(body)
			code, body = int32(v), body[m:]
		case num == 2 && typ == protowire.BytesType:
			v, m := protowire.ConsumeString(body)
			msg, body = v, body[m:]
		default:
			t.Fatalf("unexpected Status field %d", num)
		}
	}
	return code, msg
}

func TestOTLPErrorPaths(t *testing.T) {
	validLogs, err := os.ReadFile(filepath.Join(otlpFixtureRoot, "bash-protobuf-gzip", "002-logs.pb"))
	if err != nil {
		t.Fatal(err)
	}
	bomb := gzipBytes(t, make([]byte, otlpTestDecompressedCap+1))
	tooBig := make([]byte, otlpTestCompressedCap+1)

	cases := []struct {
		name        string
		path        string
		contentType string
		encoding    string
		auth        string
		body        []byte
		validator   *mockValidator
		wantStatus  int
		wantCode    int32
	}{
		{"no token", "/v1/logs", "application/x-protobuf", "", "", validLogs, nil, http.StatusUnauthorized, 16},
		{"not a bearer token", "/v1/logs", "application/json", "", "Basic dG9rOg==", []byte("{}"), nil, http.StatusUnauthorized, 16},
		{"invalid token", "/v1/traces", "application/json", "", "Bearer bad", []byte("{}"), &mockValidator{valid: false, reason: "token revoked"}, http.StatusUnauthorized, 16},
		{"protobuf undecodable", "/v1/logs", "application/x-protobuf", "", "", []byte{0xff, 0xff, 0xff}, nil, http.StatusBadRequest, 3},
		{"JSON undecodable", "/v1/metrics", "application/json", "", "", []byte(`{"resourceMetrics":`), nil, http.StatusBadRequest, 3},
		{"JSON of the wrong shape", "/v1/logs", "application/json", "", "", []byte(`{"resourceLogs":"x"}`), nil, http.StatusBadRequest, 3},
		{"JSON id not hex", "/v1/traces", "application/json", "", "", []byte(`{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"xyz"}]}]}]}`), nil, http.StatusBadRequest, 3},
		{"gzip header but not gzip", "/v1/logs", "application/x-protobuf", "gzip", "", validLogs, nil, http.StatusBadRequest, 3},
		{"truncated gzip", "/v1/logs", "application/x-protobuf", "gzip", "", gzipBytes(t, validLogs)[:20], nil, http.StatusBadRequest, 3},
		{"over 4 MiB as sent", "/v1/logs", "application/x-protobuf", "", "", tooBig, nil, http.StatusRequestEntityTooLarge, 8},
		{"over 16 MiB decompressed", "/v1/metrics", "application/json", "gzip", "", bomb, nil, http.StatusRequestEntityTooLarge, 8},
		{"text/plain", "/v1/logs", "text/plain", "", "", []byte("{}"), nil, http.StatusUnsupportedMediaType, 3},
		{"no content type", "/v1/logs", "", "", "", []byte("{}"), nil, http.StatusUnsupportedMediaType, 3},
		{"protobuf alias not in OTLP", "/v1/logs", "application/protobuf", "", "", validLogs, nil, http.StatusUnsupportedMediaType, 3},
		{"unsupported content encoding", "/v1/logs", "application/json", "br", "", []byte("{}"), nil, http.StatusUnsupportedMediaType, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := tc.validator
			if v == nil {
				v = &mockValidator{valid: true}
			}
			pub := &mockPublisher{}
			mux := otlpTestMux(v, pub, handlers.UnmappedDialect{}, nil)
			req := otlpRequest(tc.path, tc.contentType, tc.encoding, tc.body)
			req.Header.Del("Authorization")
			switch {
			case tc.auth != "":
				req.Header.Set("Authorization", tc.auth)
			case tc.name != "no token":
				req.Header.Set("Authorization", "Bearer tok")
			}

			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			if w.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body %q", w.Code, tc.wantStatus, w.Body.String())
			}
			// The error body is a google.rpc.Status in the request's
			// encoding; an unsupported media type is answered in JSON.
			respType := "application/json"
			if tc.contentType == "application/x-protobuf" {
				respType = "application/x-protobuf"
			}
			if ct := w.Header().Get("Content-Type"); ct != respType {
				t.Errorf("Content-Type = %q, want %q", ct, respType)
			}
			code, msg := decodeStatus(t, respType, w.Body.Bytes())
			if code != tc.wantCode {
				t.Errorf("Status.code = %d, want %d", code, tc.wantCode)
			}
			if msg == "" {
				t.Error("Status.message is empty")
			}
			if len(pub.published) != 0 {
				t.Errorf("a refused request published %d events", len(pub.published))
			}
		})
	}
}

// The token's revocation reason reaches the exporter.
func TestOTLPInvalidTokenReason(t *testing.T) {
	mux := otlpTestMux(&mockValidator{valid: false, reason: "token revoked"}, &mockPublisher{}, handlers.UnmappedDialect{}, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", []byte("{}")))
	if _, msg := decodeStatus(t, "application/json", w.Body.Bytes()); msg != "token revoked" {
		t.Errorf("message = %q", msg)
	}
}

// A Content-Length over the cap is refused without reading the body.
func TestOTLPContentLengthOverCapRefusedUnread(t *testing.T) {
	mux := otlpTestMux(&mockValidator{valid: true}, &mockPublisher{}, handlers.UnmappedDialect{}, nil)
	body := &countingReader{r: bytes.NewReader([]byte("{}"))}
	req := httptest.NewRequest(http.MethodPost, "/v1/logs", body)
	req.Header.Set("Authorization", "Bearer tok")
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = otlpTestCompressedCap + 1
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", w.Code)
	}
	if body.read != 0 {
		t.Errorf("read %d bytes of a body refused by its Content-Length", body.read)
	}
}

// A body exactly at each cap is accepted.
func TestOTLPBodyAtCapsAccepted(t *testing.T) {
	mux := otlpTestMux(&mockValidator{valid: true}, &mockPublisher{}, handlers.UnmappedDialect{}, nil)

	// JSON whitespace pads a valid empty request to the exact size.
	padded := func(size int) []byte {
		b := bytes.Repeat([]byte(" "), size)
		copy(b, "{}")
		return b
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", padded(otlpTestCompressedCap)))
	if w.Code != http.StatusOK {
		t.Errorf("4 MiB body: status %d", w.Code)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "gzip", gzipBytes(t, padded(otlpTestDecompressedCap))))
	if w.Code != http.StatusOK {
		t.Errorf("16 MiB decompressed body: status %d", w.Code)
	}
}

type countingReader struct {
	r    io.Reader
	read int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read += n
	return n, err
}

// A token whose minute budget is spent is refused with 429 and
// Retry-After before its body is read.
func TestOTLPRateLimited429BeforeRead(t *testing.T) {
	limiter := handlers.NewRateLimiter(2)
	defer limiter.Close()
	limiter.Allow("tok")
	limiter.Allow("tok")

	mux := otlpTestMux(&mockValidator{valid: true}, &mockPublisher{}, handlers.UnmappedDialect{}, limiter)
	for _, ct := range []string{"application/json", "application/x-protobuf"} {
		body := &countingReader{r: bytes.NewReader([]byte("{}"))}
		req := httptest.NewRequest(http.MethodPost, "/v1/logs", body)
		req.Header.Set("Authorization", "Bearer tok")
		req.Header.Set("Content-Type", ct)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("%s: status = %d", ct, w.Code)
		}
		retry, err := strconv.Atoi(w.Header().Get("Retry-After"))
		if err != nil || retry < 1 {
			t.Errorf("%s: Retry-After = %q", ct, w.Header().Get("Retry-After"))
		}
		if code, _ := decodeStatus(t, ct, w.Body.Bytes()); code != 8 {
			t.Errorf("%s: Status.code = %d, want RESOURCE_EXHAUSTED", ct, code)
		}
		if body.read != 0 {
			t.Errorf("%s: read %d bytes of a rate-limited request", ct, body.read)
		}
	}
}

// Requests whose records are all rejected cost nothing: a budget of one
// admits any number of them.
func TestOTLPRejectedRecordsCostNothing(t *testing.T) {
	limiter := handlers.NewRateLimiter(1)
	defer limiter.Close()
	mux := otlpTestMux(&mockValidator{valid: true}, &mockPublisher{}, handlers.UnmappedDialect{}, limiter)
	raw, err := os.ReadFile(filepath.Join(otlpFixtureRoot, "bash-protobuf-gzip", "006-logs.pb"))
	if err != nil {
		t.Fatal(err)
	}
	for i := range 20 {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/x-protobuf", "", raw))
		if w.Code != http.StatusOK {
			t.Fatalf("request %d: status %d", i+1, w.Code)
		}
	}
}

func stubEvents(n int) []handlers.OTLPEvent {
	events := make([]handlers.OTLPEvent, n)
	for i := range events {
		events[i] = handlers.OTLPEvent{EventType: "post_call", Payload: []byte(fmt.Sprintf(`{"n":%d}`, i))}
	}
	return events
}

// The events a dialect maps are published in order to their event
// type's subject, the response counts the dialect's rejections, and the
// token is charged one unit per published event.
func TestOTLPPublishesMappedEventsAndCharges(t *testing.T) {
	limiter := handlers.NewRateLimiter(3)
	defer limiter.Close()
	pub := &mockPublisher{}
	mux := otlpTestMux(&mockValidator{valid: true}, pub, stubDialect{events: stubEvents(3), rejected: 2}, limiter)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", []byte("{}")))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", w.Code, w.Body.String())
	}
	if len(pub.published) != 3 {
		t.Fatalf("published %d events, want 3", len(pub.published))
	}
	for i, p := range pub.published {
		if want := fmt.Sprintf(`{"n":%d}`, i); string(p) != want {
			t.Errorf("event %d = %s, want %s", i, p, want)
		}
	}
	if ps := decodeOTLPResponse(t, "/v1/logs", "application/json", w.Body.Bytes()); ps.rejected != 2 {
		t.Errorf("rejected = %d, want 2", ps.rejected)
	}

	// Three events spent the budget of three.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", []byte("{}")))
	if w.Code != http.StatusTooManyRequests {
		t.Errorf("after spending the budget: status %d, want 429", w.Code)
	}
}

// A request that maps more events than the budget is admitted and
// charged the whole budget, not refused for ever.
func TestOTLPChargeCappedAtBudget(t *testing.T) {
	limiter := handlers.NewRateLimiter(2)
	defer limiter.Close()
	pub := &mockPublisher{}
	mux := otlpTestMux(&mockValidator{valid: true}, pub, stubDialect{events: stubEvents(5)}, limiter)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/traces", "application/x-protobuf", "", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if len(pub.published) != 5 {
		t.Errorf("published %d events, want 5", len(pub.published))
	}
	_, retry := limiter.AllowN("tok", 0)
	if retry > 61 {
		t.Errorf("Retry-After = %d: the charge was not capped at the budget", retry)
	}
}

// A failed publish is 503, which OTLP exporters retry; a publish the
// publisher gave up on (no stream sequence) is a failure too.
func TestOTLPPublishFailure503(t *testing.T) {
	cases := map[string]handlers.EventPublisher{
		"publish error":       &failingPublisher{},
		"publish given up on": &mockPublisher{unsequenced: true},
	}
	for name, pub := range cases {
		t.Run(name, func(t *testing.T) {
			mux := otlpTestMux(&mockValidator{valid: true}, pub, stubDialect{events: stubEvents(2)}, nil)
			for _, ct := range []string{"application/json", "application/x-protobuf"} {
				body := []byte("{}")
				if ct == "application/x-protobuf" {
					body = nil
				}
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, otlpRequest("/v1/metrics", ct, "", body))
				if w.Code != http.StatusServiceUnavailable {
					t.Fatalf("%s: status = %d, want 503", ct, w.Code)
				}
				if code, _ := decodeStatus(t, ct, w.Body.Bytes()); code != 14 {
					t.Errorf("%s: Status.code = %d, want UNAVAILABLE", ct, code)
				}
			}
		})
	}
}

// A failed publish stops at the first failure and charges only what
// was published.
func TestOTLPPublishFailureChargesPublished(t *testing.T) {
	limiter := handlers.NewRateLimiter(10)
	defer limiter.Close()
	pub := &failingPublisher{}
	mux := otlpTestMux(&mockValidator{valid: true}, pub, stubDialect{events: stubEvents(4)}, limiter)
	for range 20 {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", []byte("{}")))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", w.Code)
		}
	}
	if pub.calls != 20 {
		t.Errorf("publish attempts = %d, want one per request", pub.calls)
	}
}

// The real server routes the three OTLP paths and reads header names
// in any case: an exporter that writes them in lower case, as HTTP/2
// and many clients do, is answered 200.
func TestOTLPServerRoutesLowerCaseHeaders(t *testing.T) {
	srv := server.New(":0", &mockValidator{valid: true}, &mockPublisher{}, &mockDirStore{}, nil,
		handlers.UnmappedDialect{}, handlers.DefaultRateLimitPerMinute)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	raw, err := os.ReadFile(filepath.Join(otlpFixtureRoot, "bash-protobuf-gzip", "002-logs.pb"))
	if err != nil {
		t.Fatal(err)
	}
	body := gzipBytes(t, raw)
	want := countOTLPRecords(t, "/v1/logs", "application/x-protobuf", raw)

	conn, err := net.DialTimeout("tcp", ts.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	head := "POST /v1/logs HTTP/1.1\r\n" +
		"host: localhost\r\n" +
		"authorization: Bearer tok\r\n" +
		"content-type: application/x-protobuf\r\n" +
		"content-encoding: gzip\r\n" +
		"content-length: " + strconv.Itoa(len(body)) + "\r\n" +
		"connection: close\r\n\r\n"
	if _, err := conn.Write(append([]byte(head), body...)); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body %q", resp.StatusCode, respBody)
	}
	if ps := decodeOTLPResponse(t, "/v1/logs", "application/x-protobuf", respBody); ps.rejected != want {
		t.Errorf("rejected = %d, want %d", ps.rejected, want)
	}

	// The other two routes are registered too, and only for POST.
	for _, path := range []string{"/v1/traces", "/v1/metrics"} {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer tok")
		req.Header.Set("Content-Type", "application/json")
		r, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Errorf("POST %s: status %d", path, r.StatusCode)
		}
		g, err := ts.Client().Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = g.Body.Close()
		if g.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("GET %s: status %d, want 405", path, g.StatusCode)
		}
	}
}
