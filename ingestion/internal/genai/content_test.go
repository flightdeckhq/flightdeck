package genai

import (
	"bytes"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/slim/otlp/trace/v1"
)

// ---- helpers ----

func str(s string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: s}}
}

func kvs(pairs ...any) []*commonpb.KeyValue {
	var out []*commonpb.KeyValue
	for i := 0; i+1 < len(pairs); i += 2 {
		v, ok := pairs[i+1].(*commonpb.AnyValue)
		if !ok {
			v = str(pairs[i+1].(string))
		}
		out = append(out, &commonpb.KeyValue{Key: pairs[i].(string), Value: v})
	}
	return out
}

// contentSpan is a span of scope, operation and agent name with the
// given attributes and events, and its fact.
func contentSpan(t *testing.T, scope, op, agent string, attrs []*commonpb.KeyValue, events ...*tracepb.Span_Event) (otlpstage.Fact, *tracepb.Span) {
	t.Helper()
	all := kvs(attrOperation, op)
	if agent != "" {
		all = append(all, kvs(attrAgentName, agent)...)
	}
	sp := &tracepb.Span{
		TraceId: make([]byte, 16), SpanId: []byte{0, 0, 0, 0, 0, 0, 0, 1}, Name: op,
		StartTimeUnixNano: 1, EndTimeUnixNano: 2, Attributes: append(all, attrs...), Events: events,
	}
	sp.TraceId[15] = 1
	_, f, err := SpanFact(&commonpb.InstrumentationScope{Name: scope}, sp)
	if err != nil {
		t.Fatal(err)
	}
	return f, sp
}

func decodeContent(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	if raw == nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("content %s: %v", raw, err)
	}
	return m
}

func event(name string, attrs ...any) *tracepb.Span_Event {
	return &tracepb.Span_Event{Name: name, Attributes: kvs(attrs...)}
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// contentCarriers is every event of an assembly that carries content of
// any kind: a content object, or a sub-agent message.
func contentCarriers(evs []Event) []Event {
	var out []Event
	for _, ev := range evs {
		p := ev.Payload
		if p["has_content"] == true || p["content"] != nil || p["incoming_message"] != nil || p["outgoing_message"] != nil {
			out = append(out, ev)
		}
	}
	return out
}

// ---- reading content from a span or log record (the ingest split) ----

// The content a span is read for depends on what its event can carry: a
// model call its messages, instructions and tool definitions; a tool its
// arguments and result; an agent its messages and Pydantic AI's
// final_result. A link span, or a foreign scope's, stages none, and no
// span stages an attribute outside that list.
func TestSpanContentReadsOnlyWhatItsEventCarries(t *testing.T) {
	attrs := kvs(
		contentInput, `[{"role":"user","parts":[{"type":"text","content":"hi"}]}]`,
		contentOutput, `[{"role":"assistant","parts":[{"type":"text","content":"hello"}]}]`,
		contentSystem, `[{"type":"text","content":"be brief"}]`,
		contentTools, `[{"type":"function","name":"f","description":"does f"}]`,
		contentArgs, `{"city":"Paris"}`,
		contentResult, "sunny",
		contentFinal, "done",
		"pydantic_ai.all_messages", `[{"role":"user","parts":[{"type":"text","content":"hi"}]}]`,
		"logfire.msg", "running tool",
	)
	cases := []struct {
		scope, op, agent string
		want             []string
	}{
		{"pydantic-ai", "chat", "", []string{contentInput, contentOutput, contentSystem, contentTools}},
		{"pydantic-ai", "execute_tool", "", []string{contentArgs, contentResult}},
		{"pydantic-ai", "invoke_agent", "a", []string{contentFinal, contentInput, contentOutput}},
		{"pydantic-ai", "invoke_agent", "", nil}, // a nameless agent links only
		{"strands.telemetry.tracer", "execute_event_loop_cycle", "", nil},
		{"com.anthropic.sdk.python", "chat", "", nil}, // a foreign scope links only
	}
	for _, tc := range cases {
		f, sp := contentSpan(t, tc.scope, tc.op, tc.agent, attrs)
		got := decodeContent(t, SpanContent(f, sp))
		var keys []string
		for k := range got {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		if !reflect.DeepEqual(keys, tc.want) {
			t.Errorf("%s %s %q: keys %v, want %v", tc.scope, tc.op, tc.agent, keys, tc.want)
		}
	}
}

// A string that holds a JSON object or array is kept as that JSON; any
// other string as itself. Google ADK's array and map values become the
// equivalent JSON, bytes as base64 and numbers exact.
func TestContentValuesAsJSON(t *testing.T) {
	f, sp := contentSpan(t, "pydantic-ai", "execute_tool", "", kvs(contentArgs, `{"n": 12345678901234567890}`, contentResult, "[not json"))
	got := decodeContent(t, SpanContent(f, sp))
	if asJSON(t, got[contentArgs]) != `{"n":12345678901234567890}` || got[contentResult] != "[not json" {
		t.Errorf("content = %v", got)
	}

	adk := &commonpb.AnyValue{Value: &commonpb.AnyValue_ArrayValue{ArrayValue: &commonpb.ArrayValue{Values: []*commonpb.AnyValue{
		{Value: &commonpb.AnyValue_KvlistValue{KvlistValue: &commonpb.KeyValueList{Values: []*commonpb.KeyValue{
			{Key: "role", Value: str("user")},
			{Key: "n", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 7}}},
			{Key: "ok", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: true}}},
			{Key: "raw", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_BytesValue{BytesValue: []byte("hi")}}},
			{Key: "none", Value: &commonpb.AnyValue{}},
			{Key: "parts", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_ArrayValue{ArrayValue: &commonpb.ArrayValue{Values: []*commonpb.AnyValue{str("text")}}}}},
		}}}},
	}}}}
	lr := &logspb.LogRecord{EventName: ADKDetailsEvent, Attributes: []*commonpb.KeyValue{
		{Key: contentInput, Value: adk},
		{Key: "user.id", Value: str("someone")},
	}}
	got = decodeContent(t, LogContent(lr))
	if want := `{"gen_ai.input.messages":[{"n":7,"none":null,"ok":true,"parts":["text"],"raw":"aGk=","role":"user"}]}`; asJSON(t, got) != want {
		t.Errorf("ADK content = %s, want %s", asJSON(t, got), want)
	}
}

// Placeholders and skeletons are no content: <REDACTED> and [REDACTED]
// (E8), Pydantic AI's message skeletons whose parts carry only their
// type, id and name (E5), and empty values; a value with any text in it
// is kept whole.
func TestContentPlaceholdersAndSkeletons(t *testing.T) {
	none := []string{
		"<REDACTED>", " [REDACTED] ", "", "   ", "[]", "{}",
		`[{"role":"system","parts":[{"type":"text"}]},{"role":"user","parts":[{"type":"text"}]}]`,
		`[{"role":"assistant","parts":[{"type":"tool_call","id":"toolu_1","name":"get_weather"}],"finish_reason":"tool_call"}]`,
		`[{"type":"text"}]`,
		`[{"role":"user","content":"[REDACTED]"}]`,
	}
	for _, v := range none {
		f, sp := contentSpan(t, "pydantic-ai", "chat", "", kvs(contentInput, v))
		if got := SpanContent(f, sp); got != nil {
			t.Errorf("%q staged %s", v, got)
		}
	}
	some := []string{
		"hi",
		`[{"role":"assistant","parts":[{"type":"tool_call","id":"toolu_1","name":"get_weather","arguments":{"city":"Paris"}}]}]`,
		`[{"role":"user","parts":[{"type":"text","content":"hi"}]}]`,
		`[{"role":"user","content":"x"}]`,
	}
	for _, v := range some {
		f, sp := contentSpan(t, "pydantic-ai", "chat", "", kvs(contentInput, v))
		if got := decodeContent(t, SpanContent(f, sp)); got[contentInput] == nil {
			t.Errorf("%q staged nothing", v)
		}
	}
}

// Strands' details events carry the latest conventions' keys: one is
// read only when the span has no attribute of the same key, so a value
// sent both ways is kept once (E7), and the first event of a key wins.
// The older conventions' events (one per message) become the input and
// output messages, each with the role its event name stands for, and a
// tool's tool message and choice its arguments and result.
func TestSpanContentStrandsEvents(t *testing.T) {
	f, sp := contentSpan(t, "strands.telemetry.tracer", "invoke_agent", "a",
		kvs(contentInput, `[{"role":"user","parts":[{"type":"text","content":"from the attribute"}]}]`),
		event(ADKDetailsEvent, contentInput, `[{"role":"user","parts":[{"type":"text","content":"from the event"}]}]`),
		event(ADKDetailsEvent, contentOutput, `[{"role":"assistant","parts":[{"type":"text","content":"first"}]}]`),
		event(ADKDetailsEvent, contentOutput, `[{"role":"assistant","parts":[{"type":"text","content":"second"}]}]`),
	)
	got := asJSON(t, decodeContent(t, SpanContent(f, sp)))
	if strings.Contains(got, "from the event") || !strings.Contains(got, "from the attribute") ||
		!strings.Contains(got, "first") || strings.Contains(got, "second") {
		t.Errorf("latest conventions: %s", got)
	}

	f, sp = contentSpan(t, "strands.telemetry.tracer", "chat", "", nil,
		event("gen_ai.system.message", "content", `[{"text":"be brief"}]`),
		event("gen_ai.user.message", "content", `[{"text":"hi"}]`),
		event("gen_ai.assistant.message", "content", `[{"text":"hello"}]`),
		event("gen_ai.choice", "message", `[{"text":"bye"}]`, "finish_reason", "end_turn"),
	)
	want := `{"gen_ai.input.messages":[{"content":[{"text":"hi"}],"role":"user"},{"content":[{"text":"hello"}],"role":"assistant"}],` +
		`"gen_ai.output.messages":[{"finish_reason":"end_turn","message":[{"text":"bye"}],"role":"assistant"}],` +
		`"gen_ai.system_instructions":[{"text":"be brief"}]}`
	if got := asJSON(t, decodeContent(t, SpanContent(f, sp))); got != want {
		t.Errorf("older conventions:\n got %s\nwant %s", got, want)
	}

	f, sp = contentSpan(t, "strands.telemetry.tracer", "execute_tool", "", nil,
		event("gen_ai.tool.message", "role", "tool", "content", `{"city":"Paris"}`, "id", "call_1"),
		event("gen_ai.choice", "message", `[{"text":"sunny"}]`, "id", "call_1"),
	)
	if got := asJSON(t, decodeContent(t, SpanContent(f, sp))); got != `{"gen_ai.tool.call.arguments":{"city":"Paris"},"gen_ai.tool.call.result":[{"text":"sunny"}]}` {
		t.Errorf("older conventions tool: %s", got)
	}
}

// A failed tool or agent span's error text is its status message, else
// its first exception's message; the stack trace is never read. A model
// span's is not staged: a failed call's error_message is its class.
func TestSpanContentErrorText(t *testing.T) {
	exc := event(exceptionEvent, "exception.type", "ValueError", "exception.message", "order 42 not found",
		"exception.stacktrace", "Traceback (most recent call last): secret frame")
	for _, tc := range []struct {
		op, agent, status, want string
	}{
		{"execute_tool", "", "", "order 42 not found"},
		{"execute_tool", "", "ValueError: boom", "ValueError: boom"},
		{"execute_tool", "", "[REDACTED]", "order 42 not found"},
		{"invoke_agent", "a", "", "order 42 not found"},
		{"chat", "", "boom", ""},
	} {
		f, sp := contentSpan(t, "pydantic-ai", tc.op, tc.agent, nil, exc)
		sp.Status = &tracepb.Status{Code: tracepb.Status_STATUS_CODE_ERROR, Message: tc.status}
		f.Status = int16(tracepb.Status_STATUS_CODE_ERROR)
		got := decodeContent(t, SpanContent(f, sp))
		if msg, _ := got[contentError].(string); msg != tc.want {
			t.Errorf("%s status %q: error text %q, want %q", tc.op, tc.status, msg, tc.want)
		}
		if strings.Contains(asJSON(t, got), "Traceback") {
			t.Errorf("%s: the stack trace was staged", tc.op)
		}
	}
	// A span that did not fail has no error text, whatever its events say.
	f, sp := contentSpan(t, "pydantic-ai", "execute_tool", "", nil, exc)
	if got := SpanContent(f, sp); got != nil {
		t.Errorf("an ok span staged %s", got)
	}
}

// ---- the recordings ----

// E5, E8, E12, E17: with the framework's own switch off (or Strands
// redacting), nothing of what the frameworks send is content, even when
// the operator declares capture: no event carries content, and no record
// stages messages. Pydantic AI and Google ADK still send tool
// definitions, which describe the agent and are staged, but a call with
// only those carries no content.
func TestContentNoContentRecordings(t *testing.T) {
	for _, tc := range []struct{ e, fw, scenario string }{
		{"E5", fxPydantic, "tool-no-content-protobuf"},
		{"E8", fxStrands, "tool-redacted-protobuf"},
		{"E12", fxOpenAI, "tool-no-content-protobuf"},
		{"E17", fxADK, "tool-no-content-protobuf"},
	} {
		in := fixtureInput(t, tc.fw, tc.scenario, true)
		for _, f := range in.Facts {
			for k := range decodeContent(t, f.Content) {
				if k != contentTools {
					t.Errorf("%s: %s stages %s", tc.e, f.Name, k)
				}
			}
		}
		if got := contentCarriers(Resolve(in)); len(got) != 0 {
			t.Errorf("%s: %d events carry content, first %s", tc.e, len(got), got[0].EventType)
		}
	}
}

// E7: Strands under the latest conventions sends each message both as a
// details event and, for some, an attribute: each is kept once. Its
// execute_event_loop_cycle spans repeat the calls' messages and stage
// nothing.
func TestContentE7KeptOnce(t *testing.T) {
	in := fixtureInput(t, fxStrands, "tool-latest-json", true)
	for _, f := range in.Facts {
		if f.Name == "execute_event_loop_cycle" && f.Content != nil {
			t.Errorf("an event loop cycle staged %s", f.Content)
		}
	}
	evs := Resolve(in)
	calls := ofType(evs, "post_call")
	first := calls[0]["content"].(map[string]any)
	if msgs := first["messages"].([]any); len(msgs) != 1 {
		t.Errorf("the first call's input is %d messages, want the 1 it was sent", len(msgs))
	}
	if first["system"] != `[{"content":"Answer weather questions with the get_weather tool.","type":"text"}]` {
		t.Errorf("system = %v", first["system"])
	}
	tool := ofType(evs, "tool_call")[0]["content"].(map[string]any)
	if asJSON(t, tool["tool_input"]) != `{"city":"Paris"}` || asJSON(t, tool["tool_output"]) != `[{"text":"Paris: sunny, 21 C"}]` {
		t.Errorf("tool content = %v", tool)
	}
}

// A post_call's content is the call's own: its input and output messages
// as the framework sent them (rule 20: never converted), its system
// instructions as JSON text and its tool definitions, under the GenAI
// provider and the requested model. A tool_call's is its arguments and
// result in the tool-capture envelope.
func TestContentPostCallAndToolCall(t *testing.T) {
	cases := []struct {
		e, fw, scenario string
		model           string
		system          bool
		firstResponse   string // a fragment of the first call's response
		toolInput       string
		toolOutput      string
	}{
		{"E1", fxPydantic, "tool-protobuf", "claude-haiku-4-5", true, `"name":"get_weather","type":"tool_call"`, `{"city":"Paris"}`, `"Paris: sunny, 21 C"`},
		{"E6", fxStrands, "tool-protobuf", "", true, `"toolUse"`, `{"city":"Paris"}`, `[{"text":"Paris: sunny, 21 C"}]`},
		{"E11", fxOpenAI, "tool-protobuf", "gpt-4o-mini", false, `ResponseFunctionToolCall`, `{"city":"Paris"}`, `"Paris: sunny, 21 C"`},
		{"E16", fxADK, "tool-protobuf", "openai/gpt-4o-mini", true, `"arguments":{"city":"Paris"}`, "", ""},
	}
	for _, tc := range cases {
		evs := Resolve(fixtureInput(t, tc.fw, tc.scenario, true))
		calls := ofType(evs, "post_call")
		for i, p := range calls {
			c, _ := p["content"].(map[string]any)
			if p["has_content"] != true || c == nil {
				t.Fatalf("%s call %d: no content", tc.e, i)
			}
			if c["provider"] != ContentProvider || !strings.HasPrefix(c["model"].(string), tc.model) {
				t.Errorf("%s call %d: provider %v model %v", tc.e, i, c["provider"], c["model"])
			}
			if (c["system"] != nil) != tc.system {
				t.Errorf("%s call %d: system %v", tc.e, i, c["system"])
			}
			if len(c["messages"].([]any)) == 0 {
				t.Errorf("%s call %d: no input messages", tc.e, i)
			}
		}
		if got := asJSON(t, calls[0]["content"].(map[string]any)["response"]); !strings.Contains(got, tc.firstResponse) {
			t.Errorf("%s first response %s lacks %s", tc.e, got, tc.firstResponse)
		}
		tool := ofType(evs, "tool_call")[0]
		if tc.toolInput == "" {
			// Google ADK records a tool's arguments and result only in the
			// next call's messages.
			if tool["content"] != nil {
				t.Errorf("%s tool content %v", tc.e, tool["content"])
			}
			continue
		}
		c := tool["content"].(map[string]any)
		if tool["has_content"] != true || c["provider"] != ContentProvider ||
			asJSON(t, c["tool_input"]) != tc.toolInput || asJSON(t, c["tool_output"]) != tc.toolOutput {
			t.Errorf("%s tool content = %v", tc.e, c)
		}
	}
}

// E16: Google ADK's content arrives on its log records, one before its
// call's span and one after, in requests of their own. Each call takes
// the content of the log record with its span id whichever arrived
// first, the order the records are loaded in changes nothing, and the
// log record's complete tool definitions win over the span's copy.
// Without its log record a call keeps its tokens and has no content.
func TestContentADKJoinsItsLogRecordEitherWay(t *testing.T) {
	traces := loadScenario(t, fxADK, "tool-protobuf")
	ft := traces[0]
	spanAt, logAt := map[[8]byte]int{}, map[[8]byte]int{}
	for i, f := range ft.facts {
		if f.Kind == otlpstage.KindLog {
			logAt[f.SpanID] = ft.arrived[i]
		} else {
			spanAt[f.SpanID] = ft.arrived[i]
		}
	}
	before, after := 0, 0
	for id, l := range logAt {
		switch {
		case l < spanAt[id]:
			before++
		case l > spanAt[id]:
			after++
		}
	}
	if before == 0 || after == 0 {
		t.Fatalf("the recording no longer holds a log record on each side of its span (%d before, %d after)", before, after)
	}

	in := inputOf(ft, true)
	evs := Resolve(in)
	reversed := in
	reversed.Facts = slices.Clone(in.Facts)
	slices.Reverse(reversed.Facts)
	if !reflect.DeepEqual(Resolve(reversed), evs) {
		t.Error("the order the records were loaded in changed the mapping")
	}
	for i, p := range ofType(evs, "post_call") {
		c, _ := p["content"].(map[string]any)
		if c == nil {
			t.Fatalf("call %d has no content", i)
		}
		if tools := asJSON(t, c["tools"]); !strings.Contains(tools, `"properties"`) {
			t.Errorf("call %d tools %s are the span's copy, not the log record's", i, tools)
		}
	}

	spansOnly := in
	spansOnly.Facts = nil
	for _, f := range in.Facts {
		if f.Kind == otlpstage.KindSpan {
			spansOnly.Facts = append(spansOnly.Facts, f)
		}
	}
	for _, p := range ofType(Resolve(spansOnly), "post_call") {
		if p["content"] != nil || p["tokens_input"].(int64) == 0 {
			t.Errorf("a call without its log record: content %v, tokens %v", p["content"], p["tokens_input"])
		}
	}
}

// A child agent's session_start carries what its parent asked it and its
// session_end what it answered, as the sensor carries a sub-agent's
// messages: its own input and output messages when its agent span has
// them (OpenAI Agents, Strands), else Pydantic AI's final_result, else
// the arguments and result of the tool span its parent ran it through.
// A root agent's own content has no destination and is not published.
func TestContentSubagentMessages(t *testing.T) {
	cases := []struct {
		e, fw    string
		incoming string // a fragment of the incoming body
		outgoing string
	}{
		{"E3", fxPydantic, `{"question":"What is the weather in Paris?"}`, `sunny`},
		{"E9", fxStrands, `"role":"user"`, `"role":"assistant"`},
		{"E14", fxOpenAI, `What's the weather like in Paris?`, `sunny`},
	}
	for _, tc := range cases {
		evs := Resolve(fixtureInput(t, tc.fw, "subagent-protobuf", true))
		for _, ev := range evs {
			p := ev.Payload
			child := p["parent_session_id"] != nil
			for _, field := range []string{"incoming_message", "outgoing_message"} {
				msg, has := p[field].(map[string]any)
				want := child && (field == "incoming_message" && ev.EventType == "session_start" ||
					field == "outgoing_message" && ev.EventType == "session_end")
				if has != want {
					t.Errorf("%s %s %s: %s present %v", tc.e, p["agent_name"], ev.EventType, field, has)
					continue
				}
				if !has {
					continue
				}
				frag := tc.incoming
				if field == "outgoing_message" {
					frag = tc.outgoing
				}
				if !strings.Contains(asJSON(t, msg["body"]), frag) || msg["captured_at"] != p["timestamp"] {
					t.Errorf("%s %s = %v, want a body with %s at %v", tc.e, field, msg, frag, p["timestamp"])
				}
			}
		}
	}
}

// A sub-agent message past the inline bound rides as the sensor's stub,
// its body in the event's content under the sub-agent provider.
func TestContentSubagentMessageOverflow(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent parent", opInvokeAgent, "parent", 100, nil)
	tool := s.span(&root, "execute_tool ask", opExecuteTool, "parent", 80, map[string]any{attrToolName: "ask"})
	child := s.span(&tool, "invoke_agent child", opInvokeAgent, "child", 50, nil)
	big := strings.Repeat("x", subagentInlineBytes+1)
	s.fact(child).Content = json.RawMessage(asJSON(t, map[string]any{contentFinal: big}))
	s.fact(tool).Content = json.RawMessage(`{"gen_ai.tool.call.arguments":{"q":"small"}}`)
	in := s.input(LabelPydanticAI, nil)
	in.Trace.Capture = true
	evs := Resolve(in)
	var start, end map[string]any
	for _, ev := range evs {
		if ev.Payload["agent_role"] == "child" {
			switch ev.EventType {
			case "session_start":
				start = ev.Payload
			case "session_end":
				end = ev.Payload
			}
		}
	}
	if in, _ := start["incoming_message"].(map[string]any); asJSON(t, in["body"]) != `{"q":"small"}` || start["has_content"] != false {
		t.Errorf("start = %v", start)
	}
	stub, _ := end["outgoing_message"].(map[string]any)
	if stub["has_content"] != true || stub["body"] != nil || stub["content_bytes"] != len(big)+2 {
		t.Errorf("stub = %v", stub)
	}
	c, _ := end["content"].(map[string]any)
	resp, _ := c["response"].(map[string]any)
	if end["has_content"] != true || c["provider"] != subagentProvider || resp["direction"] != "outgoing" || resp["body"] != big {
		t.Errorf("overflow content = %v", c)
	}
}

// A failed tool's and agent's error text is cut to maxToolErrorChars
// characters, at a character boundary.
func TestContentErrorTextIsCut(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 100, nil)
	tool := s.span(&root, "execute_tool t", opExecuteTool, "a", 50, map[string]any{attrToolName: "t", attrErrorType: "ValueError"})
	s.fact(tool).Status = statusError
	s.fact(root).Status = statusError
	long := strings.Repeat("é", maxToolErrorChars+50)
	s.fact(tool).Content = json.RawMessage(asJSON(t, map[string]any{contentError: long}))
	s.fact(root).Content = json.RawMessage(asJSON(t, map[string]any{contentError: long}))
	in := s.input(LabelPydanticAI, nil)
	in.Trace.Capture = true
	evs := Resolve(in)
	for _, msg := range []any{
		ofType(evs, "tool_call")[0]["error"].(map[string]any)["message"],
		ofType(evs, "session_end")[0]["error"].(map[string]any)["message"],
	} {
		m, _ := msg.(string)
		if utf8.RuneCountInString(m) != maxToolErrorChars || !utf8.ValidString(m) {
			t.Errorf("message of %d characters (valid %v)", utf8.RuneCountInString(m), utf8.ValidString(m))
		}
	}
}

// With the trace's posture off, staged content is never read, whatever
// the records hold: no event carries content or a sub-agent message, a
// failed tool's message is the placeholder and a failed agent's end has
// no message. The store stages none in that case; this is the mapping's
// own guard.
func TestContentIgnoredWithCaptureOff(t *testing.T) {
	for _, sc := range []struct{ fw, scenario string }{
		{fxPydantic, "tool-protobuf"}, {fxPydantic, "subagent-protobuf"}, {fxPydantic, "tool-error-protobuf"},
		{fxStrands, "tool-protobuf"}, {fxOpenAI, "subagent-protobuf"}, {fxADK, "tool-protobuf"}, {fxADK, "tool-error-protobuf"},
	} {
		in := fixtureInput(t, sc.fw, sc.scenario, true)
		staged := 0
		for _, f := range in.Facts {
			if f.Content != nil {
				staged++
			}
		}
		if staged == 0 {
			t.Fatalf("%s/%s stages no content to ignore", sc.fw, sc.scenario)
		}
		in.Trace.Capture = false
		evs := Resolve(in)
		if got := contentCarriers(evs); len(got) != 0 {
			t.Errorf("%s/%s: %s carries content with capture off", sc.fw, sc.scenario, got[0].EventType)
		}
		for _, ev := range evs {
			block, _ := ev.Payload["error"].(map[string]any)
			if block == nil {
				continue
			}
			msg, has := block["message"]
			if ev.EventType == "tool_call" && msg != redactedMessage || ev.EventType == "session_end" && has {
				t.Errorf("%s/%s: %s error message %v with capture off", sc.fw, sc.scenario, ev.EventType, msg)
			}
		}
	}
}
