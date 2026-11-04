package handlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
)

// genaiFixtureRoot is the recorded OTLP requests, relative to this
// package.
const genaiFixtureRoot = "../../../tests/fixtures/otlp"

// genaiFixtureFrameworks are the agent-framework recordings.
var genaiFixtureFrameworks = []string{
	"pydantic-ai-2.64.0", "strands-agents-1.63.0", "openai-agents-0.24.0", "google-adk-2.13.0",
}

// genaiTrace is one recorded trace as the staging store would hold it.
type genaiTrace struct {
	row   otlpstage.Trace
	facts []otlpstage.StagedFact
	seen  map[otlpstage.FactKey]bool
}

// stageGenAIScenario reads a recorded scenario through the receiver's
// own decoder and the GenAI dialect's fact reader, grouped by trace in
// order of first record.
func stageGenAIScenario(t *testing.T, dir string) []*genaiTrace {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Requests []struct{ File, Path string } `json:"requests"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	byTrace := map[[16]byte]*genaiTrace{}
	var order []*genaiTrace
	add := func(trace [16]byte, src genai.Source, scope *commonpb.InstrumentationScope, res []*commonpb.KeyValue, f otlpstage.Fact) {
		gt := byTrace[trace]
		if gt == nil {
			gt = &genaiTrace{
				row: otlpstage.Trace{
					Key:             otlpstage.TraceKey{TokenKey: "tok-validate", TraceID: trace},
					Source:          src.Label,
					SourceVersion:   src.Version(scope.GetVersion(), res),
					Resource:        genai.IdentityResource(res),
					FirstReceivedAt: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC),
				},
				seen: map[otlpstage.FactKey]bool{},
			}
			byTrace[trace] = gt
			order = append(order, gt)
		}
		if !gt.seen[f.Key()] {
			gt.seen[f.Key()] = true
			gt.facts = append(gt.facts, otlpstage.StagedFact{Fact: f})
		}
	}
	for _, r := range m.Requests {
		body, err := os.ReadFile(filepath.Join(dir, r.File))
		if err != nil {
			t.Fatal(err)
		}
		enc := otlpEncodingJSON
		if strings.HasSuffix(r.File, ".pb") {
			enc = otlpEncodingProtobuf
		}
		switch r.Path {
		case "/v1/traces":
			var req coltrace.ExportTraceServiceRequest
			if status, msg := decodeOTLPRequest(enc, body, &req); status != 0 {
				t.Fatalf("decode %s: %d %s", r.File, status, msg)
			}
			for _, rs := range req.GetResourceSpans() {
				var scopes []*commonpb.InstrumentationScope
				for _, ss := range rs.GetScopeSpans() {
					scopes = append(scopes, ss.GetScope())
				}
				src, recognised, ok := genai.Recognize(scopes)
				if !ok {
					continue
				}
				for _, ss := range rs.GetScopeSpans() {
					for _, sp := range ss.GetSpans() {
						trace, f, err := genai.SpanFact(ss.GetScope(), sp)
						if err != nil {
							t.Fatal(err)
						}
						add(trace, src, recognised, rs.GetResource().GetAttributes(), f)
					}
				}
			}
		case "/v1/logs":
			var req collogs.ExportLogsServiceRequest
			if status, msg := decodeOTLPRequest(enc, body, &req); status != 0 {
				t.Fatalf("decode %s: %d %s", r.File, status, msg)
			}
			for _, rl := range req.GetResourceLogs() {
				for _, sl := range rl.GetScopeLogs() {
					src, ok := genai.SourceForScope(sl.GetScope().GetName())
					if !ok {
						continue
					}
					for _, lr := range sl.GetLogRecords() {
						if !genai.IsADKDetails(lr) {
							continue
						}
						trace, f, err := genai.LogFact(sl.GetScope(), lr)
						if err != nil {
							t.Fatal(err)
						}
						add(trace, src, sl.GetScope(), rl.GetResource().GetAttributes(), f)
					}
				}
			}
		}
	}
	return order
}

// Every event the GenAI mapping makes of every recorded agent-framework
// scenario, with capture on and off, passes the validation POST
// /v1/events applies, through the receiver's own encode-and-validate
// step (finishOTLPEvent). The mapping lives in internal/genai, which
// cannot import this package (the receiver will import it), so the check
// runs from here.
func TestGenAIFixtureEventsPassValidation(t *testing.T) {
	var total int
	for _, fw := range genaiFixtureFrameworks {
		ents, err := os.ReadDir(filepath.Join(genaiFixtureRoot, fw))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range ents {
			for _, gt := range stageGenAIScenario(t, filepath.Join(genaiFixtureRoot, fw, e.Name())) {
				for _, capture := range []bool{true, false} {
					row := gt.row
					row.Capture = capture
					// Validation runs as if the trace were assembled a
					// minute after its last span ended.
					var last int64
					for _, f := range gt.facts {
						last = max(last, f.EndNs)
					}
					now := time.Unix(0, last).Add(time.Minute)
					evs := genai.Resolve(genai.Input{
						Trace: row, Facts: gt.facts, Reason: otlpstage.ReasonComplete,
						ValidFrom: now.Add(-maxClockSkewPast),
					})
					if len(evs) == 0 {
						t.Errorf("%s/%s: no events", fw, e.Name())
					}
					for _, ev := range evs {
						if _, msg := finishOTLPEvent(ev.Payload, now); msg != "" {
							t.Errorf("%s/%s capture=%v: %s %s is invalid: %s", fw, e.Name(), capture, ev.EventType, ev.Payload["id"], msg)
						}
						total++
					}
				}
			}
		}
	}
	if total == 0 {
		t.Fatal("no events validated")
	}
}

// A re-attaching start and end, and an unattributed session, pass
// validation too: they appear in no recording assembled once.
func TestGenAILateAndUnattributedEventsPassValidation(t *testing.T) {
	dir := filepath.Join(genaiFixtureRoot, "openai-agents-0.24.0", "subagent-protobuf")
	gt := stageGenAIScenario(t, dir)[0]
	var last int64
	for _, f := range gt.facts {
		last = max(last, f.EndNs)
	}
	now := time.Unix(0, last).Add(time.Minute)
	// The first request alone: the root never came, so its calls are
	// unattributed.
	first := map[otlpstage.FactKey]bool{}
	raw, _ := os.ReadFile(filepath.Join(dir, "001-traces.pb"))
	var req coltrace.ExportTraceServiceRequest
	if status, _ := decodeOTLPRequest(otlpEncodingProtobuf, raw, &req); status != 0 {
		t.Fatal("decode 001")
	}
	for _, rs := range req.GetResourceSpans() {
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				_, f, _ := genai.SpanFact(ss.GetScope(), sp)
				first[f.Key()] = true
			}
		}
	}
	var early []otlpstage.StagedFact
	late := append([]otlpstage.StagedFact(nil), gt.facts...)
	for i, f := range gt.facts {
		if first[f.Key()] {
			early = append(early, f)
			late[i].Assembled = true
		}
	}
	row := gt.row
	row.AssemblyCount = 1
	for _, in := range []genai.Input{
		{Trace: gt.row, Facts: early, Reason: otlpstage.ReasonQuiet, ValidFrom: now.Add(-maxClockSkewPast)},
		{Trace: row, Facts: late, Reason: otlpstage.ReasonComplete, ValidFrom: now.Add(-maxClockSkewPast)},
	} {
		evs := genai.Resolve(in)
		if len(evs) == 0 {
			t.Fatal("no events")
		}
		for _, ev := range evs {
			if _, msg := finishOTLPEvent(ev.Payload, now); msg != "" {
				t.Errorf("%s is invalid: %s", ev.EventType, msg)
			}
		}
	}
}
