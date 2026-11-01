package handlers

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	metricspb "go.opentelemetry.io/proto/slim/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/slim/otlp/resource/v1"
)

// OTLPEvent is one Flightdeck event a dialect maps from OTLP records,
// ready to publish: its event_type picks the NATS subject and Payload
// is the event's JSON body.
type OTLPEvent struct {
	EventType string
	Payload   []byte
}

// OTLPMapping is what a dialect makes of one decoded export request:
// the events to publish, how many of the request's records it did not
// use (log records, spans or data points, by signal), and a message
// naming why, which goes into the response's partial_success.
type OTLPMapping struct {
	Events   []OTLPEvent
	Rejected int64
	Message  string
}

// OTLPDialect maps decoded OTLP export requests to Flightdeck events.
// The receiver owns the transport (auth, limits, decoding, the export
// response); the dialect owns everything a source's records mean. An
// event it returns has passed the same validation as POST /v1/events:
// a record whose event fails it is counted in Rejected instead.
type OTLPDialect interface {
	MapLogs(ctx context.Context, req *collogs.ExportLogsServiceRequest) OTLPMapping
	MapTraces(ctx context.Context, req *coltrace.ExportTraceServiceRequest) OTLPMapping
	MapMetrics(ctx context.Context, req *colmetrics.ExportMetricsServiceRequest) OTLPMapping
}

// UnmappedDialect maps no source: every record is accepted and counted
// as rejected, with a message naming the sources it came from.
type UnmappedDialect struct{}

// MapLogs counts every log record as rejected.
func (UnmappedDialect) MapLogs(_ context.Context, req *collogs.ExportLogsServiceRequest) OTLPMapping {
	var n int64
	sources := newSourceSet()
	for _, rl := range req.GetResourceLogs() {
		var inResource int64
		for _, sl := range rl.GetScopeLogs() {
			inResource += int64(len(sl.GetLogRecords()))
		}
		if inResource > 0 {
			sources.add(rl.GetResource())
		}
		n += inResource
	}
	return unmapped(n, "log record", sources)
}

// MapTraces counts every span as rejected.
func (UnmappedDialect) MapTraces(_ context.Context, req *coltrace.ExportTraceServiceRequest) OTLPMapping {
	var n int64
	sources := newSourceSet()
	for _, rs := range req.GetResourceSpans() {
		var inResource int64
		for _, ss := range rs.GetScopeSpans() {
			inResource += int64(len(ss.GetSpans()))
		}
		if inResource > 0 {
			sources.add(rs.GetResource())
		}
		n += inResource
	}
	return unmapped(n, "span", sources)
}

// MapMetrics counts every data point as rejected.
func (UnmappedDialect) MapMetrics(_ context.Context, req *colmetrics.ExportMetricsServiceRequest) OTLPMapping {
	var n int64
	sources := newSourceSet()
	for _, rm := range req.GetResourceMetrics() {
		var inResource int64
		for _, sm := range rm.GetScopeMetrics() {
			for _, m := range sm.GetMetrics() {
				inResource += countDataPoints(m)
			}
		}
		if inResource > 0 {
			sources.add(rm.GetResource())
		}
		n += inResource
	}
	return unmapped(n, "data point", sources)
}

// countDataPoints is the number of data points a metric carries,
// whatever its type: partial_success counts metrics in data points.
func countDataPoints(m *metricspb.Metric) int64 {
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

// unknownOTLPSource names a resource that carries no service.name.
const unknownOTLPSource = "unknown_service"

// Bounds on the sources a partial_success message names. A request
// may carry any number of resources with names of any length, and the
// message is echoed to the exporter and into its logs: it names the
// first maxEchoedOTLPSources sources, each cut to
// maxEchoedOTLPSourceBytes, and counts the rest. The set tracks at
// most maxTrackedOTLPSources distinct names, so a request of a million
// resources costs a bounded map.
const (
	maxEchoedOTLPSources     = 5
	maxEchoedOTLPSourceBytes = 128
	maxTrackedOTLPSources    = 64
)

// sourceSet collects the service.name of the resources records came
// from, for the partial_success message.
type sourceSet struct {
	names    map[string]struct{}
	overflow bool // more distinct names than were tracked
}

func newSourceSet() *sourceSet {
	return &sourceSet{names: map[string]struct{}{}}
}

func (s *sourceSet) add(res *resourcepb.Resource) {
	name := truncateUTF8(serviceName(res.GetAttributes()), maxEchoedOTLPSourceBytes)
	if _, ok := s.names[name]; ok {
		return
	}
	if len(s.names) == maxTrackedOTLPSources {
		s.overflow = true
		return
	}
	s.names[name] = struct{}{}
}

func (s *sourceSet) len() int { return len(s.names) }

// String names the first sources in sorted order, then counts the
// rest: `"a", "b", "c", "d", "e" and 7 more` ("at least" once more
// names arrived than were tracked).
func (s *sourceSet) String() string {
	names := make([]string, 0, len(s.names))
	for name := range s.names {
		names = append(names, name)
	}
	sort.Strings(names)
	shown := names[:min(len(names), maxEchoedOTLPSources)]
	quoted := make([]string, len(shown))
	for i, name := range shown {
		quoted[i] = fmt.Sprintf("%q", name)
	}
	out := strings.Join(quoted, ", ")
	rest := len(names) - len(shown)
	switch {
	case s.overflow:
		out += fmt.Sprintf(" and at least %d more", rest+1)
	case rest > 0:
		out += fmt.Sprintf(" and %d more", rest)
	}
	return out
}

// truncateUTF8 cuts s to at most n bytes without splitting a rune.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// serviceName is a resource's service.name attribute, the key a
// source's dialect is detected by.
func serviceName(attrs []*commonpb.KeyValue) string {
	for _, kv := range attrs {
		if kv.GetKey() == "service.name" {
			if v := kv.GetValue().GetStringValue(); v != "" {
				return v
			}
		}
	}
	return unknownOTLPSource
}

// unmapped counts n records of one kind as rejected, with a message
// such as `3 log records not used: source "claude-code" is not mapped`.
func unmapped(n int64, record string, sources *sourceSet) OTLPMapping {
	if n == 0 {
		return OTLPMapping{}
	}
	if n != 1 {
		record += "s"
	}
	subject := "source " + sources.String() + " is"
	if sources.len() > 1 {
		subject = "sources " + sources.String() + " are"
	}
	return OTLPMapping{
		Rejected: n,
		Message:  fmt.Sprintf("%d %s not used: %s not mapped", n, record, subject),
	}
}
