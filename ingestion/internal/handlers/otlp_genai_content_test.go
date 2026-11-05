package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/slim/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

// withCapture is a resource's attributes with
// flightdeck.capture_prompts=true added, as an operator sets it with
// OTEL_RESOURCE_ATTRIBUTES.
func withCapture(attrs []*commonpb.KeyValue) []*commonpb.KeyValue {
	return append(attrs, &commonpb.KeyValue{Key: otlpAttrCapturePrompts, Value: strVal("true")})
}

// stagedRecords maps a recorded scenario through the router, every
// resource declaring capture when capture is set, and returns what it
// staged.
func stagedRecords(t *testing.T, dir string, capture bool) []otlpstage.Record {
	t.Helper()
	stager := &fakeStager{}
	router := newTestRouter(stager)
	for _, r := range recordedRequests(t, dir) {
		var m OTLPMapping
		switch r.path {
		case "/v1/traces":
			var req coltrace.ExportTraceServiceRequest
			decodeRecorded(t, r, &req)
			for _, rs := range req.GetResourceSpans() {
				if rs.Resource == nil {
					rs.Resource = resourceWith()
				}
				if capture {
					rs.Resource.Attributes = withCapture(rs.Resource.Attributes)
				}
			}
			m = router.MapTraces(routerCtx(), &req)
		case "/v1/logs":
			var req collogs.ExportLogsServiceRequest
			decodeRecorded(t, r, &req)
			for _, rl := range req.GetResourceLogs() {
				if rl.Resource == nil {
					rl.Resource = resourceWith()
				}
				if capture {
					rl.Resource.Attributes = withCapture(rl.Resource.Attributes)
				}
			}
			m = router.MapLogs(routerCtx(), &req)
		default:
			continue
		}
		if m.Stage != nil {
			if _, _, err := m.Stage(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
	}
	return stager.records()
}

// A record carries content only when its own resource declares
// capture: with it declared, the recordings that hold content stage it
// on their model, tool and agent records; without it, no record of any
// recording carries content, whatever the framework sent. The
// recordings whose framework recorded none (or Strands' [REDACTED])
// stage no messages even with capture declared.
func TestRouterStagesContentOnlyWithCapture(t *testing.T) {
	for _, dir := range genaiScenarioDirs(t) {
		name := filepath.Base(filepath.Dir(dir)) + "/" + filepath.Base(dir)
		for _, rec := range stagedRecords(t, dir, false) {
			if rec.Content != nil || rec.Capture {
				t.Fatalf("%s: a record without capture carries content %s", name, rec.Content)
			}
		}
		withContent, messages := 0, 0
		for _, rec := range stagedRecords(t, dir, true) {
			if !rec.Capture {
				t.Fatalf("%s: a record lost its resource's capture", name)
			}
			if rec.Content == nil {
				continue
			}
			withContent++
			if bytes.Contains(rec.Content, []byte(`"gen_ai.input.messages"`)) {
				messages++
			}
			if len(rec.Content) > maxOTLPEventBodyBytes {
				t.Errorf("%s: %d bytes of content staged", name, len(rec.Content))
			}
		}
		noContent := strings.Contains(dir, "no-content") || strings.Contains(dir, "redacted")
		switch {
		case noContent && messages != 0:
			t.Errorf("%s: %d records stage messages the framework did not record", name, messages)
		case !noContent && strings.Contains(dir, "tool-") && withContent == 0:
			t.Errorf("%s: no record staged content with capture declared", name)
		}
	}
}

// Content past the event size limit is cut when it is staged, every
// string to the same largest length that fits, so a staged record is
// never larger than the event it becomes; content within it is staged
// byte for byte.
func TestFitStagedContent(t *testing.T) {
	small := json.RawMessage(`{"gen_ai.tool.call.arguments":{"n":12345678901234567890}}`)
	if got := fitStagedContent(small); !bytes.Equal(got, small) {
		t.Errorf("small content changed: %s", got)
	}
	big, _ := json.Marshal(map[string]any{
		"gen_ai.input.messages":  strings.Repeat("a", maxOTLPEventBodyBytes),
		"gen_ai.output.messages": []any{strings.Repeat("b", maxOTLPEventBodyBytes/2), json.Number("12345678901234567890")},
	})
	got := fitStagedContent(big)
	if len(got) == 0 || len(got) > maxOTLPEventBodyBytes || !json.Valid(got) {
		t.Fatalf("cut content is %d bytes (valid %v)", len(got), json.Valid(got))
	}
	if !bytes.Contains(got, []byte("flightdeck: kept")) || !bytes.Contains(got, []byte("12345678901234567890")) {
		t.Errorf("cut content lacks the marker or the exact number")
	}
	if fitStagedContent(nil) != nil {
		t.Error("no content became some")
	}
}

// A trace whose records come from two resources of different frameworks
// in one request is one batch, with the framework and identity resource
// of the first record's resource, whichever framework that is.
func TestRouterFirstRecordWinsAcrossFrameworks(t *testing.T) {
	resource := func(scope, service string, op, agent string, span byte) *tracepb.ResourceSpans {
		return &tracepb.ResourceSpans{
			Resource: resourceWith("service.name", service),
			ScopeSpans: []*tracepb.ScopeSpans{{
				Scope: &commonpb.InstrumentationScope{Name: scope, Version: "1.2.3"},
				Spans: []*tracepb.Span{genaiSpan(traceID(7), spanIDb(span), op, agent)},
			}},
		}
	}
	pyd := resource("pydantic-ai", "pyd-app", "invoke_agent", "a", 1)
	str := resource("strands.telemetry.tracer", "str-app", "chat", "", 2)
	for _, tc := range []struct {
		order   []*tracepb.ResourceSpans
		source  string
		service string
	}{
		{[]*tracepb.ResourceSpans{pyd, str}, genai.LabelPydanticAI, "pyd-app"},
		{[]*tracepb.ResourceSpans{str, pyd}, genai.LabelStrands, "str-app"},
	} {
		stager := &fakeStager{}
		m := newTestRouter(stager).MapTraces(routerCtx(), &coltrace.ExportTraceServiceRequest{ResourceSpans: tc.order})
		if _, _, err := m.Stage(context.Background()); err != nil {
			t.Fatal(err)
		}
		if len(stager.calls) != 1 || len(stager.calls[0]) != 1 {
			t.Fatalf("staged %d calls", len(stager.calls))
		}
		b := stager.calls[0][0]
		var res map[string]any
		_ = json.Unmarshal(b.Resource, &res)
		if b.Source != tc.source || res["service.name"] != tc.service || len(b.Records) != 2 {
			t.Errorf("batch source %s resource %s with %d records, want %s %s", b.Source, b.Resource, len(b.Records), tc.source, tc.service)
		}
	}
}

// flakyStager fails its first fails calls, then stages as fakeStager.
type flakyStager struct {
	failMu sync.Mutex
	fails  int
	fakeStager
}

func (s *flakyStager) Stage(ctx context.Context, batches []otlpstage.TraceBatch) (otlpstage.StageResult, error) {
	s.failMu.Lock()
	if s.fails > 0 {
		s.fails--
		s.failMu.Unlock()
		return otlpstage.StageResult{}, errors.New("db down")
	}
	s.failMu.Unlock()
	return s.fakeStager.Stage(ctx, batches)
}

// A request carrying Claude Code log records and Google ADK records
// whose staging write fails is answered 503 after its Claude Code
// events were published; the exporter's retry publishes the same Claude
// Code events again (the worker drops the copies by id) and stages the
// GenAI records once.
func TestOTLPHandlerMixedRequestRetriesAfterStagingFailure(t *testing.T) {
	var req collogs.ExportLogsServiceRequest
	body := fixtureBody(t, "bash-json-prompts", "002-logs.json")
	if status, msg := decodeOTLPRequest(otlpEncodingJSON, body, &req); status != 0 {
		t.Fatalf("decode: %d %s", status, msg)
	}
	req.ResourceLogs = append(req.ResourceLogs, &logspb.ResourceLogs{
		Resource: resourceWith("flightdeck.capture_prompts", "true"),
		ScopeLogs: []*logspb.ScopeLogs{{
			Scope: &commonpb.InstrumentationScope{Name: "gcp.vertex.agent", Version: "2.13.0"},
			LogRecords: []*logspb.LogRecord{{
				EventName: genai.ADKDetailsEvent, TraceId: traceID(3), SpanId: spanIDb(4),
				Attributes: []*commonpb.KeyValue{{Key: "gen_ai.input.messages", Value: strVal(`[{"role":"user","parts":[{"type":"text","content":"hi"}]}]`)}},
			}},
		}},
	})
	raw, err := proto.Marshal(&req)
	if err != nil {
		t.Fatal(err)
	}
	d, _ := newTestDialect(newFakeStore())
	stager := &flakyStager{fails: 1}
	pub := &recordingPublisher{}
	h := OTLPLogsHandler(tokenValidator{}, pub, &fakeAttacher{}, NewOTLPRouter(d, stager), nil)

	w := postOTLP(h, otlpMediaProtobuf, false, append([]byte(nil), raw...))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("first attempt: %d Retry-After=%q %s", w.Code, w.Header().Get("Retry-After"), w.Body)
	}
	first := publishedIDs(t, pub)
	if len(first) == 0 {
		t.Fatal("the Claude Code events were not published before the staging write")
	}

	w = postOTLP(h, otlpMediaProtobuf, false, append([]byte(nil), raw...))
	if w.Code != http.StatusOK {
		t.Fatalf("retry: %d %s", w.Code, w.Body)
	}
	all := publishedIDs(t, pub)
	retry := all[len(first):]
	if strings.Join(retry, ",") != strings.Join(first, ",") {
		t.Errorf("the retry published %v, want the same events %v", retry, first)
	}
	recs := stager.records()
	if len(stager.calls) != 1 || len(recs) != 1 || recs[0].Kind != otlpstage.KindLog || recs[0].Content == nil {
		t.Errorf("staged %d times, records %+v; want once, the ADK record with its content", len(stager.calls), recs)
	}
}

func publishedIDs(t *testing.T, pub *recordingPublisher) []string {
	t.Helper()
	pub.mu.Lock()
	defer pub.mu.Unlock()
	var ids []string
	for _, b := range pub.bodies {
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(b, &p); err != nil || p.ID == "" {
			t.Fatalf("published event without an id: %s", b)
		}
		ids = append(ids, p.ID)
	}
	return ids
}
