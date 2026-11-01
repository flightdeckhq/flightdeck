package handlers

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// allocated is the bytes f allocates, garbage included: an upper bound
// on the live heap it can hold at any point.
func allocated(f func()) uint64 {
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	f()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

func pbField(num protowire.Number, inner []byte) []byte {
	b := protowire.AppendTag(nil, num, protowire.BytesType)
	return protowire.AppendBytes(b, inner)
}

func jsonList(item string, n int) string {
	return strings.TrimSuffix(strings.Repeat(item+",", n), ",")
}

type decodeShape struct {
	name string
	enc  otlpEncoding
	body func(n int) []byte
	req  func() proto.Message
}

// Pathological shapes: as many elements as the bytes allow, each the
// costliest to decode of its kind.
var decodeShapes = []decodeShape{
	{"pb empty resources", otlpEncodingProtobuf,
		func(n int) []byte { return bytes.Repeat(pbField(1, nil), n) },
		func() proto.Message { return &collogs.ExportLogsServiceRequest{} }},
	{"pb empty spans", otlpEncodingProtobuf,
		func(n int) []byte { return pbField(1, pbField(2, bytes.Repeat(pbField(2, nil), n))) },
		func() proto.Message { return &coltrace.ExportTraceServiceRequest{} }},
	{"pb empty log records", otlpEncodingProtobuf,
		func(n int) []byte { return pbField(1, pbField(2, bytes.Repeat(pbField(2, nil), n))) },
		func() proto.Message { return &collogs.ExportLogsServiceRequest{} }},
	{"pb packed varint buckets", otlpEncodingProtobuf,
		func(n int) []byte {
			return pbField(1, pbField(2, pbField(2, pbField(10, pbField(1, pbField(8, pbField(2, bytes.Repeat([]byte{1}, n))))))))
		},
		func() proto.Message { return &colmetrics.ExportMetricsServiceRequest{} }},
	{"json empty spans", otlpEncodingJSON,
		func(n int) []byte {
			return []byte(`{"resourceSpans":[{"scopeSpans":[{"spans":[` + jsonList("{}", n) + `]}]}]}`)
		},
		func() proto.Message { return &coltrace.ExportTraceServiceRequest{} }},
	{"json empty resources", otlpEncodingJSON,
		func(n int) []byte { return []byte(`{"resourceLogs":[` + jsonList("{}", n) + `]}`) },
		func() proto.Message { return &collogs.ExportLogsServiceRequest{} }},
	{"json string attributes", otlpEncodingJSON,
		func(n int) []byte {
			return []byte(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[` +
				jsonList(`{"key":"k","value":{"stringValue":"v"}}`, n) + `]}]}]}]}`)
		},
		func() proto.Message { return &collogs.ExportLogsServiceRequest{} }},
	{"json bucket numbers", otlpEncodingJSON,
		func(n int) []byte {
			return []byte(`{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"exponentialHistogram":{"dataPoints":[{"positive":{"bucketCounts":[` +
				jsonList("1", n) + `]}}]}}]}]}]}`)
		},
		func() proto.Message { return &colmetrics.ExportMetricsServiceRequest{} }},
	{"json unknown members", otlpEncodingJSON,
		func(n int) []byte { return []byte(`{"resourceLogs":[{` + jsonList(`"x":1`, n) + `}]}`) },
		func() proto.Message { return &collogs.ExportLogsServiceRequest{} }},
}

func estimateFor(t *testing.T, enc otlpEncoding, body []byte, req proto.Message) int64 {
	t.Helper()
	b := append([]byte(nil), body...)
	var (
		est int64
		err error
	)
	if enc == otlpEncodingProtobuf {
		est, err = estimateOTLPProtobuf(b, req.ProtoReflect().Descriptor())
	} else {
		_, est, err = rewriteOTLPJSONIDs(b)
	}
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	return est
}

// largestUnderCap is the largest element count of shape whose estimate
// stays under the decode cap, found by doubling then bisecting.
func largestUnderCap(t *testing.T, shape decodeShape) int {
	t.Helper()
	fits := func(n int) bool {
		b := shape.body(n)
		if shape.enc == otlpEncodingProtobuf {
			_, err := estimateOTLPProtobuf(b, shape.req().ProtoReflect().Descriptor())
			return err == nil
		}
		_, _, err := rewriteOTLPJSONIDs(b)
		return err == nil
	}
	lo, hi := 1, 2
	for fits(hi) {
		lo, hi = hi, hi*2
	}
	for hi-lo > 1 {
		mid := (lo + hi) / 2
		if fits(mid) {
			lo = mid
		} else {
			hi = mid
		}
	}
	return lo
}

// The estimate bounds what decoding allocates, for every pathological
// shape at the largest size the cap admits: the decode cap is a real
// memory bound.
func TestOTLPDecodeEstimateBoundsAllocation(t *testing.T) {
	if raceEnabled {
		t.Skip("the race detector changes what allocations cost")
	}
	for _, shape := range decodeShapes {
		t.Run(shape.name, func(t *testing.T) {
			n := largestUnderCap(t, shape)
			body := shape.body(n)
			est := estimateFor(t, shape.enc, body, shape.req())
			var status int
			got := allocated(func() { status, _ = decodeOTLPRequest(shape.enc, body, shape.req()) })
			if status != 0 {
				t.Fatalf("decode refused at %d elements: %d", n, status)
			}
			t.Logf("%d elements, %d-byte body: allocated %d, estimate %d", n, len(body), got, est)
			if int64(got) > est {
				t.Errorf("%d elements: decode allocated %d bytes, estimate %d", n, got, est)
			}
			if est > maxOTLPDecodeHeapBytes {
				t.Errorf("admitted estimate %d over the cap", est)
			}
		})
	}
}

// One element past the cap is refused with 413 before decoding: the
// refusal allocates next to nothing however wide the body.
func TestOTLPDecodePastCapRefusedCheaply(t *testing.T) {
	for _, shape := range decodeShapes {
		t.Run(shape.name, func(t *testing.T) {
			// As many elements as fit in the decompressed cap.
			n := maxOTLPDecompressedBytes / 4
			body := shape.body(n)
			if len(body) > maxOTLPDecompressedBytes {
				body = shape.body(n / 2)
			}
			var status int
			got := allocated(func() { status, _ = decodeOTLPRequest(shape.enc, body, shape.req()) })
			if status != http.StatusRequestEntityTooLarge {
				t.Fatalf("status = %d, want 413", status)
			}
			if got > 1<<20 {
				t.Errorf("refusing allocated %d bytes", got)
			}
		})
	}
}

type otlpFixtureManifest struct {
	Requests []struct {
		File        string `json:"file"`
		ContentType string `json:"content_type"`
		Path        string `json:"path"`
	} `json:"requests"`
}

// Every recorded request estimates under a tenth of the cap and the
// estimate bounds its decode: the cap is far from real traffic.
func TestOTLPDecodeEstimateOnFixtures(t *testing.T) {
	root := filepath.Join("..", "..", "..", "tests", "fixtures", "otlp", "claude-code-2.1.316")
	manifests, err := filepath.Glob(filepath.Join(root, "*", "manifest.json"))
	if err != nil || len(manifests) == 0 {
		t.Fatalf("no fixtures under %s: %v", root, err)
	}
	newReq := map[string]func() proto.Message{
		"/v1/logs":    func() proto.Message { return &collogs.ExportLogsServiceRequest{} },
		"/v1/traces":  func() proto.Message { return &coltrace.ExportTraceServiceRequest{} },
		"/v1/metrics": func() proto.Message { return &colmetrics.ExportMetricsServiceRequest{} },
	}
	for _, mp := range manifests {
		raw, err := os.ReadFile(mp)
		if err != nil {
			t.Fatal(err)
		}
		var m otlpFixtureManifest
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		for _, r := range m.Requests {
			body, err := os.ReadFile(filepath.Join(filepath.Dir(mp), r.File))
			if err != nil {
				t.Fatal(err)
			}
			enc := otlpEncodingJSON
			if r.ContentType == otlpMediaProtobuf {
				enc = otlpEncodingProtobuf
			}
			est := estimateFor(t, enc, body, newReq[r.Path]())
			if est > maxOTLPDecodeHeapBytes/10 {
				t.Errorf("%s: estimate %d", r.File, est)
			}
			if raceEnabled {
				continue
			}
			got := allocated(func() { decodeOTLPRequest(enc, body, newReq[r.Path]()) })
			if int64(got) > est {
				t.Errorf("%s: decode allocated %d bytes, estimate %d", r.File, got, est)
			}
		}
	}
}

// The slot count follows from the budget and the worst request, and
// leaves at least one slot.
func TestOTLPDecodeSlotsFromBudget(t *testing.T) {
	if otlpDecodeSlots < 1 {
		t.Fatalf("otlpDecodeSlots = %d", otlpDecodeSlots)
	}
	if otlpDecodeSlots*otlpDecodeWorstCaseBytes > otlpDecodeMemoryBudget {
		t.Errorf("%d slots of %d bytes exceed the %d budget", otlpDecodeSlots, otlpDecodeWorstCaseBytes, otlpDecodeMemoryBudget)
	}
	if cap(otlpDecodes.slots) != otlpDecodeSlots {
		t.Errorf("gate has %d slots", cap(otlpDecodes.slots))
	}
}

type allowAll struct{}

func (allowAll) Validate(context.Context, string) (auth.ValidationResult, error) {
	return auth.ValidationResult{Valid: true}, nil
}

type nopPublisher struct{}

func (nopPublisher) Publish(string, []byte) (uint64, error) { return 1, nil }

func gzipped(t *testing.T, b []byte) []byte {
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

func postOTLP(h http.Handler, contentType string, gz bool, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/logs", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	req.Header.Set("Content-Type", contentType)
	if gz {
		req.Header.Set("Content-Encoding", "gzip")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

// The reviewer's case end to end: 16 MiB of empty objects, gzipped to
// a few KiB, is refused with 413 having allocated little more than the
// inflated body.
func TestOTLPHandlerWideBodyBoundedMemory(t *testing.T) {
	h := OTLPLogsHandler(allowAll{}, nopPublisher{}, UnmappedDialect{}, nil)
	wide := []byte(`{"resourceLogs":[` + jsonList("{}", (maxOTLPDecompressedBytes-40)/3) + `]}`)
	body := gzipped(t, wide)

	var w *httptest.ResponseRecorder
	got := allocated(func() { w = postOTLP(h, otlpMediaJSON, true, body) })
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body %q", w.Code, w.Body.String())
	}
	if limit := uint64(len(wide)) + 4<<20; got > limit {
		t.Errorf("allocated %d bytes, want under %d", got, limit)
	}
}

// A request at the decode cap is admitted, and the whole handler stays
// within the memory one decode slot is sized for.
func TestOTLPHandlerAdmittedWithinSlot(t *testing.T) {
	if raceEnabled {
		t.Skip("the race detector changes what allocations cost")
	}
	h := OTLPLogsHandler(allowAll{}, nopPublisher{}, UnmappedDialect{}, nil)
	shape := decodeShapes[5] // json empty resources
	n := largestUnderCap(t, shape)
	body := gzipped(t, shape.body(n))

	var w *httptest.ResponseRecorder
	got := allocated(func() { w = postOTLP(h, otlpMediaJSON, true, body) })
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", w.Code, w.Body.String())
	}
	if got > otlpDecodeWorstCaseBytes {
		t.Errorf("allocated %d bytes, a slot is sized for %d", got, otlpDecodeWorstCaseBytes)
	}
}

// With every decode slot taken, a request waits, then is answered 503
// with Retry-After, having published nothing.
func TestOTLPDecodeGateFull503(t *testing.T) {
	saved := otlpDecodes
	otlpDecodes = newOTLPDecodeGate(1, 10*time.Millisecond)
	defer func() { otlpDecodes = saved }()
	if !otlpDecodes.acquire(context.Background()) {
		t.Fatal("could not take the only slot")
	}

	h := OTLPLogsHandler(allowAll{}, nopPublisher{}, UnmappedDialect{}, nil)
	for _, ct := range []string{otlpMediaJSON, otlpMediaProtobuf} {
		body := []byte("{}")
		if ct == otlpMediaProtobuf {
			body = nil
		}
		w := postOTLP(h, ct, false, body)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, want 503", ct, w.Code)
		}
		if got := w.Header().Get("Retry-After"); got != strconv.Itoa(otlpDecodeRetryAfterSeconds) {
			t.Errorf("%s: Retry-After = %q", ct, got)
		}
	}

	// Freed, the slot serves the next request.
	otlpDecodes.release()
	if w := postOTLP(h, otlpMediaJSON, false, []byte("{}")); w.Code != http.StatusOK {
		t.Errorf("after release: status = %d", w.Code)
	}
	if len(otlpDecodes.slots) != 0 {
		t.Errorf("%d slots left taken after the requests", len(otlpDecodes.slots))
	}
}

// A gate's wait ends with the request's context.
func TestOTLPDecodeGateHonoursContext(t *testing.T) {
	g := newOTLPDecodeGate(1, time.Hour)
	g.acquire(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if g.acquire(ctx) {
		t.Fatal("acquired a full gate")
	}
}

// Inflating sizes its buffer from the gzip trailer: one allocation of
// the declared size, never a doubling copy.
func TestInflateOTLPBodyExactBuffer(t *testing.T) {
	plain := bytes.Repeat([]byte("x"), 8<<20)
	body := gzipped(t, plain)
	var (
		out    []byte
		status int
	)
	got := allocated(func() { out, status, _ = inflateOTLPBody(body) })
	if status != 0 || !bytes.Equal(out, plain) {
		t.Fatalf("status = %d, inflated %d bytes", status, len(out))
	}
	if cap(out) != len(plain)+1 {
		t.Errorf("buffer capacity %d, want the declared size plus one", cap(out))
	}
	if limit := uint64(len(plain)) + 1<<20; got > limit {
		t.Errorf("inflating %d bytes allocated %d", len(plain), got)
	}
}

func TestReadCapped(t *testing.T) {
	cases := []struct {
		name          string
		in            int
		hint, limit   int
		wantOver      bool
		wantCapAtMost int
	}{
		{"exact hint", 100, 100, 1000, false, 101},
		{"short hint grows", 5000, 10, 10000, false, 10001},
		{"at the limit", 1000, 0, 1000, false, 1001},
		{"past the limit", 1001, 0, 1000, true, 0},
		{"past the limit with an exact hint", 1001, 1001, 1000, true, 0},
		{"empty", 0, 0, 1000, false, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, over, err := readCapped(bytes.NewReader(make([]byte, tc.in)), tc.hint, tc.limit)
			if err != nil {
				t.Fatal(err)
			}
			if over != tc.wantOver {
				t.Fatalf("over = %v", over)
			}
			if !over && (len(b) != tc.in || cap(b) > tc.wantCapAtMost) {
				t.Errorf("len %d cap %d, want len %d cap <= %d", len(b), cap(b), tc.in, tc.wantCapAtMost)
			}
		})
	}
}
