// Package genai is the mapping of the OTLP GenAI dialect: the pure code
// that turns the staged records of one OpenTelemetry GenAI trace into
// Flightdeck events. It reads OTLP spans and Google ADK log records into
// content-free facts (fact.go), indexes a trace's facts (trace.go),
// derives each session's identity (identity.go) and maps the whole trace
// to session_start, post_call, llm_error, tool_call, session_signal and
// session_end payloads (normalize.go), and reads a record's content and
// maps it to the events' content under the capture gate (content.go).
// It does no I/O: the staging store
// (internal/otlpstage) holds the facts, and the assembler publishes what
// Resolve returns through the receiver's validation and publish path.
// ARCHITECTURE.md (OTLP ingest > GenAI dialect) is the contract.
package genai

import (
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
)

// VersionFrom names where a framework's version (sensor_version, and the
// version in context.frameworks) is read from.
type VersionFrom int

const (
	// VersionFromScope reads the instrumentation scope's version.
	VersionFromScope VersionFrom = iota
	// VersionFromService reads the resource's service.version.
	VersionFromService
	// VersionNone: the framework sends no version anywhere.
	VersionNone
)

// Source is one framework the GenAI dialect maps, recognised by the
// instrumentation scope its own spans are recorded under.
type Source struct {
	// Scope is the instrumentation scope name.
	Scope string
	// Label is the framework label: the event's framework field and the
	// name in context.frameworks.
	Label string
	// VersionFrom says where the framework's version is read from.
	VersionFrom VersionFrom
	// TrustProvider reports that the framework's gen_ai.provider.name
	// names the model's provider. Strands names itself and the OpenAI
	// Agents instrumentation reports a configured default, so their
	// value is never passed through.
	TrustProvider bool
}

// The framework labels.
const (
	LabelPydanticAI   = "pydantic_ai"
	LabelStrands      = "strands"
	LabelOpenAIAgents = "openai_agents"
	LabelGoogleADK    = "google_adk"
)

// sources is the scope table of ARCHITECTURE.md (OTLP ingest > GenAI
// dialect). A framework is added only from a recording of its own
// telemetry (tests/fixtures/otlp/GENAI_COMPARISON.md).
var sources = []Source{
	{Scope: "pydantic-ai", Label: LabelPydanticAI, VersionFrom: VersionFromScope, TrustProvider: true},
	{Scope: "strands.telemetry.tracer", Label: LabelStrands, VersionFrom: VersionFromService},
	{Scope: "opentelemetry.instrumentation.openai_agents", Label: LabelOpenAIAgents, VersionFrom: VersionNone},
	{Scope: "gcp.vertex.agent", Label: LabelGoogleADK, VersionFrom: VersionFromScope, TrustProvider: true},
}

// SourceForScope returns the framework a scope name belongs to.
func SourceForScope(scope string) (Source, bool) {
	for _, s := range sources {
		if s.Scope == scope {
			return s, true
		}
	}
	return Source{}, false
}

// SourceForLabel returns the framework with a label.
func SourceForLabel(label string) (Source, bool) {
	for _, s := range sources {
		if s.Label == label {
			return s, true
		}
	}
	return Source{}, false
}

// Version is the framework's version as its row records it, from the
// scope version or the resource's service.version.
func (s Source) Version(scopeVersion string, resource []*commonpb.KeyValue) string {
	switch s.VersionFrom {
	case VersionFromScope:
		return scopeVersion
	case VersionFromService:
		return stringAttr(resource, attrServiceVersion)
	}
	return ""
}

// Recognize returns the framework of a resource: the first of its scopes
// that the table names. A resource with none is not the GenAI dialect's.
// Routing reads only scope names, never service.name or the schema URL:
// two of the frameworks send unknown_service:python and Google ADK sends
// an empty resource.
func Recognize(scopes []*commonpb.InstrumentationScope) (Source, *commonpb.InstrumentationScope, bool) {
	for _, sc := range scopes {
		if s, ok := SourceForScope(sc.GetName()); ok {
			return s, sc, true
		}
	}
	return Source{}, nil, false
}

// stringAttr is a resource attribute's string value, "" when absent or
// not a string.
func stringAttr(attrs []*commonpb.KeyValue, key string) string {
	for _, kv := range attrs {
		if kv.GetKey() == key {
			return kv.GetValue().GetStringValue()
		}
	}
	return ""
}
