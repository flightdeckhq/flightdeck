package handlers_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
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

// otlpFixtureRecords pins each recorded request's record count, in the
// unit its signal's partial_success counts (log records, spans, data
// points). The counts were taken from the fixtures by the integration
// suite's own protobuf wire walker and JSON walk, independently of the
// receiver, and are literals here so a counting mistake shared by the
// receiver and a test helper cannot pass.
var otlpFixtureRecords = map[string]int64{
	"api-error-json/001-traces.json":     2,
	"api-error-json/002-logs.json":       2,
	"api-error-json/003-metrics.json":    2,
	"bash-json-prompts/001-metrics.json": 1,
	"bash-json-prompts/002-logs.json":    1,
	"bash-json-prompts/003-logs.json":    2,
	"bash-json-prompts/004-metrics.json": 5,
	"bash-json-prompts/005-traces.json":  3,
	"bash-json-prompts/006-metrics.json": 5,
	"bash-json-prompts/007-traces.json":  4,
	"bash-json-prompts/008-logs.json":    3,
	"bash-json-prompts/009-traces.json":  2,
	"bash-json-prompts/010-metrics.json": 6,
	"bash-json-prompts/011-logs.json":    2,
	"bash-protobuf-gzip/001-metrics.pb":  1,
	"bash-protobuf-gzip/002-logs.pb":     1,
	"bash-protobuf-gzip/003-logs.pb":     1,
	"bash-protobuf-gzip/004-metrics.pb":  5,
	"bash-protobuf-gzip/005-traces.pb":   6,
	"bash-protobuf-gzip/006-logs.pb":     3,
	"bash-protobuf-gzip/007-traces.pb":   2,
	"bash-protobuf-gzip/008-metrics.pb":  6,
	"bash-protobuf-gzip/009-logs.pb":     2,
	"mcp-json/001-metrics.json":          1,
	"mcp-json/002-logs.json":             1,
	"mcp-json/003-logs.json":             1,
	"mcp-json/004-metrics.json":          5,
	"mcp-json/005-traces.json":           4,
	"mcp-json/006-logs.json":             3,
	"mcp-json/007-metrics.json":          5,
	"mcp-json/008-traces.json":           4,
	"mcp-json/009-logs.json":             3,
	"mcp-json/010-traces.json":           2,
	"mcp-json/011-logs.json":             3,
	"mcp-json/012-metrics.json":          6,
	"subagent-json/001-metrics.json":     1,
	"subagent-json/002-logs.json":        1,
	"subagent-json/003-logs.json":        3,
	"subagent-json/004-metrics.json":     5,
	"subagent-json/005-traces.json":      4,
	"subagent-json/006-metrics.json":     5,
	"subagent-json/007-traces.json":      4,
	"subagent-json/008-logs.json":        3,
	"subagent-json/009-metrics.json":     11,
	"subagent-json/010-traces.json":      3,
	"subagent-json/011-logs.json":        6,
	"subagent-json/012-traces.json":      2,
	"subagent-json/013-metrics.json":     6,
	"subagent-json/014-logs.json":        2,
}

// otlpRecords is the pinned record count of a fixture request.
func otlpRecords(t *testing.T, scenario, file string) int64 {
	t.Helper()
	n, ok := otlpFixtureRecords[scenario+"/"+file]
	if !ok {
		t.Fatalf("no pinned record count for %s/%s; add it to otlpFixtureRecords", scenario, file)
	}
	return n
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
				want := otlpRecords(t, name, r.File)
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
	if replayed != len(otlpFixtureRecords) {
		t.Fatalf("replayed %d fixture requests, %d have pinned counts", replayed, len(otlpFixtureRecords))
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
	// A valid stream with bytes cut from its middle: the header and
	// size trailer are intact, the deflate data is not.
	whole := gzipBytes(t, validLogs)
	corruptGzip := append(append([]byte{}, whole[:len(whole)/2]...), whole[len(whole)-8:]...)
	// A stream whose trailer declares 2 bytes and inflates to more.
	lyingGzip := gzipBytes(t, []byte(`{"resourceLogs":[]}`))
	binary.LittleEndian.PutUint32(lyingGzip[len(lyingGzip)-4:], 2)
	// A small stream whose trailer declares more than 16 MiB.
	bigTrailerGzip := gzipBytes(t, []byte("{}"))
	binary.LittleEndian.PutUint32(bigTrailerGzip[len(bigTrailerGzip)-4:], otlpTestDecompressedCap+1)

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
		{"gzip with a corrupt middle", "/v1/logs", "application/x-protobuf", "gzip", "", corruptGzip, nil, http.StatusBadRequest, 3},
		{"gzip inflating past its trailer", "/v1/logs", "application/json", "gzip", "", lyingGzip, nil, http.StatusBadRequest, 3},
		{"gzip trailer over 16 MiB", "/v1/logs", "application/json", "gzip", "", bigTrailerGzip, nil, http.StatusRequestEntityTooLarge, 8},
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

// The events a dialect maps are charged and then published in order to
// their event type's subject, and the response counts the dialect's
// rejections.
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

	// Three events spent the budget of three: the next request is
	// refused before it is read.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", []byte("{}")))
	if w.Code != http.StatusTooManyRequests {
		t.Errorf("after spending the budget: status %d, want 429", w.Code)
	}
}

// A request whose events do not fit in what is left of the budget is
// refused with 429 and Retry-After, publishes nothing and is charged
// nothing.
func TestOTLPEventsNotFittingRefused429(t *testing.T) {
	limiter := handlers.NewRateLimiter(5)
	defer limiter.Close()
	limiter.AllowN("tok", 3)
	pub := &mockPublisher{}
	mux := otlpTestMux(&mockValidator{valid: true}, pub, stubDialect{events: stubEvents(3)}, limiter)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/x-protobuf", "", nil))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if retry, err := strconv.Atoi(w.Header().Get("Retry-After")); err != nil || retry < 1 || retry > 61 {
		t.Errorf("Retry-After = %q", w.Header().Get("Retry-After"))
	}
	if code, _ := decodeStatus(t, "application/x-protobuf", w.Body.Bytes()); code != 8 {
		t.Errorf("Status.code = %d, want RESOURCE_EXHAUSTED", code)
	}
	if len(pub.published) != 0 {
		t.Errorf("published %d events of a refused request", len(pub.published))
	}
	if allowed, _ := limiter.AllowN("tok", 2); !allowed {
		t.Error("the refused request was charged")
	}
}

// A request that maps more events than the whole minute budget can
// never fit: 413, nothing published, nothing charged.
func TestOTLPEventsOverBudgetRefused413(t *testing.T) {
	limiter := handlers.NewRateLimiter(4)
	defer limiter.Close()
	pub := &mockPublisher{}
	mux := otlpTestMux(&mockValidator{valid: true}, pub, stubDialect{events: stubEvents(5)}, limiter)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/traces", "application/json", "", []byte("{}")))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
	code, msg := decodeStatus(t, "application/json", w.Body.Bytes())
	if code != 8 || !strings.Contains(msg, "5 events") {
		t.Errorf("Status = %d %q", code, msg)
	}
	if len(pub.published) != 0 {
		t.Errorf("published %d events", len(pub.published))
	}
	if allowed, _ := limiter.AllowN("tok", 4); !allowed {
		t.Error("the refused request was charged")
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

// The charge is taken before publishing and is not refunded when the
// publish fails: a token cannot retry a failing export past its budget.
func TestOTLPPublishFailureStillCharged(t *testing.T) {
	limiter := handlers.NewRateLimiter(10)
	defer limiter.Close()
	pub := &failingPublisher{}
	mux := otlpTestMux(&mockValidator{valid: true}, pub, stubDialect{events: stubEvents(4)}, limiter)
	for i := range 2 {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", []byte("{}")))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("request %d: status = %d, want 503", i+1, w.Code)
		}
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, otlpRequest("/v1/logs", "application/json", "", []byte("{}")))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("third request: status = %d, want 429 (8 of 10 units charged)", w.Code)
	}
	if pub.calls != 2 {
		t.Errorf("publish attempts = %d, want one per admitted request", pub.calls)
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
	want := otlpRecords(t, "bash-protobuf-gzip", "002-logs.pb")

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
