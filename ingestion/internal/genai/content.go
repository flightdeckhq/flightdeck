package genai

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/slim/otlp/trace/v1"
)

// The keys of a staged record's content object. The first six are the
// GenAI attributes the content is read from; the last two name what has
// no attribute of its own. ARCHITECTURE.md (OTLP ingest > GenAI dialect >
// Capture) is the contract.
const (
	contentInput  = "gen_ai.input.messages"
	contentOutput = "gen_ai.output.messages"
	contentSystem = "gen_ai.system_instructions"
	contentTools  = "gen_ai.tool.definitions"
	contentArgs   = "gen_ai.tool.call.arguments"
	contentResult = "gen_ai.tool.call.result"
	// contentFinal is Pydantic AI's final_result attribute on an agent
	// span: what the agent answered.
	contentFinal = "final_result"
	// contentError is a failed span's error text: its status message,
	// else its first exception event's message.
	contentError = "error.message"
)

// contentKeys is the content each kind of record is read for: what its
// event can carry. Every other span (a link span, a foreign scope's)
// stages none: its content has no destination, and Strands'
// execute_event_loop_cycle spans repeat their calls' messages.
var contentKeys = map[spanKind][]string{
	kindModel: {contentInput, contentOutput, contentSystem, contentTools},
	kindTool:  {contentArgs, contentResult},
	kindAgent: {contentInput, contentOutput, contentFinal},
}

// logContentKeys is the content a Google ADK details log record is read
// for: the messages, instructions and tool definitions of its call.
var logContentKeys = []string{contentInput, contentOutput, contentSystem, contentTools}

// The placeholders exporters send in place of content they were told
// not to record: Claude Code's and the OpenTelemetry Python
// instrumentations' <REDACTED>, and Strands' [REDACTED].
var redactedPlaceholders = []string{"<REDACTED>", "[REDACTED]"}

// IsRedacted reports whether a string is a redaction placeholder, which
// counts as no content.
func IsRedacted(s string) bool {
	s = strings.TrimSpace(s)
	for _, p := range redactedPlaceholders {
		if s == p {
			return true
		}
	}
	return false
}

// skeletonKeys are the keys a message or message part carries to
// describe its shape without its text: the frameworks' own capture
// switches keep them (Pydantic AI sends a part as only its type, a tool
// call as its type, id and name). A value whose every other key is empty
// carries no content.
var skeletonKeys = map[string]bool{"type": true, "id": true, "name": true, "role": true, "finish_reason": true}

// hasContent reports whether a content value carries any: a string other
// than an empty one or a redaction placeholder, a number or a boolean,
// anywhere in it outside the skeleton keys of an object.
func hasContent(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(x) != "" && !IsRedacted(x)
	case []any:
		for _, item := range x {
			if hasContent(item) {
				return true
			}
		}
		return false
	case map[string]any:
		for k, item := range x {
			if !skeletonKeys[k] && hasContent(item) {
				return true
			}
		}
		return false
	}
	return true // a number or a boolean
}

// The Strands span events of the older GenAI conventions, one per
// message, and the role each event name stands for. A record keeps them
// as the conventions describe them: each event's attributes, with the
// role its name gives.
const (
	legacySystemEvent = "gen_ai.system.message"
	legacyChoiceEvent = "gen_ai.choice"
	legacyToolEvent   = "gen_ai.tool.message"
	legacyContentAttr = "content"
	legacyMessageAttr = "message"
)

var legacyMessageRoles = map[string]string{
	"gen_ai.user.message":      "user",
	"gen_ai.assistant.message": "assistant",
	legacyToolEvent:            "tool",
}

// SpanContent is a span's captured content as a JSON object keyed by the
// content keys, or nil when it carries none. The receiver calls it only
// for a span whose resource declares capture. A span is read only for
// the content its event can carry (contentKeys): an attribute first,
// else the same key on a Strands details event (the attribute copy is
// kept, so it is stored once), else the older conventions' Strands
// events; and, for a failed tool or agent span, its error text. Values
// that carry no content (a placeholder, a skeleton) are left out.
func SpanContent(f otlpstage.Fact, span *tracepb.Span) json.RawMessage {
	kind := kindOf(f)
	keys := contentKeys[kind]
	if len(keys) == 0 {
		return nil
	}
	allowed := map[string]bool{}
	for _, k := range keys {
		allowed[k] = true
	}
	out := map[string]any{}
	set := func(key string, v any) {
		if _, done := out[key]; done || !allowed[key] || !hasContent(v) {
			return
		}
		out[key] = v
	}
	for _, kv := range span.GetAttributes() {
		set(kv.GetKey(), contentValue(kv.GetValue()))
	}
	var legacyIn, legacyOut []any
	for _, ev := range span.GetEvents() {
		switch name := ev.GetName(); {
		case name == ADKDetailsEvent:
			for _, kv := range ev.GetAttributes() {
				set(kv.GetKey(), contentValue(kv.GetValue()))
			}
		case kind == kindTool && name == legacyToolEvent:
			set(contentArgs, eventAttr(ev, legacyContentAttr))
		case kind == kindTool && name == legacyChoiceEvent:
			set(contentResult, eventAttr(ev, legacyMessageAttr))
		case kind == kindTool:
		case name == legacySystemEvent:
			set(contentSystem, eventAttr(ev, legacyContentAttr))
		case name == legacyChoiceEvent:
			legacyOut = append(legacyOut, legacyMessage(ev, "assistant"))
		case legacyMessageRoles[name] != "":
			legacyIn = append(legacyIn, legacyMessage(ev, legacyMessageRoles[name]))
		}
	}
	if legacyIn != nil {
		set(contentInput, legacyIn)
	}
	if legacyOut != nil {
		set(contentOutput, legacyOut)
	}
	if (kind == kindTool || kind == kindAgent) && f.Status == statusError {
		if msg := errorText(span); msg != "" {
			out[contentError] = msg
		}
	}
	return encodeContent(out)
}

// LogContent is a Google ADK details log record's captured content (the
// messages, instructions and tool definitions of the call it describes),
// or nil when it carries none. Its array values are converted to the
// equivalent JSON.
func LogContent(lr *logspb.LogRecord) json.RawMessage {
	out := map[string]any{}
	for _, kv := range lr.GetAttributes() {
		for _, key := range logContentKeys {
			if kv.GetKey() != key {
				continue
			}
			if _, done := out[key]; done {
				continue
			}
			if v := contentValue(kv.GetValue()); hasContent(v) {
				out[key] = v
			}
		}
	}
	return encodeContent(out)
}

// errorText is a failed span's error text: its status message, else the
// message of its first exception event (Pydantic AI leaves the status
// message empty). Stack traces are never read.
func errorText(span *tracepb.Span) string {
	if msg := strings.TrimSpace(span.GetStatus().GetMessage()); msg != "" && !IsRedacted(msg) {
		return msg
	}
	for _, ev := range span.GetEvents() {
		if ev.GetName() != exceptionEvent {
			continue
		}
		msg := strings.TrimSpace(stringAttr(ev.GetAttributes(), "exception.message"))
		if IsRedacted(msg) {
			return ""
		}
		return msg
	}
	return ""
}

func eventAttr(ev *tracepb.Span_Event, key string) any {
	for _, kv := range ev.GetAttributes() {
		if kv.GetKey() == key {
			return contentValue(kv.GetValue())
		}
	}
	return nil
}

// legacyMessage is one older-conventions message event: its attributes
// as sent, with the role its event name stands for.
func legacyMessage(ev *tracepb.Span_Event, role string) any {
	m := map[string]any{"role": role}
	for _, kv := range ev.GetAttributes() {
		if _, set := m[kv.GetKey()]; !set {
			m[kv.GetKey()] = contentValue(kv.GetValue())
		}
	}
	return m
}

// contentValue is an attribute value as content: a string that holds a
// JSON object or array as that JSON (Pydantic AI, Strands and OpenAI
// Agents encode their messages so), any other string as itself, and an
// array or map value (Google ADK's) as the equivalent JSON.
func contentValue(v *commonpb.AnyValue) any {
	if s, ok := v.GetValue().(*commonpb.AnyValue_StringValue); ok {
		return textValue(s.StringValue)
	}
	return anyJSON(v)
}

func textValue(s string) any {
	t := strings.TrimSpace(s)
	if t == "" || (t[0] != '{' && t[0] != '[') {
		return s
	}
	dec := json.NewDecoder(strings.NewReader(t))
	dec.UseNumber()
	var out any
	if dec.Decode(&out) != nil || dec.More() {
		return s
	}
	return out
}

// anyJSON is an OTLP value as the equivalent JSON: arrays and maps
// element by element, bytes as base64, a NaN or infinite double (which
// JSON cannot hold) as null.
func anyJSON(v *commonpb.AnyValue) any {
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue
	case *commonpb.AnyValue_BoolValue:
		return x.BoolValue
	case *commonpb.AnyValue_IntValue:
		return x.IntValue
	case *commonpb.AnyValue_DoubleValue:
		f, ok := scalar(v)
		if !ok {
			return nil
		}
		return f
	case *commonpb.AnyValue_BytesValue:
		return base64.StdEncoding.EncodeToString(x.BytesValue)
	case *commonpb.AnyValue_ArrayValue:
		out := make([]any, 0, len(x.ArrayValue.GetValues()))
		for _, item := range x.ArrayValue.GetValues() {
			out = append(out, anyJSON(item))
		}
		return out
	case *commonpb.AnyValue_KvlistValue:
		out := make(map[string]any, len(x.KvlistValue.GetValues()))
		for _, kv := range x.KvlistValue.GetValues() {
			if _, seen := out[kv.GetKey()]; !seen {
				out[kv.GetKey()] = anyJSON(kv.GetValue())
			}
		}
		return out
	}
	return nil
}

func encodeContent(m map[string]any) json.RawMessage {
	if len(m) == 0 {
		return nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return b
}

// ---- assembly: staged content to the events' content ----

// ContentProvider is the event_content provider of GenAI content: it is
// stored as the framework sent it, which is no provider's wire format,
// and the Prompts tab renders it by this value.
const ContentProvider = "otel_genai"

// subagentProvider is the event_content provider of a sub-agent message
// too large to ride on its event: the sensor's, which the run drawer's
// sub-agent message view reads.
const subagentProvider = "flightdeck-subagent"

// subagentInlineBytes is the largest sub-agent message body carried on
// its event (incoming_message, outgoing_message); a larger one goes to
// event_content, as the sensor routes it. The staged content was cut to
// fit the event size limit, so no body passes the sensor's hard cap.
const subagentInlineBytes = 8 * 1024

// maxToolErrorChars bounds a failed tool's or agent's error text: the
// bound ARCHITECTURE.md sets for GenAI error messages, long enough for
// an exception's message and short enough that a stack trace a
// framework folds into it does not ride on the event.
const maxToolErrorChars = 200

// traceContent is each record's staged content by span id, a span's and
// its Google ADK log record's merged (the log record's keys win: ADK's
// span repeats its tool definitions without their parameters). Empty
// unless the trace's capture posture is on.
func traceContent(in Input) map[[8]byte]map[string]any {
	out := map[[8]byte]map[string]any{}
	if !in.Trace.Capture {
		return out
	}
	for _, kind := range []otlpstage.Kind{otlpstage.KindSpan, otlpstage.KindLog} {
		for _, f := range in.Facts {
			if f.Kind != kind || len(f.Content) == 0 {
				continue
			}
			var m map[string]any
			dec := json.NewDecoder(bytes.NewReader(f.Content))
			dec.UseNumber()
			if dec.Decode(&m) != nil {
				continue
			}
			c := out[f.SpanID]
			if c == nil {
				c = map[string]any{}
				out[f.SpanID] = c
			}
			for k, v := range m {
				c[k] = v
			}
		}
	}
	return out
}

func (r *resolver) contentOf(n *node) map[string]any {
	if n == nil {
		return nil
	}
	return r.content[n.fact.SpanID]
}

// callContent is a post_call's content: the call's input messages,
// output messages, system instructions and tool definitions, as the
// framework sent them; nil when it has no messages, response or
// instructions (tool definitions alone describe the agent, not the
// call).
func (r *resolver) callContent(n *node, model string) map[string]any {
	c := r.contentOf(n)
	messages, response, system := c[contentInput], c[contentOutput], c[contentSystem]
	if messages == nil && response == nil && system == nil {
		return nil
	}
	env := map[string]any{
		"provider": ContentProvider,
		"model":    model,
		"system":   nil,
		"messages": orEmptyList(messages),
		"tools":    c[contentTools],
		"response": orEmptyList(response),
		"input":    nil,
	}
	if system != nil {
		// The column is text; the instructions are kept as JSON in it.
		if b, err := json.Marshal(system); err == nil {
			env["system"] = string(b)
		}
	}
	return env
}

// toolContent is a tool_call's content, in the tool-capture envelope:
// the call's arguments and result as the framework sent them; nil when
// it has neither.
func (r *resolver) toolContent(n *node) map[string]any {
	c := r.contentOf(n)
	args, result := c[contentArgs], c[contentResult]
	if args == nil && result == nil {
		return nil
	}
	return map[string]any{
		"provider":    ContentProvider,
		"model":       "",
		"system":      nil,
		"messages":    []any{},
		"tools":       nil,
		"response":    map[string]any{},
		"input":       nil,
		"tool_input":  args,
		"tool_output": result,
	}
}

// errorMessage is a failed span's error text with capture on, cut to
// maxToolErrorChars; "" when it has none.
func (r *resolver) errorMessage(n *node) string {
	s, _ := r.contentOf(n)[contentError].(string)
	return clipRunes(s, maxToolErrorChars)
}

// incomingMessage is what a child agent was asked: its agent span's
// input messages, else the arguments of the tool span its parent ran it
// through.
func (r *resolver) incomingMessage(s *session) any {
	if v := r.contentOf(s.agent)[contentInput]; v != nil {
		return v
	}
	return r.contentOf(viaTool(s.agent))[contentArgs]
}

// outgoingMessage is what a child agent answered: its agent span's
// output messages, else Pydantic AI's final_result, else the result of
// the tool span its parent ran it through.
func (r *resolver) outgoingMessage(s *session) any {
	c := r.contentOf(s.agent)
	if v := c[contentOutput]; v != nil {
		return v
	}
	if v := c[contentFinal]; v != nil {
		return v
	}
	return r.contentOf(viaTool(s.agent))[contentResult]
}

// viaTool is the tool span a child agent runs under: the nearest tool
// span above it, below its parent agent; nil when there is none.
func viaTool(n *node) *node {
	for a := n.parent; a != nil && a.kind != kindAgent; a = a.parent {
		if a.kind == kindTool {
			return a
		}
	}
	return nil
}

// subagentMessage puts a child's incoming or outgoing message on its
// session_start or session_end as the sensor does: the body on the
// event up to subagentInlineBytes, else a stub there and the body in
// the event's content, for event_content.
func subagentMessage(p map[string]any, field, direction string, body any, ns int64) {
	if body == nil {
		return
	}
	captured := stamp(ns)
	raw, err := json.Marshal(body)
	if err != nil {
		return
	}
	if len(raw) <= subagentInlineBytes {
		p[field] = map[string]any{"body": body, "captured_at": captured}
		return
	}
	p[field] = map[string]any{"has_content": true, "content_bytes": len(raw), "captured_at": captured}
	p["has_content"] = true
	p["content"] = map[string]any{
		"provider": subagentProvider,
		"model":    "",
		"system":   nil,
		"messages": []any{},
		"tools":    nil,
		"response": map[string]any{"direction": direction, "body": body, "captured_at": captured},
		"input":    nil,
	}
}

func orEmptyList(v any) any {
	if v == nil {
		return []any{}
	}
	return v
}

// clipRunes cuts s to at most n characters.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for pos := range s {
		if i == n {
			return s[:pos]
		}
		i++
	}
	return s
}
