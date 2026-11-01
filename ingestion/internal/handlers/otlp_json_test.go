package handlers

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"

	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/slim/otlp/trace/v1"
)

const (
	testTraceIDHex = "3a1da53343c18318ef31fe713e273e2a"
	testSpanIDHex  = "4014c8fdbc13cb2c"
	testParentHex  = "c8827ac3966266c0"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// OTLP JSON span ids are hex; the decoded span carries their bytes,
// and an integer enum and a string int64 decode as protojson reads
// them.
func TestUnmarshalOTLPJSONSpanHexIDs(t *testing.T) {
	body := `{"resourceSpans":[{"scopeSpans":[{"spans":[{
		"traceId":"` + testTraceIDHex + `",
		"spanId":"` + testSpanIDHex + `",
		"parentSpanId":"` + testParentHex + `",
		"name":"claude_code.llm_request",
		"kind":1,
		"startTimeUnixNano":"1793534488464000000",
		"links":[{"traceId":"` + testTraceIDHex + `","spanId":"` + testParentHex + `"}]
	}]}]}]}`
	req := &coltrace.ExportTraceServiceRequest{}
	if err := unmarshalOTLPJSON([]byte(body), req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	span := req.GetResourceSpans()[0].GetScopeSpans()[0].GetSpans()[0]
	if !bytes.Equal(span.GetTraceId(), mustHex(t, testTraceIDHex)) {
		t.Errorf("traceId = %x", span.GetTraceId())
	}
	if !bytes.Equal(span.GetSpanId(), mustHex(t, testSpanIDHex)) {
		t.Errorf("spanId = %x", span.GetSpanId())
	}
	if !bytes.Equal(span.GetParentSpanId(), mustHex(t, testParentHex)) {
		t.Errorf("parentSpanId = %x", span.GetParentSpanId())
	}
	if !bytes.Equal(span.GetLinks()[0].GetSpanId(), mustHex(t, testParentHex)) {
		t.Errorf("link spanId = %x", span.GetLinks()[0].GetSpanId())
	}
	if span.GetKind() != tracepb.Span_SPAN_KIND_INTERNAL {
		t.Errorf("kind = %v, want SPAN_KIND_INTERNAL", span.GetKind())
	}
	if span.GetStartTimeUnixNano() != 1793534488464000000 {
		t.Errorf("startTimeUnixNano = %d", span.GetStartTimeUnixNano())
	}
}

// Log record ids, upper-case hex and the proto field names protojson
// also accepts all decode; an unknown field is ignored.
func TestUnmarshalOTLPJSONLogRecordIDsAndNames(t *testing.T) {
	body := `{"resource_logs":[{"scope_logs":[{"log_records":[{
		"trace_id":"` + strings.ToUpper(testTraceIDHex) + `",
		"spanId":"` + testSpanIDHex + `",
		"severityNumber":9,
		"timeUnixNano":1793534488464000000,
		"fieldFromANewerProto":{"x":1}
	}]}]}]}`
	req := &collogs.ExportLogsServiceRequest{}
	if err := unmarshalOTLPJSON([]byte(body), req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	rec := req.GetResourceLogs()[0].GetScopeLogs()[0].GetLogRecords()[0]
	if !bytes.Equal(rec.GetTraceId(), mustHex(t, testTraceIDHex)) {
		t.Errorf("trace_id = %x", rec.GetTraceId())
	}
	if !bytes.Equal(rec.GetSpanId(), mustHex(t, testSpanIDHex)) {
		t.Errorf("spanId = %x", rec.GetSpanId())
	}
	if rec.GetSeverityNumber() != 9 {
		t.Errorf("severityNumber = %v", rec.GetSeverityNumber())
	}
	if rec.GetTimeUnixNano() != 1793534488464000000 {
		t.Errorf("timeUnixNano = %d: a JSON number lost precision", rec.GetTimeUnixNano())
	}
}

// Exemplar ids in metrics are hex too, and an attribute whose key is
// "traceId" is left alone: it is a key/value object, not an id field.
func TestUnmarshalOTLPJSONExemplarIDsAndAttributeKeys(t *testing.T) {
	body := `{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"m","sum":{
		"aggregationTemporality":2,
		"dataPoints":[{"asInt":"3",
			"attributes":[{"key":"traceId","value":{"stringValue":"not-hex"}}],
			"exemplars":[{"traceId":"` + testTraceIDHex + `","spanId":"` + testSpanIDHex + `","asInt":"1"}]
		}]}}]}]}]}`
	req := &colmetrics.ExportMetricsServiceRequest{}
	if err := unmarshalOTLPJSON([]byte(body), req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	dp := req.GetResourceMetrics()[0].GetScopeMetrics()[0].GetMetrics()[0].GetSum().GetDataPoints()[0]
	if got := dp.GetAttributes()[0].GetValue().GetStringValue(); got != "not-hex" {
		t.Errorf("attribute value = %q, want it untouched", got)
	}
	if !bytes.Equal(dp.GetExemplars()[0].GetTraceId(), mustHex(t, testTraceIDHex)) {
		t.Errorf("exemplar traceId = %x", dp.GetExemplars()[0].GetTraceId())
	}
}

// An empty id is an absent id, as OTLP JSON exporters send it.
func TestUnmarshalOTLPJSONEmptyID(t *testing.T) {
	body := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"traceId":"","spanId":""}]}]}]}`
	req := &collogs.ExportLogsServiceRequest{}
	if err := unmarshalOTLPJSON([]byte(body), req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if id := req.GetResourceLogs()[0].GetScopeLogs()[0].GetLogRecords()[0].GetTraceId(); len(id) != 0 {
		t.Errorf("traceId = %x, want empty", id)
	}
}

// Bodies that are not OTLP JSON are errors.
func TestUnmarshalOTLPJSONRejects(t *testing.T) {
	cases := map[string]string{
		"not JSON":        `{"resourceLogs":`,
		"trailing data":   `{} {}`,
		"id not hex":      `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"traceId":"zz"}]}]}]}`,
		"id odd length":   `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"spanId":"abc"}]}]}]}`,
		"wrong type":      `{"resourceLogs":{"not":"a list"}}`,
		"top-level array": `[]`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if err := unmarshalOTLPJSON([]byte(body), &collogs.ExportLogsServiceRequest{}); err == nil {
				t.Errorf("accepted %s", body)
			}
		})
	}
}
