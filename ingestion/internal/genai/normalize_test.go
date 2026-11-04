package genai

import (
	"encoding/binary"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
)

// ---- helpers shared by the fixture and synthetic tests ----

// ofType is the payloads of the events of one type, in publish order.
func ofType(evs []Event, eventType string) []map[string]any {
	var out []map[string]any
	for _, e := range evs {
		if e.EventType == eventType {
			out = append(out, e.Payload)
		}
	}
	return out
}

// startsByName is each session_start by agent_name.
func startsByName(t *testing.T, evs []Event) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, p := range ofType(evs, "session_start") {
		name := p["agent_name"].(string)
		if _, dup := out[name]; dup {
			t.Fatalf("two session_starts for %q", name)
		}
		out[name] = p
	}
	return out
}

// tokens is each post_call's [input, output] by agent_name, in order.
func tokens(evs []Event) map[string][][2]int64 {
	out := map[string][][2]int64{}
	for _, p := range ofType(evs, "post_call") {
		name := p["agent_name"].(string)
		out[name] = append(out[name], [2]int64{p["tokens_input"].(int64), p["tokens_output"].(int64)})
	}
	return out
}

func totalInput(evs []Event) int64 {
	var n int64
	for _, p := range ofType(evs, "post_call") {
		n += p["tokens_input"].(int64)
	}
	return n
}

// toolNames is each tool_call's tool name by agent_name, in order.
func toolNames(evs []Event) map[string][]string {
	out := map[string][]string{}
	for _, p := range ofType(evs, "tool_call") {
		name := p["agent_name"].(string)
		out[name] = append(out[name], p["tool_name"].(string))
	}
	return out
}

// ---- a synthetic trace builder ----

type synth struct {
	t       *testing.T
	scope   string
	version string
	facts   []otlpstage.StagedFact
	next    uint64
	clock   int64
}

// synthTraceID is the synthetic traces' id.
var synthTraceID = [16]byte{0xab, 0xcd, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14}

// synthEpoch is the synthetic traces' first span start.
var synthEpoch = time.Date(2026, 11, 4, 11, 0, 0, 0, time.UTC).UnixNano()

func newSynth(t *testing.T, scope string) *synth {
	return &synth{t: t, scope: scope, version: "1.0.0", clock: synthEpoch}
}

// span adds a span under parent (nil for a root) lasting ms, with the
// given op, agent name and extra attributes, and returns its id.
func (s *synth) span(parent *[8]byte, name, op, agent string, ms int64, attrs map[string]any) [8]byte {
	s.next++
	var id [8]byte
	binary.BigEndian.PutUint64(id[:], s.next)
	meta := map[string]any{}
	if op != "" {
		meta[attrOperation] = op
	}
	if agent != "" {
		meta[attrAgentName] = agent
	}
	for k, v := range attrs {
		meta[k] = v
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		s.t.Fatal(err)
	}
	f := otlpstage.Fact{
		SpanID: id, Kind: otlpstage.KindSpan, ScopeName: s.scope, ScopeVersion: s.version,
		Name: name, Op: op, AgentName: agent, StartNs: s.clock, EndNs: s.clock + ms*int64(time.Millisecond),
		Status: 1, Meta: raw,
	}
	if parent != nil {
		f.ParentSpanID = *parent
	}
	s.clock += int64(time.Millisecond)
	s.facts = append(s.facts, otlpstage.StagedFact{Fact: f})
	return id
}

func (s *synth) fact(id [8]byte) *otlpstage.StagedFact {
	for i := range s.facts {
		if s.facts[i].SpanID == id {
			return &s.facts[i]
		}
	}
	s.t.Fatalf("no span %x", id)
	return nil
}

func (s *synth) input(label string, resource map[string]string) Input {
	raw, _ := json.Marshal(resource)
	if resource == nil {
		raw = []byte("{}")
	}
	return Input{
		Trace: otlpstage.Trace{
			Key:             otlpstage.TraceKey{TokenKey: "tok-synth", TraceID: synthTraceID},
			Source:          label,
			SourceVersion:   s.version,
			Resource:        raw,
			Capture:         false,
			FirstReceivedAt: fixtureReceived,
		},
		Facts:  append([]otlpstage.StagedFact(nil), s.facts...),
		Reason: otlpstage.ReasonComplete,
	}
}

func usage(in, out int64) map[string]any {
	return map[string]any{attrInputTokens: in, attrOutputTokens: out}
}

// ---- E23: synthetic cases the recordings do not hold ----

// The three cache-read spellings are read in order, the first present
// wins and they are never summed; an input count smaller than the cache
// counts is taken to exclude them, which are then added.
func TestE23CacheSpellingsAndGuard(t *testing.T) {
	cases := []struct {
		name      string
		attrs     map[string]any
		wantInput int64
		wantRead  any
		excluded  bool
	}{
		{"latest spelling wins", map[string]any{attrCacheRead: 300, attrCacheReadDetails: 999, attrCacheReadLegacy: 777}, 1000, int64(300), false},
		{"details spelling", map[string]any{attrCacheReadDetails: 400}, 1000, int64(400), false},
		{"legacy spelling", map[string]any{attrCacheReadLegacy: 500}, 1000, int64(500), false},
		{"zero is still the first present", map[string]any{attrCacheRead: 0, attrCacheReadDetails: 999}, 1000, int64(0), false},
		{"no cache attribute: absent, not zero", map[string]any{}, 1000, nil, false},
		{"input excludes cache: added", map[string]any{attrCacheRead: 1500, attrCacheCreation: 200}, 1000 + 1500 + 200, int64(1500), true},
		{"input equal to cache: included", map[string]any{attrCacheRead: 600, attrCacheCreation: 400}, 1000, int64(600), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newSynth(t, "pydantic-ai")
			root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 100, nil)
			attrs := usage(1000, 10)
			for k, v := range tc.attrs {
				attrs[k] = v
			}
			s.span(&root, "chat m", opChat, "a", 50, attrs)
			calls := ofType(Resolve(s.input(LabelPydanticAI, nil)), "post_call")
			if len(calls) != 1 {
				t.Fatalf("%d post_calls, want 1", len(calls))
			}
			p := calls[0]
			if p["tokens_input"] != tc.wantInput || p["tokens_total"] != tc.wantInput+10 {
				t.Errorf("tokens_input = %v, total %v; want %d", p["tokens_input"], p["tokens_total"], tc.wantInput)
			}
			if got, ok := p["tokens_cache_read"]; tc.wantRead == nil && ok || tc.wantRead != nil && got != tc.wantRead {
				t.Errorf("tokens_cache_read = %v (present %v), want %v", got, ok, tc.wantRead)
			}
			meta, _ := p["provider_metadata"].(map[string]any)
			if got := meta["input_excluded_cache"] == true; got != tc.excluded {
				t.Errorf("input_excluded_cache = %v, want %v", got, tc.excluded)
			}
		})
	}
}

// A count that is not a non-negative whole number makes tokens_total -1,
// which validation refuses, rather than a guess.
func TestE23MalformedTokenCount(t *testing.T) {
	for _, bad := range []any{-5, "lots", 1.5} {
		s := newSynth(t, "pydantic-ai")
		root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 100, nil)
		s.span(&root, "chat m", opChat, "a", 50, map[string]any{attrInputTokens: bad, attrOutputTokens: 1})
		p := ofType(Resolve(s.input(LabelPydanticAI, nil)), "post_call")[0]
		if p["tokens_total"] != int64(-1) {
			t.Errorf("input %v: tokens_total = %v, want -1", bad, p["tokens_total"])
		}
	}
}

// An agent name past 256 bytes is cut at a UTF-8 boundary before the
// role, the agent name and the id are derived, so they agree.
func TestE23LongAgentName(t *testing.T) {
	long := strings.Repeat("é", 200) // 400 bytes
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent parent", opInvokeAgent, "parent", 100, nil)
	tool := s.span(&root, "execute_tool ask", opExecuteTool, "parent", 80, map[string]any{attrToolName: "ask"})
	s.span(&tool, "invoke_agent long", opInvokeAgent, long, 50, nil)
	evs := Resolve(s.input(LabelPydanticAI, nil))
	var child map[string]any
	for _, p := range ofType(evs, "session_start") {
		if p["agent_role"] != nil {
			child = p
		}
	}
	if child == nil {
		t.Fatal("no child session")
	}
	role := child["agent_role"].(string)
	if len(role) > maxIdentityBytes || !utf8.ValidString(role) || len(role) != 256 {
		t.Fatalf("role is %d bytes (valid %v), want 256 valid", len(role), utf8.ValidString(role))
	}
	wantID := identity.AgentID(defaultAgentType, unknownIdentity, unknownIdentity, ClientType, "pydantic_ai/parent", role)
	if child["agent_id"] != wantID {
		t.Errorf("agent_id = %v, want %v", child["agent_id"], wantID)
	}
	if child["agent_name"] != "pydantic_ai/parent/"+role {
		t.Errorf("agent_name = %v", child["agent_name"])
	}
}

// A call with no named agent among its ancestors goes to the trace's
// unattributed session, a root created only when needed, so no token is
// dropped.
func TestE23NoAgentAncestor(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	link := s.span(nil, "some workflow", "", "", 200, nil)
	s.span(&link, "chat m", opChat, "", 50, usage(10, 2))
	s.span(&link, "execute_tool t", opExecuteTool, "", 5, map[string]any{attrToolName: "t"})
	in := s.input(LabelPydanticAI, nil)
	evs := Resolve(in)
	starts := ofType(evs, "session_start")
	if len(starts) != 1 {
		t.Fatalf("%d sessions, want the unattributed one", len(starts))
	}
	st := starts[0]
	ctx := st["context"].(map[string]any)
	if ctx["otel_unattributed"] != true || st["agent_name"] != LabelPydanticAI || st["parent_session_id"] != nil {
		t.Errorf("unattributed session = %v", st)
	}
	frns := strconv.FormatInt(fixtureReceived.UnixNano(), 10)
	prefix := idPrefix + "tok-synth/" + hexID(synthTraceID[:])
	if want := identity.UUID5(identity.NamespaceFlightdeck, prefix+"/session/"+frns); st["session_id"] != want {
		t.Errorf("session id = %v, want uuid5 of %s/session/<first_received_at>", st["session_id"], prefix)
	}
	if want := identity.UUID5(identity.NamespaceFlightdeck, prefix+"/start/"+frns); st["id"] != want {
		t.Errorf("start id = %v, want %v", st["id"], want)
	}
	if len(ofType(evs, "post_call")) != 1 || len(ofType(evs, "tool_call")) != 1 {
		t.Errorf("calls and tools not kept: %v", evs)
	}
	// It starts at its earliest record and ends at its latest.
	end := ofType(evs, "session_end")[0]
	if st["timestamp"] != stamp(s.facts[1].StartNs) || end["timestamp"] != stamp(s.facts[1].EndNs) {
		t.Errorf("unattributed bounds = %v .. %v", st["timestamp"], end["timestamp"])
	}
	// No trace without such a call has one.
	s2 := newSynth(t, "pydantic-ai")
	r := s2.span(nil, "invoke_agent a", opInvokeAgent, "a", 100, nil)
	s2.span(&r, "chat m", opChat, "a", 50, usage(1, 1))
	for _, p := range ofType(Resolve(s2.input(LabelPydanticAI, nil)), "session_start") {
		if p["context"].(map[string]any)["otel_unattributed"] != nil {
			t.Error("an unattributed session was created without a call needing it")
		}
	}
}

// An invoke_agent span without a name (OpenAI Agents' workflow root) is
// not an agent: it only links, and a call under it alone is
// unattributed.
func TestE23UnnamedAgent(t *testing.T) {
	s := newSynth(t, "opentelemetry.instrumentation.openai_agents")
	root := s.span(nil, "Agent workflow", opInvokeAgent, "", 200, nil)
	blank := s.span(&root, "invoke_agent", opInvokeAgent, "   ", 150, nil)
	s.span(&blank, "chat", opChat, "OpenAI Agent", 50, usage(3, 4))
	evs := Resolve(s.input(LabelOpenAIAgents, nil))
	starts := ofType(evs, "session_start")
	if len(starts) != 1 || starts[0]["context"].(map[string]any)["otel_unattributed"] != true {
		t.Fatalf("sessions = %v, want only the unattributed one", starts)
	}
	// The call's own placeholder agent name is never read.
	if p := ofType(evs, "post_call")[0]; p["agent_name"] != LabelOpenAIAgents {
		t.Errorf("call filed under %v", p["agent_name"])
	}
}

// A model span wrapped in another recognised model span is counted
// once, as the outer call; a late outer span over a call an earlier
// assembly published publishes nothing.
func TestE23NestedAndLateModelAncestor(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 300, nil)
	outer := s.span(&root, "chat outer", opChat, "a", 100, usage(50, 5))
	s.span(&outer, "chat inner", opChat, "", 90, usage(50, 5))
	calls := ofType(Resolve(s.input(LabelPydanticAI, nil)), "post_call")
	if len(calls) != 1 || calls[0]["id"] != identity.UUID5(identity.NamespaceFlightdeck,
		idPrefix+"tok-synth/"+hexID(synthTraceID[:])+"/event/"+hexID(outer[:])) {
		t.Fatalf("post_calls = %v, want the outer call only", calls)
	}

	// The inner span was assembled before its outer one arrived (it was
	// then the outermost); the late outer span must not count it again.
	s.fact(outer).Assembled = false
	inner := s.facts[2].SpanID
	s.fact(inner).Assembled = true
	s.fact(root).Assembled = true
	in := s.input(LabelPydanticAI, nil)
	in.Trace.AssemblyCount = 1
	if evs := Resolve(in); len(evs) != 0 {
		t.Errorf("late outer model span published %d events, want none", len(evs))
	}
}

// A span of a scope the table does not name only links, whatever its
// operation: a provider SDK's chat span directly under an agent is not a
// call, and its named invoke_agent is not an agent. (In the recordings
// such spans sit under a framework model span, which would also drop
// them, so this case isolates the scope rule.)
func TestE23ForeignScopeOnlyLinks(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 300, nil)
	s.scope = "com.anthropic.sdk.python"
	s.span(&root, "anthropic.messages.create", opChat, "", 100, usage(500, 50))
	s.span(&root, "invoke_agent other", opInvokeAgent, "other", 50, nil)
	evs := Resolve(s.input(LabelPydanticAI, nil))
	if n := len(ofType(evs, "post_call")); n != 0 {
		t.Errorf("%d post_calls from a foreign scope", n)
	}
	if n := len(ofType(evs, "session_start")); n != 1 {
		t.Errorf("%d sessions, want only the framework's agent", n)
	}
}

// Agents named alike in different frameworks (and so flavors) are
// different agents.
func TestE23CrossFrameworkAgentsStayApart(t *testing.T) {
	ids := map[string]string{}
	for _, tc := range []struct{ scope, label string }{
		{"pydantic-ai", LabelPydanticAI},
		{"strands.telemetry.tracer", LabelStrands},
		{"gcp.vertex.agent", LabelGoogleADK},
	} {
		s := newSynth(t, tc.scope)
		r := s.span(nil, "invoke_agent assistant", opInvokeAgent, "assistant", 100, nil)
		s.span(&r, "chat", opChat, "", 10, usage(1, 1))
		resource := map[string]string{}
		if tc.label == LabelStrands {
			resource[attrServiceName] = strandsServiceName // names the framework, not the app
		}
		st := ofType(Resolve(s.input(tc.label, resource)), "session_start")[0]
		if st["agent_name"] != tc.label+"/assistant" {
			t.Errorf("%s agent_name = %v", tc.label, st["agent_name"])
		}
		ids[tc.label] = st["agent_id"].(string)
	}
	if ids[LabelPydanticAI] == ids[LabelStrands] || ids[LabelStrands] == ids[LabelGoogleADK] || ids[LabelPydanticAI] == ids[LabelGoogleADK] {
		t.Errorf("assistant agents merged across frameworks: %v", ids)
	}
}

// The identity resource sets flavor, agent type, user, host and billing.
func TestE23IdentityFromResource(t *testing.T) {
	mk := func(resource map[string]string) map[string]any {
		s := newSynth(t, "pydantic-ai")
		r := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 100, nil)
		s.span(&r, "chat", opChat, "", 10, usage(1, 1))
		return ofType(Resolve(s.input(LabelPydanticAI, resource)), "post_call")[0]
	}
	p := mk(map[string]string{
		attrFlavor: "billing-app", attrAgentType: "coding", attrUserID: "u-1", attrUserName: "ignored",
		attrHostName: "box-1", attrBillingMode: "subscription", attrServiceName: "svc",
	})
	want := map[string]any{
		"flavor": "billing-app", "agent_type": "coding", "user": "u-1", "host": "box-1", "hostname": "box-1",
		"billing_mode": "subscription", "agent_name": "billing-app/a", "client_type": "otlp", "framework": LabelPydanticAI,
		"agent_id": identity.AgentID("coding", "u-1", "box-1", "otlp", "billing-app/a", ""),
	}
	for k, v := range want {
		if p[k] != v {
			t.Errorf("%s = %v, want %v", k, p[k], v)
		}
	}
	// service.name names the app when it is meaningful; an invalid agent
	// type falls back to production; user.name stands in for user.id.
	p = mk(map[string]string{attrServiceName: "weather-svc", attrAgentType: "autonomous", attrUserName: "ann"})
	if p["flavor"] != "weather-svc" || p["agent_type"] != "production" || p["user"] != "ann" || p["host"] != "unknown" {
		t.Errorf("fallbacks: %v %v %v %v", p["flavor"], p["agent_type"], p["user"], p["host"])
	}
	if _, ok := p["billing_mode"]; ok {
		t.Error("billing_mode set without flightdeck.billing_mode")
	}
	for _, svc := range []string{"unknown_service:python", "unknown_service", strandsServiceName, ""} {
		if p := mk(map[string]string{attrServiceName: svc}); p["flavor"] != LabelPydanticAI {
			t.Errorf("service.name %q gave flavor %v, want the framework label", svc, p["flavor"])
		}
	}
}

// A late call on a session an earlier assembly closed is wrapped in a
// re-attaching start, dated just before it, and an end at the session's
// original end, with ids of their own; the earlier events are not
// published again.
func TestE23LateRecordReattaches(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 1000, nil)
	s.span(&root, "chat 1", opChat, "a", 100, usage(10, 1))
	for i := range s.facts {
		s.facts[i].Assembled = true
	}
	late := s.span(&root, "execute_tool t", opExecuteTool, "a", 10, map[string]any{attrToolName: "t"})
	in := s.input(LabelPydanticAI, nil)
	in.Trace.AssemblyCount = 2
	evs := Resolve(in)
	if len(evs) != 3 || evs[0].EventType != "session_start" || evs[1].EventType != "tool_call" || evs[2].EventType != "session_end" {
		t.Fatalf("late assembly = %v", evs)
	}
	if !evs[0].Attach || evs[2].Attach {
		t.Error("the start must re-attach")
	}
	lateFact := s.fact(late)
	if evs[0].Payload["timestamp"] != stamp(lateFact.EndNs-int64(attachLead)) {
		t.Errorf("re-attach dated %v, want 1us before %v", evs[0].Payload["timestamp"], stamp(lateFact.EndNs))
	}
	if evs[2].Payload["timestamp"] != stamp(s.fact(root).EndNs) {
		t.Errorf("end dated %v, want the original end", evs[2].Payload["timestamp"])
	}
	frns := strconv.FormatInt(fixtureReceived.UnixNano(), 10)
	prefix := idPrefix + "tok-synth/" + hexID(synthTraceID[:])
	if want := identity.UUID5(identity.NamespaceFlightdeck, prefix+"/start/"+hexID(root[:])+"/"+frns+"/2"); evs[0].Payload["id"] != want {
		t.Errorf("re-attach id = %v, want %v", evs[0].Payload["id"], want)
	}
	if want := identity.UUID5(identity.NamespaceFlightdeck, prefix+"/end/"+hexID(root[:])+"/"+frns+"/2"); evs[2].Payload["id"] != want {
		t.Errorf("re-attach end id = %v", evs[2].Payload["id"])
	}

	// An original end outside the validation window is moved to just
	// after the latest event it closes.
	in.ValidFrom = time.Unix(0, s.fact(root).EndNs+1)
	evs = Resolve(in)
	if evs[2].Payload["timestamp"] != stamp(lateFact.EndNs+int64(attachLead)) {
		t.Errorf("end outside the window dated %v", evs[2].Payload["timestamp"])
	}

	// A session with nothing new publishes nothing.
	s.fact(late).Assembled = true
	if evs := Resolve(s.input(LabelPydanticAI, nil)); len(evs) != 0 {
		t.Errorf("a fully assembled trace published %v", evs)
	}
}

// A late ancestor agent cannot turn an agent an earlier assembly
// published as a root into a child: a quiet assembly made the agent a
// root because its parent had not arrived, and when the parent arrives
// with a late record of the agent's, the re-attach keeps the agent's
// name and id and gives it no parent; the parent is a root of its own
// and keeps its own calls.
func TestE23LateAncestorKeepsIdentity(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	parent := s.span(nil, "invoke_agent outer", opInvokeAgent, "outer", 2000, nil)
	tool := s.span(&parent, "execute_tool ask", opExecuteTool, "outer", 1500, map[string]any{attrToolName: "ask"})
	inner := s.span(&tool, "invoke_agent inner", opInvokeAgent, "inner", 1000, nil)
	s.span(&inner, "chat 1", opChat, "inner", 100, usage(10, 1))
	outerCall := s.span(&parent, "chat outer", opChat, "outer", 100, usage(20, 2))

	// The first assembly saw only the inner agent and its call.
	first := s.input(LabelPydanticAI, nil)
	first.Reason = otlpstage.ReasonQuiet
	first.Facts = []otlpstage.StagedFact{*s.fact(inner), s.facts[3]}
	early := startsByName(t, Resolve(first))
	was, ok := early["pydantic_ai/inner"]
	if !ok || was["parent_session_id"] != nil {
		t.Fatalf("first assembly sessions = %v", keys(early))
	}

	// The parent, its tool and call arrive late, with a late tool call
	// of the inner agent's.
	s.fact(inner).Assembled, s.fact(inner).AssembledIn = true, 1
	s.facts[3].Assembled, s.facts[3].AssembledIn = true, 1
	s.span(&inner, "execute_tool late", opExecuteTool, "inner", 5, map[string]any{attrToolName: "late"})
	in := s.input(LabelPydanticAI, nil)
	in.Trace.AssemblyCount = 1
	evs := Resolve(in)
	checkSequence(t, evs)
	var reattach map[string]any
	for _, ev := range evs {
		if ev.EventType == "session_start" && ev.Attach {
			reattach = ev.Payload
		}
	}
	if reattach == nil {
		t.Fatal("the inner agent was not re-attached")
	}
	if reattach["agent_name"] != was["agent_name"] || reattach["agent_id"] != was["agent_id"] || reattach["session_id"] != was["session_id"] {
		t.Errorf("re-attach identity %v / %v, want %v / %v", reattach["agent_name"], reattach["agent_id"], was["agent_name"], was["agent_id"])
	}
	if _, has := reattach["parent_session_id"]; has {
		t.Errorf("re-attach gained a parent: %v", reattach["parent_session_id"])
	}
	for _, ev := range evs {
		if ev.SessionID == was["session_id"] && (ev.Payload["parent_session_id"] != nil || ev.Payload["agent_role"] != nil) {
			t.Errorf("late %s of the inner agent carries a parent or role", ev.EventType)
		}
	}
	late := startsByName(t, evs)
	outer := late["pydantic_ai/outer"]
	if outer == nil || outer["parent_session_id"] != nil {
		t.Fatalf("late parent = %v, want a root", outer)
	}
	for _, p := range ofType(evs, "post_call") {
		if p["id"] == identity.UUID5(identity.NamespaceFlightdeck, idPrefix+"tok-synth/"+hexID(synthTraceID[:])+"/event/"+hexID(outerCall[:])) &&
			p["session_id"] != outer["session_id"] {
			t.Error("the late parent's call is not on its session")
		}
	}
	if n := len(ofType(evs, "tool_call")); n != 2 {
		t.Errorf("%d tool calls, want the parent's and the late one", n)
	}
}

// The third assembly after a late ancestor: the agent was published as a
// root in assembly 1, its late parent was assembled in assembly 2, and a
// late record of the agent's arrives for assembly 3. The parent was
// assembled after the agent, so the agent still keeps the identity it
// was published with, and the parent stays a root.
func TestE23ThirdAssemblyKeepsIdentity(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	parent := s.span(nil, "invoke_agent outer", opInvokeAgent, "outer", 2000, nil)
	tool := s.span(&parent, "execute_tool ask", opExecuteTool, "outer", 1500, map[string]any{attrToolName: "ask"})
	inner := s.span(&tool, "invoke_agent inner", opInvokeAgent, "inner", 1000, nil)
	s.fact(inner).Assembled, s.fact(inner).AssembledIn = true, 1
	s.fact(parent).Assembled, s.fact(parent).AssembledIn = true, 2
	s.fact(tool).Assembled, s.fact(tool).AssembledIn = true, 2
	s.span(&inner, "execute_tool late", opExecuteTool, "inner", 5, map[string]any{attrToolName: "late"})
	in := s.input(LabelPydanticAI, nil)
	in.Trace.AssemblyCount = 2
	evs := Resolve(in)
	checkSequence(t, evs)
	starts := ofType(evs, "session_start")
	if len(starts) != 1 {
		t.Fatalf("%d starts, want only the inner agent's re-attach", len(starts))
	}
	st := starts[0]
	if st["agent_name"] != "pydantic_ai/inner" || st["parent_session_id"] != nil || st["agent_role"] != nil ||
		st["agent_id"] != identity.AgentID(defaultAgentType, unknownIdentity, unknownIdentity, ClientType, "pydantic_ai/inner", "") {
		t.Errorf("third assembly re-parented the agent: %v", st)
	}
	for _, ev := range evs {
		if ev.Payload["parent_session_id"] != nil {
			t.Errorf("%s carries a parent", ev.EventType)
		}
	}
}

// An agent assembled together with its parent keeps that parent in a
// later assembly: the rule drops only ancestors assembled after it.
func TestE23LaterAssemblyKeepsAParentAssembledWithIt(t *testing.T) {
	for _, parentIn := range []int{1, 2} { // before the child, or with it
		s := newSynth(t, "pydantic-ai")
		parent := s.span(nil, "invoke_agent outer", opInvokeAgent, "outer", 2000, nil)
		tool := s.span(&parent, "execute_tool ask", opExecuteTool, "outer", 1500, map[string]any{attrToolName: "ask"})
		inner := s.span(&tool, "invoke_agent inner", opInvokeAgent, "inner", 1000, nil)
		s.fact(parent).Assembled, s.fact(parent).AssembledIn = true, parentIn
		s.fact(tool).Assembled, s.fact(tool).AssembledIn = true, parentIn
		s.fact(inner).Assembled, s.fact(inner).AssembledIn = true, 2
		s.span(&inner, "execute_tool late", opExecuteTool, "inner", 5, map[string]any{attrToolName: "late"})
		in := s.input(LabelPydanticAI, nil)
		in.Trace.AssemblyCount = 2
		starts := ofType(Resolve(in), "session_start")
		if len(starts) != 1 || starts[0]["agent_name"] != "pydantic_ai/outer/inner" || starts[0]["parent_session_id"] == nil {
			t.Errorf("parent assembled in %d, child in 2: starts = %v, want the child under its parent", parentIn, starts)
		}
	}
}

// A failed call whose framework retried it reports every attempt at the
// outermost level with usage, summed, each once; usage deeper under an
// attempt is not added again.
func TestE23FailedCallSumsAttempts(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 900, nil)
	outer := s.span(&root, "chat outer", opChat, "a", 800, nil)
	s.fact(outer).Status = statusError
	s.scope = "com.anthropic.sdk.python"
	first := s.span(&outer, "attempt 1", opChat, "", 200, usage(100, 0))
	s.span(&outer, "attempt 2", opChat, "", 200, map[string]any{attrInputTokens: 120})
	s.span(&outer, "attempt 3", opChat, "", 200, nil)
	s.span(&first, "nested", opChat, "", 100, usage(100, 0))
	block := ofType(Resolve(s.input(LabelPydanticAI, nil)), "llm_error")[0]["error"].(map[string]any)
	if block["partial_tokens_input"] != int64(220) || block["partial_tokens_output"] != int64(0) {
		t.Errorf("partial counts = %v / %v, want 220 / 0", block["partial_tokens_input"], block["partial_tokens_output"])
	}
}

// A failed model call that carries usage reports it once, in the
// error object as a failed stream's partial counts, with no top-level
// counts and with billing_mode when the resource declares it; a count
// that is absent or malformed is left out, never 0.
func TestE23FailedCallReportsUsage(t *testing.T) {
	cases := []struct {
		name    string
		attrs   map[string]any
		in, out any
	}{
		{"both counts", usage(120, 7), int64(120), int64(7)},
		{"input only", map[string]any{attrInputTokens: 120}, int64(120), nil},
		{"malformed output", map[string]any{attrInputTokens: 120, attrOutputTokens: "many"}, int64(120), nil},
		{"no usage", map[string]any{}, nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newSynth(t, "pydantic-ai")
			root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 300, nil)
			attrs := map[string]any{attrExceptionType: "openai.RateLimitError"}
			for k, v := range tc.attrs {
				attrs[k] = v
			}
			call := s.span(&root, "chat m", opChat, "a", 100, attrs)
			s.fact(call).Status = statusError
			evs := Resolve(s.input(LabelPydanticAI, map[string]string{attrBillingMode: "subscription"}))
			if n := len(ofType(evs, "post_call")); n != 0 {
				t.Fatalf("%d post_calls", n)
			}
			p := ofType(evs, "llm_error")[0]
			for _, k := range []string{"tokens_input", "tokens_output", "tokens_total"} {
				if _, has := p[k]; has {
					t.Errorf("top-level %s set", k)
				}
			}
			block := p["error"].(map[string]any)
			if got, has := block["partial_tokens_input"]; tc.in == nil && has || tc.in != nil && got != tc.in {
				t.Errorf("partial_tokens_input = %v (present %v), want %v", got, has, tc.in)
			}
			if got, has := block["partial_tokens_output"]; tc.out == nil && has || tc.out != nil && got != tc.out {
				t.Errorf("partial_tokens_output = %v (present %v), want %v", got, has, tc.out)
			}
			if p["billing_mode"] != "subscription" || block["error_type"] != "rate_limit" || block["is_retryable"] != true {
				t.Errorf("llm_error = %v", p)
			}
		})
	}
	// No billing_mode without the resource attribute.
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 300, nil)
	call := s.span(&root, "chat m", opChat, "a", 100, usage(1, 1))
	s.fact(call).Status = statusError
	if p := ofType(Resolve(s.input(LabelPydanticAI, nil)), "llm_error")[0]; p["billing_mode"] != nil {
		t.Errorf("billing_mode = %v without the resource attribute", p["billing_mode"])
	}
}

// failedOverUsage builds an agent whose framework model span failed
// without usage over model spans below it that carry usage: a recognised
// one under a link span, and a provider SDK one deeper still. It returns
// the builder.
func failedOverUsage(t *testing.T) *synth {
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 500, nil)
	outer := s.span(&root, "chat outer", opChat, "a", 400, map[string]any{attrExceptionType: "pydantic_ai.exceptions.ModelHTTPError"})
	s.fact(outer).Status = statusError
	link := s.span(&outer, "retry", "", "", 300, nil)
	mid := s.span(&link, "chat mid", opChat, "", 200, usage(900, 40))
	s.scope = "com.anthropic.sdk.python"
	s.span(&mid, "anthropic.messages.create", opChat, "", 100, usage(5, 5))
	return s
}

// An outer model span that fails without usage over a model span that
// reported it carries the usage of the outermost span below it with
// usage, and the tokens are reported by that llm_error alone.
func TestE23FailedOuterCallTakesInnerUsage(t *testing.T) {
	evs := Resolve(failedOverUsage(t).input(LabelPydanticAI, nil))
	if n := len(ofType(evs, "post_call")); n != 0 {
		t.Fatalf("%d post_calls: the inner usage would be counted twice", n)
	}
	errs := ofType(evs, "llm_error")
	if len(errs) != 1 {
		t.Fatalf("%d llm_errors", len(errs))
	}
	block := errs[0]["error"].(map[string]any)
	if block["partial_tokens_input"] != int64(900) || block["partial_tokens_output"] != int64(40) {
		t.Errorf("partial counts = %v / %v, want the outermost span with usage (900 / 40)", block["partial_tokens_input"], block["partial_tokens_output"])
	}
	// A child agent's usage below a failed call is never borrowed.
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 500, nil)
	outer := s.span(&root, "chat outer", opChat, "a", 400, nil)
	s.fact(outer).Status = statusError
	child := s.span(&outer, "invoke_agent b", opInvokeAgent, "b", 300, nil)
	s.span(&child, "chat b", opChat, "b", 100, usage(30, 3))
	evs = Resolve(s.input(LabelPydanticAI, nil))
	if block := ofType(evs, "llm_error")[0]["error"].(map[string]any); block["partial_tokens_input"] != nil {
		t.Errorf("borrowed a child agent's usage: %v", block)
	}
	if n := len(ofType(evs, "post_call")); n != 1 {
		t.Errorf("the child's call: %d post_calls, want 1", n)
	}
}

// A failed agent span ends its session in error: with its class when the
// framework records an exception (Strands), and without an error block
// when it records none (OpenAI Agents).
func TestE23FailedAgentSpans(t *testing.T) {
	for _, tc := range []struct {
		scope, label, class string
	}{
		{"strands.telemetry.tracer", LabelStrands, "openai.NotFoundError"},
		{"opentelemetry.instrumentation.openai_agents", LabelOpenAIAgents, ""},
	} {
		s := newSynth(t, tc.scope)
		attrs := map[string]any{}
		if tc.class != "" {
			attrs[attrExceptionType] = tc.class
		}
		root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 300, attrs)
		s.fact(root).Status = statusError
		s.span(&root, "chat", opChat, "", 100, usage(1, 1))
		end := ofType(Resolve(s.input(tc.label, nil)), "session_end")[0]
		if end["state"] != "error" || end["close_reason"] != "normal_exit" {
			t.Errorf("%s end = %v", tc.label, end)
		}
		block, has := end["error"].(map[string]any)
		if tc.class == "" && has || tc.class != "" && block["error_class"] != tc.class {
			t.Errorf("%s error = %v", tc.label, end["error"])
		}
	}
}

// An error class past 256 bytes is cut at a UTF-8 boundary on a tool's
// error block, a session's and an llm_error's message.
func TestE23LongErrorClass(t *testing.T) {
	long := strings.Repeat("ü", 300) + "Error"
	s := newSynth(t, "pydantic-ai")
	root := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 300, map[string]any{attrErrorType: long})
	s.fact(root).Status = statusError
	call := s.span(&root, "chat", opChat, "a", 100, map[string]any{attrErrorType: long})
	s.fact(call).Status = statusError
	tool := s.span(&root, "execute_tool t", opExecuteTool, "a", 10, map[string]any{attrToolName: "t", attrErrorType: long})
	s.fact(tool).Status = statusError
	evs := Resolve(s.input(LabelPydanticAI, nil))
	for name, v := range map[string]any{
		"tool error_class":    ofType(evs, "tool_call")[0]["error"].(map[string]any)["error_class"],
		"session error_class": ofType(evs, "session_end")[0]["error"].(map[string]any)["error_class"],
		"llm_error message":   ofType(evs, "llm_error")[0]["error"].(map[string]any)["error_message"],
	} {
		str, _ := v.(string)
		if len(str) > maxErrorClassBytes || len(str) < maxErrorClassBytes-1 || !utf8.ValidString(str) {
			t.Errorf("%s is %d bytes (valid %v)", name, len(str), utf8.ValidString(str))
		}
	}
}

// Depth 2: a grandchild's parent is its nearest agent, through any link
// spans; its agent_name and id derive from the top-most agent's name and
// its own role, as every child's do.
func TestE23DepthTwo(t *testing.T) {
	s := newSynth(t, "gcp.vertex.agent")
	wf := s.span(nil, "invoke_workflow", "invoke_workflow", "", 500, nil)
	a := s.span(&wf, "invoke_agent a", opInvokeAgent, "a", 400, nil)
	t1 := s.span(&a, "execute_tool b", opExecuteTool, "a", 300, map[string]any{attrToolName: "b"})
	nw := s.span(&t1, "invoke_workflow b", "invoke_workflow", "", 290, nil)
	b := s.span(&nw, "invoke_agent b", opInvokeAgent, "b", 280, nil)
	t2 := s.span(&b, "execute_tool c", opExecuteTool, "b", 200, map[string]any{attrToolName: "c"})
	c := s.span(&t2, "invoke_agent c", opInvokeAgent, "c", 100, nil)
	s.span(&c, "generate_content", opGenerateContent, "c", 50, usage(5, 1))
	evs := Resolve(s.input(LabelGoogleADK, nil))
	names := startsByName(t, evs)
	gc := names["google_adk/a/c"]
	if gc == nil {
		t.Fatalf("sessions = %v", keys(names))
	}
	if gc["parent_session_id"] != names["google_adk/a/b"]["session_id"] ||
		names["google_adk/a/b"]["parent_session_id"] != names["google_adk/a"]["session_id"] {
		t.Error("depth-2 parents wrong")
	}
	if gc["agent_id"] != identity.AgentID(defaultAgentType, unknownIdentity, unknownIdentity, ClientType, "google_adk/a", "c") {
		t.Error("grandchild id not derived from the root's name and its role")
	}
	if p := ofType(evs, "post_call")[0]; p["agent_name"] != "google_adk/a/c" || p["parent_session_id"] != names["google_adk/a/b"]["session_id"] {
		t.Errorf("call on %v", p["agent_name"])
	}
	checkSequence(t, evs)
}

// A malformed trace whose parent ids loop still maps, and every walk up
// a chain ends.
func TestE23ParentLoop(t *testing.T) {
	s := newSynth(t, "pydantic-ai")
	a := s.span(nil, "invoke_agent a", opInvokeAgent, "a", 100, nil)
	b := s.span(&a, "invoke_agent b", opInvokeAgent, "b", 50, nil)
	s.fact(a).ParentSpanID = b
	s.span(&b, "chat", opChat, "", 10, usage(1, 1))
	evs := Resolve(s.input(LabelPydanticAI, nil))
	if len(ofType(evs, "session_start")) != 2 || len(ofType(evs, "post_call")) != 1 {
		t.Errorf("loop trace mapped to %v", evs)
	}
}

// The mapping depends only on the set of staged records, never on their
// order, and maps the same trace to the same events every time.
func TestE23Deterministic(t *testing.T) {
	in := fixtureInput(t, fxPydantic, "subagent-protobuf", true)
	want := Resolve(in)
	rev := in
	rev.Facts = append([]otlpstage.StagedFact(nil), in.Facts...)
	for i, j := 0, len(rev.Facts)-1; i < j; i, j = i+1, j-1 {
		rev.Facts[i], rev.Facts[j] = rev.Facts[j], rev.Facts[i]
	}
	if got := Resolve(rev); !reflect.DeepEqual(got, want) {
		t.Error("reordered facts mapped differently")
	}
}
