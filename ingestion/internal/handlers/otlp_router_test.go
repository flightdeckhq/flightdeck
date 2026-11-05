package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/slim/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/slim/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// routerToken is the token the router tests stage under: the one
// tokenValidator accepts every request as.
var routerToken = auth.ValidationResult{Valid: true, ID: "token-id-1", Name: "ci-exporter"}

func routerCtx() context.Context { return withOTLPToken(context.Background(), routerToken) }

// fakeStager records what it was asked to stage; err fails the write and
// overCap refuses that many records.
type fakeStager struct {
	mu      sync.Mutex
	calls   [][]otlpstage.TraceBatch
	err     error
	overCap int
}

func (s *fakeStager) Stage(_ context.Context, batches []otlpstage.TraceBatch) (otlpstage.StageResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, batches)
	if s.err != nil {
		return otlpstage.StageResult{}, s.err
	}
	n := 0
	for _, b := range batches {
		n += len(b.Records)
	}
	return otlpstage.StageResult{Staged: n - s.overCap, OverCap: s.overCap}, nil
}

func (s *fakeStager) records() []otlpstage.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []otlpstage.Record
	for _, call := range s.calls {
		for _, b := range call {
			out = append(out, b.Records...)
		}
	}
	return out
}

func newTestRouter(stager GenAIStager) *OTLPRouter {
	d, _ := newTestDialect(newFakeStore())
	return NewOTLPRouter(d, stager)
}

// recordedRequest is one request of a recorded scenario.
type recordedRequest struct {
	file, path string
	body       []byte
	enc        otlpEncoding
}

func recordedRequests(t *testing.T, dir string) []recordedRequest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m otlpFixtureManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	var out []recordedRequest
	for _, r := range m.Requests {
		body, err := os.ReadFile(filepath.Join(dir, r.File))
		if err != nil {
			t.Fatal(err)
		}
		enc := otlpEncodingJSON
		if strings.HasSuffix(r.File, ".pb") {
			enc = otlpEncodingProtobuf
		}
		out = append(out, recordedRequest{file: r.File, path: r.Path, body: body, enc: enc})
	}
	return out
}

func decodeRecorded(t *testing.T, r recordedRequest, msg proto.Message) {
	t.Helper()
	body := append([]byte(nil), r.body...) // the JSON decoder rewrites in place
	if status, reason := decodeOTLPRequest(r.enc, body, msg); status != 0 {
		t.Fatalf("decode %s: %d %s", r.file, status, reason)
	}
}

// genaiScenarioDirs is every recorded agent-framework scenario.
func genaiScenarioDirs(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, fw := range genaiFixtureFrameworks {
		ents, err := os.ReadDir(filepath.Join(genaiFixtureRoot, fw))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range ents {
			out = append(out, filepath.Join(genaiFixtureRoot, fw, e.Name()))
		}
	}
	return out
}

// E21: Claude Code is mapped through the router exactly as by its own
// dialect: its log records to the same events, its spans and metrics
// counted as rejected with the same message, nothing staged.
func TestRouterLeavesClaudeCodeUnchanged(t *testing.T) {
	ents, err := os.ReadDir(ccFixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		t.Run(e.Name(), func(t *testing.T) {
			direct, _ := newTestDialect(newFakeStore())
			stager := &fakeStager{}
			routed, _ := newTestDialect(newFakeStore())
			router := NewOTLPRouter(routed, stager)
			for _, r := range recordedRequests(t, filepath.Join(ccFixtureRoot, e.Name())) {
				var want, got OTLPMapping
				switch r.path {
				case "/v1/logs":
					var a, b collogs.ExportLogsServiceRequest
					decodeRecorded(t, r, &a)
					decodeRecorded(t, r, &b)
					want, got = direct.MapLogs(context.Background(), &a), router.MapLogs(routerCtx(), &b)
				case "/v1/traces":
					var a, b coltrace.ExportTraceServiceRequest
					decodeRecorded(t, r, &a)
					decodeRecorded(t, r, &b)
					want, got = direct.MapTraces(context.Background(), &a), router.MapTraces(routerCtx(), &b)
				case "/v1/metrics":
					var a, b colmetrics.ExportMetricsServiceRequest
					decodeRecorded(t, r, &a)
					decodeRecorded(t, r, &b)
					want, got = direct.MapMetrics(context.Background(), &a), router.MapMetrics(routerCtx(), &b)
				}
				if got.Rejected != want.Rejected || got.Message != want.Message || len(got.Events) != len(want.Events) {
					t.Fatalf("%s: routed %d events, %d rejected %q; direct %d, %d %q",
						r.file, len(got.Events), got.Rejected, got.Message, len(want.Events), want.Rejected, want.Message)
				}
				for i := range want.Events {
					if string(got.Events[i].Payload) != string(want.Events[i].Payload) {
						t.Fatalf("%s: event %d differs", r.file, i)
					}
				}
				if got.Stage != nil || got.StagedUnits != 0 {
					t.Fatalf("%s: a Claude Code request stages records", r.file)
				}
				if want.Published != nil {
					want.Published()
				}
				if got.Published != nil {
					got.Published()
				}
			}
			if len(stager.calls) != 0 {
				t.Error("the stager was called for Claude Code")
			}
		})
	}
}

// E22: every GenAI metric data point is counted as rejected, because
// metrics repeat the usage the spans report.
func TestRouterRejectsGenAIMetrics(t *testing.T) {
	router := newTestRouter(&fakeStager{})
	seen := 0
	for _, dir := range genaiScenarioDirs(t) {
		for _, r := range recordedRequests(t, dir) {
			if r.path != "/v1/metrics" {
				continue
			}
			var req colmetrics.ExportMetricsServiceRequest
			decodeRecorded(t, r, &req)
			var points int64
			for _, rm := range req.GetResourceMetrics() {
				for _, sm := range rm.GetScopeMetrics() {
					for _, m := range sm.GetMetrics() {
						points += countDataPoints(m)
					}
				}
			}
			got := router.MapMetrics(routerCtx(), &req)
			want := fmt.Sprintf("%d data points not used: metrics repeat span usage (%d)", points, points)
			if points == 1 {
				want = "1 data point not used: metrics repeat span usage (1)"
			}
			if got.Rejected != points || got.Message != want || len(got.Events) != 0 || got.Stage != nil {
				t.Errorf("%s/%s: %d rejected %q, want %d %q", filepath.Base(dir), r.file, got.Rejected, got.Message, points, want)
			}
			seen++
		}
	}
	if seen == 0 {
		t.Fatal("no recorded metrics")
	}
}

// Every recorded GenAI span and ADK details log record is staged, none
// rejected, under the request's token, each trace's records in one
// batch; the charge is one unit per record and one more per agent span.
func TestRouterStagesRecordedGenAI(t *testing.T) {
	for _, dir := range genaiScenarioDirs(t) {
		t.Run(filepath.Base(filepath.Dir(dir))+"/"+filepath.Base(dir), func(t *testing.T) {
			stager := &fakeStager{}
			router := newTestRouter(stager)
			for _, r := range recordedRequests(t, dir) {
				var m OTLPMapping
				records, agents := 0, 0
				switch r.path {
				case "/v1/traces":
					var req coltrace.ExportTraceServiceRequest
					decodeRecorded(t, r, &req)
					for _, rs := range req.GetResourceSpans() {
						for _, ss := range rs.GetScopeSpans() {
							for _, sp := range ss.GetSpans() {
								records++
								if _, f, err := genai.SpanFact(ss.GetScope(), sp); err == nil && genai.IsAgentSpan(f) {
									agents++
								}
							}
						}
					}
					m = router.MapTraces(routerCtx(), &req)
				case "/v1/logs":
					var req collogs.ExportLogsServiceRequest
					decodeRecorded(t, r, &req)
					for _, rl := range req.GetResourceLogs() {
						for _, sl := range rl.GetScopeLogs() {
							records += len(sl.GetLogRecords())
						}
					}
					m = router.MapLogs(routerCtx(), &req)
				default:
					continue
				}
				if m.Rejected != 0 || len(m.Events) != 0 || m.Err != nil || m.Refused != nil {
					t.Fatalf("%s: %d rejected (%q), %d events", r.file, m.Rejected, m.Message, len(m.Events))
				}
				if m.StagedUnits != records+agents {
					t.Errorf("%s: StagedUnits %d, want %d records + %d agent spans", r.file, m.StagedUnits, records, agents)
				}
				before := len(stager.records())
				if n, msg, err := m.Stage(context.Background()); err != nil || n != 0 || msg != "" {
					t.Fatalf("%s: Stage = %d %q %v", r.file, n, msg, err)
				}
				if got := len(stager.records()) - before; got != records {
					t.Errorf("%s: staged %d records, want %d", r.file, got, records)
				}
			}
			for _, call := range stager.calls {
				seen := map[[16]byte]bool{}
				for _, b := range call {
					if seen[b.Key.TraceID] {
						t.Error("a trace's records are split across batches of one request")
					}
					seen[b.Key.TraceID] = true
					if b.Key.TokenKey != routerToken.ID || b.TokenName != routerToken.Name || b.Source == "" {
						t.Errorf("batch %+v", b.Key)
					}
					for _, rec := range b.Records {
						if rec.Content != nil || rec.Capture {
							t.Error("a record carries content or capture its resource did not declare")
						}
					}
				}
			}
		})
	}
}

func genaiSpan(trace []byte, span []byte, op, agent string) *tracepb.Span {
	attrs := []*commonpb.KeyValue{{Key: "gen_ai.operation.name", Value: strVal(op)}}
	if agent != "" {
		attrs = append(attrs, &commonpb.KeyValue{Key: "gen_ai.agent.name", Value: strVal(agent)})
	}
	return &tracepb.Span{TraceId: trace, SpanId: span, Name: op, StartTimeUnixNano: 1, EndTimeUnixNano: 2, Attributes: attrs}
}

func traceID(b byte) []byte { return append(make([]byte, 15), b) }
func spanIDb(b byte) []byte { return append(make([]byte, 7), b) }

func resourceWith(kv ...string) *resourcepb.Resource {
	r := &resourcepb.Resource{}
	for i := 0; i+1 < len(kv); i += 2 {
		r.Attributes = append(r.Attributes, &commonpb.KeyValue{Key: kv[i], Value: strVal(kv[i+1])})
	}
	return r
}

// A resource of no recognised scope is counted as rejected with its
// scope named, and nothing is staged; Google ADK's other log records,
// and other scopes' log records in a GenAI resource, are rejected too.
func TestRouterRejectsUnknownScopes(t *testing.T) {
	router := newTestRouter(&fakeStager{})
	traces := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource: resourceWith("service.name", "acme"),
		ScopeSpans: []*tracepb.ScopeSpans{{
			Scope: &commonpb.InstrumentationScope{Name: "acme.tracer"},
			Spans: []*tracepb.Span{genaiSpan(traceID(1), spanIDb(1), "chat", ""), genaiSpan(traceID(1), spanIDb(2), "execute_tool", "")},
		}},
	}}}
	m := router.MapTraces(routerCtx(), traces)
	if m.Rejected != 2 || m.Message != `2 spans not used: scope "acme.tracer" is not mapped (2)` || m.Stage != nil {
		t.Errorf("unknown scope: %d %q staged=%v", m.Rejected, m.Message, m.Stage != nil)
	}

	logs := &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		ScopeLogs: []*logspb.ScopeLogs{
			{Scope: &commonpb.InstrumentationScope{Name: "gcp.vertex.agent"}, LogRecords: []*logspb.LogRecord{
				{EventName: genai.ADKDetailsEvent, TraceId: traceID(2), SpanId: spanIDb(1)},
				{EventName: "gen_ai.user.message", TraceId: traceID(2), SpanId: spanIDb(1)},
			}},
			{Scope: &commonpb.InstrumentationScope{Name: "litellm"}, LogRecords: []*logspb.LogRecord{{TraceId: traceID(2), SpanId: spanIDb(3)}}},
		},
	}}}
	m = router.MapLogs(routerCtx(), logs)
	if m.Rejected != 2 || m.Stage == nil || m.StagedUnits != 1 ||
		!strings.Contains(m.Message, `Google ADK log record "gen_ai.user.message" is not mapped (1)`) ||
		!strings.Contains(m.Message, `scope "litellm" is not mapped (1)`) {
		t.Errorf("ADK logs: %d %q units=%d", m.Rejected, m.Message, m.StagedUnits)
	}
}

// A record that cannot be placed in a trace (a short id, or an all-zero
// one the staging store would refuse) is rejected on its own; the
// request's other records are still staged.
func TestRouterRejectsUnplaceableRecords(t *testing.T) {
	stager := &fakeStager{}
	router := newTestRouter(stager)
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		ScopeSpans: []*tracepb.ScopeSpans{{
			Scope: &commonpb.InstrumentationScope{Name: "pydantic-ai", Version: "2.64.0"},
			Spans: []*tracepb.Span{
				genaiSpan(traceID(1), spanIDb(1), "invoke_agent", "a"),
				genaiSpan([]byte{1, 2, 3}, spanIDb(2), "chat", ""),
				genaiSpan(make([]byte, 16), spanIDb(3), "chat", ""),
				genaiSpan(traceID(1), make([]byte, 8), "chat", ""),
			},
		}},
	}}}
	m := router.MapTraces(routerCtx(), req)
	if m.Rejected != 3 || !strings.Contains(m.Message, genai.ErrRecordIDs.Error()+" (3)") {
		t.Errorf("rejected %d %q", m.Rejected, m.Message)
	}
	if m.StagedUnits != 2 { // the agent span: its record, its start and end
		t.Errorf("StagedUnits %d, want 2", m.StagedUnits)
	}
	if _, _, err := m.Stage(context.Background()); err != nil || len(stager.records()) != 1 {
		t.Errorf("staged %d records, err %v", len(stager.records()), err)
	}
}

// A request carrying Claude Code and GenAI resources maps each by its
// dialect: Claude Code's spans rejected with its own message, the GenAI
// spans staged; the capture a GenAI resource declares rides on its
// records.
func TestRouterSplitsAMixedRequest(t *testing.T) {
	stager := &fakeStager{}
	router := newTestRouter(stager)
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{
			Resource: resourceWith("service.name", "claude-code"),
			ScopeSpans: []*tracepb.ScopeSpans{{
				Scope: &commonpb.InstrumentationScope{Name: "com.anthropic.claude_code.tracing"},
				Spans: []*tracepb.Span{genaiSpan(traceID(9), spanIDb(1), "execute_tool", "")},
			}},
		},
		{
			Resource: resourceWith("flightdeck.capture_prompts", "true"),
			ScopeSpans: []*tracepb.ScopeSpans{{
				Scope: &commonpb.InstrumentationScope{Name: "strands.telemetry.tracer"},
				Spans: []*tracepb.Span{genaiSpan(traceID(1), spanIDb(1), "invoke_agent", "a")},
			}},
		},
	}}
	m := router.MapTraces(routerCtx(), req)
	if m.Rejected != 1 || m.Message != `1 span not used: source "claude-code" is not mapped` {
		t.Errorf("mixed: %d %q", m.Rejected, m.Message)
	}
	if _, _, err := m.Stage(context.Background()); err != nil {
		t.Fatal(err)
	}
	recs := stager.records()
	if len(recs) != 1 || !recs[0].Capture || recs[0].Op != "invoke_agent" {
		t.Errorf("staged %+v", recs)
	}
}

// A request without a token in its context (a dialect called outside
// the receiver) stages nothing.
func TestRouterNeedsAToken(t *testing.T) {
	stager := &fakeStager{}
	router := newTestRouter(stager)
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		ScopeSpans: []*tracepb.ScopeSpans{{
			Scope: &commonpb.InstrumentationScope{Name: "pydantic-ai"},
			Spans: []*tracepb.Span{genaiSpan(traceID(1), spanIDb(1), "chat", "")},
		}},
	}}}
	if m := router.MapTraces(context.Background(), req); m.Stage != nil || m.Rejected != 1 {
		t.Errorf("tokenless request: staged=%v rejected=%d", m.Stage != nil, m.Rejected)
	}
}

// genaiTraceBody is a recorded GenAI trace export, as the exporter sent
// it.
func genaiTraceBody(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(genaiFixtureRoot, "pydantic-ai-2.64.0", "tool-json", "001-traces.json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func postTraces(h http.Handler, body []byte) *testResponse {
	w := postOTLP(h, otlpMediaJSON, false, append([]byte(nil), body...))
	return &testResponse{code: w.Code, body: w.Body.Bytes(), retryAfter: w.Header().Get("Retry-After")}
}

type testResponse struct {
	code       int
	body       []byte
	retryAfter string
}

func (r *testResponse) partial(t *testing.T) *coltrace.ExportTracePartialSuccess {
	t.Helper()
	resp := &coltrace.ExportTraceServiceResponse{}
	if err := protojson.Unmarshal(r.body, resp); err != nil {
		t.Fatalf("decode response: %v (%s)", err, r.body)
	}
	return resp.GetPartialSuccess()
}

// The receiver charges the records it stages, one unit each plus one
// more per agent span, before staging: a request whose units exceed the
// whole budget is 413 and one that does not fit what is left is 429,
// both having staged nothing; one that fits is staged and answered 200.
func TestOTLPHandlerChargesStagedUnits(t *testing.T) {
	var req coltrace.ExportTraceServiceRequest
	decodeRecorded(t, recordedRequest{file: "001-traces.json", body: genaiTraceBody(t), enc: otlpEncodingJSON}, &req)
	units := newTestRouter(&fakeStager{}).MapTraces(routerCtx(), &req).StagedUnits
	if units == 0 {
		t.Fatal("the recorded trace stages nothing")
	}

	stager := &fakeStager{}
	h := OTLPTracesHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, newTestRouter(stager), NewRateLimiter(units-1))
	if w := postTraces(h, genaiTraceBody(t)); w.code != http.StatusRequestEntityTooLarge || len(stager.calls) != 0 {
		t.Errorf("over the whole budget: %d, staged %d times", w.code, len(stager.calls))
	}

	limiter := NewRateLimiter(units)
	h = OTLPTracesHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, newTestRouter(stager), limiter)
	w := postTraces(h, genaiTraceBody(t))
	if w.code != http.StatusOK || len(stager.calls) != 1 || strings.Contains(string(w.body), "partialSuccess") {
		t.Fatalf("within the budget: %d %s, staged %d times", w.code, w.body, len(stager.calls))
	}
	if ok, _ := limiter.AllowN("tok", 1); ok {
		t.Error("the staged units were not charged")
	}
	if w := postTraces(h, genaiTraceBody(t)); w.code != http.StatusTooManyRequests || len(stager.calls) != 1 {
		t.Errorf("with the budget spent: %d, staged %d times", w.code, len(stager.calls))
	}
}

// A staging write that fails is a 503 with Retry-After, which the
// exporter retries; the staging write is idempotent.
func TestOTLPHandlerStagingFailureIs503(t *testing.T) {
	stager := &fakeStager{err: errors.New("db down")}
	h := OTLPTracesHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, newTestRouter(stager), nil)
	w := postTraces(h, genaiTraceBody(t))
	if w.code != http.StatusServiceUnavailable || w.retryAfter != "1" || !strings.Contains(string(w.body), "staging records failed") {
		t.Fatalf("%d Retry-After=%q %s", w.code, w.retryAfter, w.body)
	}
}

// Records the store refuses past a trace's cap are counted as rejected
// in the 200's partial_success, with the reason.
func TestOTLPHandlerCountsOverCapRecords(t *testing.T) {
	stager := &fakeStager{overCap: 2}
	h := OTLPTracesHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, newTestRouter(stager), nil)
	w := postTraces(h, genaiTraceBody(t))
	if w.code != http.StatusOK {
		t.Fatalf("%d %s", w.code, w.body)
	}
	ps := w.partial(t)
	if ps.GetRejectedSpans() != 2 || ps.GetErrorMessage() != "2 spans not used: trace exceeds 10000 spans (2)" {
		t.Errorf("partial_success %v", ps)
	}
}
