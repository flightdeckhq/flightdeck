package handlers_test

import (
	"context"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	metricspb "go.opentelemetry.io/proto/slim/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/slim/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/slim/otlp/trace/v1"
)

func resourceNamed(name string) *resourcepb.Resource {
	if name == "" {
		return &resourcepb.Resource{}
	}
	return &resourcepb.Resource{Attributes: []*commonpb.KeyValue{{
		Key:   "service.name",
		Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: name}},
	}}}
}

// Data points are counted for every metric type.
func TestUnmappedDialectCountsEveryMetricType(t *testing.T) {
	metrics := []*metricspb.Metric{
		{Name: "g", Data: &metricspb.Metric_Gauge{Gauge: &metricspb.Gauge{DataPoints: make([]*metricspb.NumberDataPoint, 1)}}},
		{Name: "s", Data: &metricspb.Metric_Sum{Sum: &metricspb.Sum{DataPoints: make([]*metricspb.NumberDataPoint, 2)}}},
		{Name: "h", Data: &metricspb.Metric_Histogram{Histogram: &metricspb.Histogram{DataPoints: make([]*metricspb.HistogramDataPoint, 3)}}},
		{Name: "e", Data: &metricspb.Metric_ExponentialHistogram{ExponentialHistogram: &metricspb.ExponentialHistogram{DataPoints: make([]*metricspb.ExponentialHistogramDataPoint, 4)}}},
		{Name: "q", Data: &metricspb.Metric_Summary{Summary: &metricspb.Summary{DataPoints: make([]*metricspb.SummaryDataPoint, 5)}}},
		{Name: "none"},
	}
	req := &colmetrics.ExportMetricsServiceRequest{ResourceMetrics: []*metricspb.ResourceMetrics{{
		Resource:     resourceNamed("claude-code"),
		ScopeMetrics: []*metricspb.ScopeMetrics{{Metrics: metrics}},
	}}}
	m := handlers.UnmappedDialect{}.MapMetrics(context.Background(), req)
	if m.Rejected != 15 {
		t.Errorf("rejected = %d, want 15", m.Rejected)
	}
	if want := `15 data points not used: source "claude-code" is not mapped`; m.Message != want {
		t.Errorf("message = %q, want %q", m.Message, want)
	}
	if len(m.Events) != 0 {
		t.Errorf("mapped %d events", len(m.Events))
	}
}

// The message names every source the records came from, in order, and
// a resource without service.name as unknown_service; a resource with
// no records is not named.
func TestUnmappedDialectNamesSources(t *testing.T) {
	req := &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{
		{Resource: resourceNamed("zeta"), ScopeLogs: []*logspb.ScopeLogs{{LogRecords: make([]*logspb.LogRecord, 1)}}},
		{Resource: resourceNamed(""), ScopeLogs: []*logspb.ScopeLogs{{LogRecords: make([]*logspb.LogRecord, 1)}}},
		{Resource: resourceNamed("alpha"), ScopeLogs: []*logspb.ScopeLogs{{LogRecords: make([]*logspb.LogRecord, 2)}}},
		{Resource: resourceNamed("empty"), ScopeLogs: []*logspb.ScopeLogs{{}}},
	}}
	m := handlers.UnmappedDialect{}.MapLogs(context.Background(), req)
	if m.Rejected != 4 {
		t.Errorf("rejected = %d, want 4", m.Rejected)
	}
	want := `4 log records not used: sources "alpha", "unknown_service", "zeta" are not mapped`
	if m.Message != want {
		t.Errorf("message = %q, want %q", m.Message, want)
	}
}

// One record reads in the singular; no records leave the mapping empty.
func TestUnmappedDialectSingularAndEmpty(t *testing.T) {
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource:   resourceNamed("claude-code"),
		ScopeSpans: []*tracepb.ScopeSpans{{Spans: make([]*tracepb.Span, 1)}},
	}}}
	m := handlers.UnmappedDialect{}.MapTraces(context.Background(), req)
	if want := `1 span not used: source "claude-code" is not mapped`; m.Message != want {
		t.Errorf("message = %q, want %q", m.Message, want)
	}
	empty := handlers.UnmappedDialect{}.MapTraces(context.Background(), &coltrace.ExportTraceServiceRequest{})
	if empty.Rejected != 0 || empty.Message != "" || len(empty.Events) != 0 {
		t.Errorf("empty request mapped to %+v", empty)
	}
}
