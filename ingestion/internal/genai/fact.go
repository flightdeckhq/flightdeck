package genai

import (
	"encoding/json"
	"errors"
	"math"
	"strings"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/slim/otlp/trace/v1"
)

// The span attributes a fact keeps. ARCHITECTURE.md (OTLP ingest > GenAI
// dialect > Staging) lists them: metadata only, never message text, tool
// arguments or results, or error text.
const (
	attrOperation        = "gen_ai.operation.name"
	attrAgentName        = "gen_ai.agent.name"
	attrRequestModel     = "gen_ai.request.model"
	attrResponseModel    = "gen_ai.response.model"
	attrProviderName     = "gen_ai.provider.name"
	attrSystem           = "gen_ai.system"
	attrInputTokens      = "gen_ai.usage.input_tokens"
	attrOutputTokens     = "gen_ai.usage.output_tokens"
	attrCacheRead        = "gen_ai.usage.cache_read.input_tokens"
	attrCacheReadDetails = "gen_ai.usage.details.cache_read_input_tokens"
	attrCacheReadLegacy  = "gen_ai.usage.cache_read_input_tokens"
	attrCacheCreation    = "gen_ai.usage.details.cache_creation_input_tokens"
	attrToolName         = "gen_ai.tool.name"
	attrToolCallID       = "gen_ai.tool.call.id"
	attrToolType         = "gen_ai.tool.type"
	attrHandoffFrom      = "gen_ai.handoff.from_agent"
	attrHandoffTo        = "gen_ai.handoff.to_agent"
	attrErrorType        = "error.type"
	attrExceptionType    = "exception.type"
	attrTTFT             = "gen_ai.server.time_to_first_token"
	attrOperationCost    = "operation.cost"
	attrResponseID       = "gen_ai.response.id"
	attrConversationID   = "gen_ai.conversation.id"
	attrADKEventID       = "gcp.vertex.agent.event_id"
	// attrHasMessages is the one key an ADK log record's fact adds:
	// whether the record carried messages, which is not itself content.
	attrHasMessages = "has_messages"
)

// metaKeys is the span attribute allowlist.
var metaKeys = map[string]bool{
	attrOperation: true, attrAgentName: true, attrRequestModel: true,
	attrResponseModel: true, attrProviderName: true, attrSystem: true,
	attrInputTokens: true, attrOutputTokens: true, attrCacheRead: true,
	attrCacheReadDetails: true, attrCacheReadLegacy: true, attrCacheCreation: true,
	attrToolName: true, attrToolCallID: true, attrToolType: true,
	attrHandoffFrom: true, attrHandoffTo: true, attrErrorType: true,
	attrTTFT: true, attrOperationCost: true, attrResponseID: true,
	attrConversationID: true, attrADKEventID: true,
}

// The ADK log record the dialect stages, and the attributes that tell
// whether it carried messages.
const (
	// ADKDetailsEvent is the event name of Google ADK's per-call log
	// record; its other log records are not staged.
	ADKDetailsEvent = "gen_ai.client.inference.operation.details"
	attrEventName   = "event.name"
)

var adkMessageKeys = []string{"gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions"}

// The OTLP exception event and its type attribute.
const exceptionEvent = "exception"

// OTLP span flags: bit 0x100 says whether the parent's remoteness is
// known and bit 0x200 that it is remote. A span with both set has its
// parent in another process, so it is its trace's root here.
const remoteParentFlags = 0x300

// The OTLP status code of a failed span.
const statusError = int16(tracepb.Status_STATUS_CODE_ERROR)

// ErrRecordIDs is returned for a record that cannot be placed in a
// trace: it lacks a 16-byte trace id or an 8-byte span id.
var ErrRecordIDs = errors.New("a GenAI record needs a 16-byte trace id and an 8-byte span id")

// SpanFact reads a span into its trace id and content-free fact: the
// span's identity and timing, its status code, the allowlisted
// attributes and the first exception event's type. Nothing else of the
// span is read.
func SpanFact(scope *commonpb.InstrumentationScope, span *tracepb.Span) ([16]byte, otlpstage.Fact, error) {
	var trace [16]byte
	var f otlpstage.Fact
	if len(span.GetTraceId()) != len(trace) || len(span.GetSpanId()) != len(f.SpanID) {
		return trace, f, ErrRecordIDs
	}
	copy(trace[:], span.GetTraceId())
	copy(f.SpanID[:], span.GetSpanId())
	if p := span.GetParentSpanId(); len(p) == len(f.ParentSpanID) {
		copy(f.ParentSpanID[:], p)
		f.RemoteParent = span.GetFlags()&remoteParentFlags == remoteParentFlags
	}
	f.Kind = otlpstage.KindSpan
	f.ScopeName = scope.GetName()
	f.ScopeVersion = scope.GetVersion()
	f.Name = span.GetName()
	f.StartNs = nanos(span.GetStartTimeUnixNano())
	f.EndNs = nanos(span.GetEndTimeUnixNano())
	f.Status = int16(span.GetStatus().GetCode()) //nolint:gosec // the status enum has three values

	meta := map[string]any{}
	for _, kv := range span.GetAttributes() {
		if !metaKeys[kv.GetKey()] {
			continue
		}
		if _, seen := meta[kv.GetKey()]; seen {
			continue // a key sent twice keeps its first value
		}
		if v, ok := scalar(kv.GetValue()); ok {
			meta[kv.GetKey()] = v
		}
	}
	for _, ev := range span.GetEvents() {
		if ev.GetName() != exceptionEvent {
			continue
		}
		if t := stringAttr(ev.GetAttributes(), attrExceptionType); t != "" {
			meta[attrExceptionType] = t
		}
		break // Google ADK repeats the event; the first is kept
	}
	f.Op, _ = meta[attrOperation].(string)
	f.AgentName, _ = meta[attrAgentName].(string)
	f.Meta = encodeMeta(meta)
	return trace, f, nil
}

// IsADKDetails reports whether a log record is Google ADK's per-call
// record, the only log record the dialect stages.
func IsADKDetails(lr *logspb.LogRecord) bool {
	name := lr.GetEventName()
	if name == "" {
		name = stringAttr(lr.GetAttributes(), attrEventName)
	}
	return name == ADKDetailsEvent
}

// LogFact reads a Google ADK details log record into its trace id and
// fact, keyed by the span id of the call it describes. The fact keeps
// only whether the record carried messages; the usage it repeats is the
// span's and is never read from here.
func LogFact(scope *commonpb.InstrumentationScope, lr *logspb.LogRecord) ([16]byte, otlpstage.Fact, error) {
	var trace [16]byte
	var f otlpstage.Fact
	if len(lr.GetTraceId()) != len(trace) || len(lr.GetSpanId()) != len(f.SpanID) {
		return trace, f, ErrRecordIDs
	}
	copy(trace[:], lr.GetTraceId())
	copy(f.SpanID[:], lr.GetSpanId())
	f.Kind = otlpstage.KindLog
	f.ScopeName = scope.GetName()
	f.ScopeVersion = scope.GetVersion()
	f.Name = ADKDetailsEvent
	ts := lr.GetTimeUnixNano()
	if ts == 0 {
		ts = lr.GetObservedTimeUnixNano()
	}
	f.StartNs, f.EndNs = nanos(ts), nanos(ts)
	has := false
	for _, kv := range lr.GetAttributes() {
		for _, k := range adkMessageKeys {
			if kv.GetKey() == k && !emptyValue(kv.GetValue()) {
				has = true
			}
		}
	}
	f.Meta = encodeMeta(map[string]any{attrHasMessages: has})
	return trace, f, nil
}

// The resource attributes a trace's identity resource keeps: what the
// identity, billing and capture of its sessions are derived from.
const (
	attrServiceName    = "service.name"
	attrServiceVersion = "service.version"
	attrHostName       = "host.name"
	attrUserID         = "user.id"
	attrUserName       = "user.name"
	attrFlavor         = "flightdeck.flavor"
	attrAgentType      = "flightdeck.agent_type"
	attrBillingMode    = "flightdeck.billing_mode"
	attrCapturePrompts = "flightdeck.capture_prompts"
)

var resourceKeys = []string{
	attrServiceName, attrServiceVersion, attrHostName, attrUserID, attrUserName,
	attrFlavor, attrAgentType, attrBillingMode, attrCapturePrompts,
}

// IdentityResource is the allowlisted identity resource of a trace as a
// JSON object of strings: only the keys identity, billing and capture
// read, each as its string form.
func IdentityResource(attrs []*commonpb.KeyValue) json.RawMessage {
	out := map[string]any{}
	for _, key := range resourceKeys {
		for _, kv := range attrs {
			if kv.GetKey() != key {
				continue
			}
			if v, ok := scalar(kv.GetValue()); ok {
				out[key] = scalarString(v)
			}
			break
		}
	}
	return encodeMeta(out)
}

// scalar is an attribute value as a JSON scalar: a string, an int64, a
// float64 or a bool. Arrays, maps, bytes and a NaN or infinite double,
// which JSON cannot hold, are not kept.
func scalar(v *commonpb.AnyValue) (any, bool) {
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue, true
	case *commonpb.AnyValue_IntValue:
		return x.IntValue, true
	case *commonpb.AnyValue_DoubleValue:
		if math.IsNaN(x.DoubleValue) || math.IsInf(x.DoubleValue, 0) {
			return nil, false
		}
		return x.DoubleValue, true
	case *commonpb.AnyValue_BoolValue:
		return x.BoolValue, true
	}
	return nil, false
}

func scalarString(v any) string {
	b, _ := json.Marshal(v)
	s := string(b)
	if str, ok := v.(string); ok {
		s = str
	}
	return s
}

// emptyValue reports a value that carries nothing: absent, an empty
// string, array or map.
func emptyValue(v *commonpb.AnyValue) bool {
	switch x := v.GetValue().(type) {
	case nil:
		return true
	case *commonpb.AnyValue_StringValue:
		return strings.TrimSpace(x.StringValue) == ""
	case *commonpb.AnyValue_ArrayValue:
		return len(x.ArrayValue.GetValues()) == 0
	case *commonpb.AnyValue_KvlistValue:
		return len(x.KvlistValue.GetValues()) == 0
	}
	return false
}

func encodeMeta(m map[string]any) json.RawMessage {
	b, err := json.Marshal(m)
	if err != nil {
		return json.RawMessage("{}")
	}
	return b
}

// nanos is an OTLP timestamp as int64 nanoseconds; a time past 2262 is
// not a real record and is held at the largest value.
func nanos(t uint64) int64 {
	const maxNanos = 1<<63 - 1
	if t > maxNanos {
		return maxNanos
	}
	return int64(t)
}
