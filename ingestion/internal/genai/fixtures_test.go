package genai

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// fixtureRoot is the recorded OTLP requests, relative to this package.
const fixtureRoot = "../../../tests/fixtures/otlp"

// The framework recordings, by directory.
const (
	fxPydantic = "pydantic-ai-2.64.0"
	fxStrands  = "strands-agents-1.63.0"
	fxOpenAI   = "openai-agents-0.24.0"
	fxADK      = "google-adk-2.13.0"
)

// fixtureToken is the token key the fixture traces are staged under.
const fixtureToken = "tok-fixture"

// fixtureReceived is the first_received_at of every fixture trace row:
// a fixed time, with the microsecond precision the column stores.
var fixtureReceived = time.Date(2026, 11, 4, 12, 0, 0, 123456000, time.UTC)

type manifest struct {
	Requests []struct {
		File string `json:"file"`
		Path string `json:"path"`
	} `json:"requests"`
}

// fixtureTrace is one trace of a recorded scenario, as the staging store
// would hold it, with the request index each record arrived in.
type fixtureTrace struct {
	row     otlpstage.Trace
	facts   []otlpstage.StagedFact
	arrived []int // request index per fact
}

// loadScenario stages a recorded scenario's records the way the receiver
// does: every scope of a resource that carries a recognised scope, ADK's
// details log records, nothing else. It returns the scenario's traces in
// order of first record.
func loadScenario(t *testing.T, framework, scenario string) []*fixtureTrace {
	t.Helper()
	dir := filepath.Join(fixtureRoot, framework, scenario)
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	byTrace := map[[16]byte]*fixtureTrace{}
	var order []*fixtureTrace
	seen := map[[16]byte]map[otlpstage.FactKey]bool{}
	add := func(idx int, trace [16]byte, src Source, scope *commonpb.InstrumentationScope, res []*commonpb.KeyValue, f otlpstage.Fact) {
		ft := byTrace[trace]
		if ft == nil {
			ft = &fixtureTrace{row: otlpstage.Trace{
				Key:             otlpstage.TraceKey{TokenKey: fixtureToken, TraceID: trace},
				Source:          src.Label,
				SourceVersion:   src.Version(scope.GetVersion(), res),
				Resource:        IdentityResource(res),
				FirstReceivedAt: fixtureReceived,
			}}
			byTrace[trace] = ft
			order = append(order, ft)
			seen[trace] = map[otlpstage.FactKey]bool{}
		}
		if seen[trace][f.Key()] {
			return
		}
		seen[trace][f.Key()] = true
		ft.facts = append(ft.facts, otlpstage.StagedFact{Fact: f})
		ft.arrived = append(ft.arrived, idx)
	}
	for idx, r := range m.Requests {
		body, err := os.ReadFile(filepath.Join(dir, r.File))
		if err != nil {
			t.Fatalf("read %s: %v", r.File, err)
		}
		switch r.Path {
		case "/v1/traces":
			var req coltrace.ExportTraceServiceRequest
			decodeFixture(t, r.File, body, &req)
			for _, rs := range req.GetResourceSpans() {
				var scopes []*commonpb.InstrumentationScope
				for _, ss := range rs.GetScopeSpans() {
					scopes = append(scopes, ss.GetScope())
				}
				src, recognised, ok := Recognize(scopes)
				if !ok {
					continue
				}
				res := rs.GetResource().GetAttributes()
				for _, ss := range rs.GetScopeSpans() {
					for _, sp := range ss.GetSpans() {
						trace, f, err := SpanFact(ss.GetScope(), sp)
						if err != nil {
							t.Fatalf("%s: %v", r.File, err)
						}
						add(idx, trace, src, recognised, res, f)
					}
				}
			}
		case "/v1/logs":
			var req collogs.ExportLogsServiceRequest
			decodeFixture(t, r.File, body, &req)
			for _, rl := range req.GetResourceLogs() {
				res := rl.GetResource().GetAttributes()
				for _, sl := range rl.GetScopeLogs() {
					src, ok := SourceForScope(sl.GetScope().GetName())
					if !ok || src.Label != LabelGoogleADK {
						continue
					}
					for _, lr := range sl.GetLogRecords() {
						if !IsADKDetails(lr) {
							continue
						}
						trace, f, err := LogFact(sl.GetScope(), lr)
						if err != nil {
							t.Fatalf("%s: %v", r.File, err)
						}
						add(idx, trace, src, sl.GetScope(), res, f)
					}
				}
			}
		}
	}
	return order
}

// decodeFixture decodes a recorded request: protobuf as is, OTLP JSON
// with its hex ids turned into the base64 protojson reads.
func decodeFixture(t *testing.T, name string, body []byte, msg proto.Message) {
	t.Helper()
	if strings.HasSuffix(name, ".pb") {
		if err := proto.Unmarshal(body, msg); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		return
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	hexToBase64(tree)
	converted, err := json.Marshal(tree)
	if err != nil {
		t.Fatalf("encode %s: %v", name, err)
	}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(converted, msg); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
}

func hexToBase64(v any) {
	switch x := v.(type) {
	case map[string]any:
		for k, item := range x {
			if s, ok := item.(string); ok && (k == "traceId" || k == "spanId" || k == "parentSpanId") {
				if b, err := hex.DecodeString(s); err == nil {
					x[k] = base64.StdEncoding.EncodeToString(b)
				}
				continue
			}
			hexToBase64(item)
		}
	case []any:
		for _, item := range x {
			hexToBase64(item)
		}
	}
}

// fixtureInput is the whole of a scenario's single trace, assembled once
// as complete with capture as given.
func fixtureInput(t *testing.T, framework, scenario string, capture bool) Input {
	t.Helper()
	traces := loadScenario(t, framework, scenario)
	if len(traces) != 1 {
		t.Fatalf("%s/%s: %d traces, want 1", framework, scenario, len(traces))
	}
	return inputOf(traces[0], capture)
}

func inputOf(ft *fixtureTrace, capture bool) Input {
	row := ft.row
	row.Capture = capture
	facts := append([]otlpstage.StagedFact(nil), ft.facts...)
	return Input{
		Trace:  row,
		Facts:  facts,
		Reason: otlpstage.ReasonComplete,
	}
}

// ---- E1-E20: the recorded scenarios ----
//
// One E-number per recorded agent-framework scenario, framework by
// framework (E11 covers OpenAI Agents' protobuf and JSON tool runs,
// which are the same run over two encodings). The cache and
// model-error recordings follow them.

// fixtureWant is what a scenario's one trace maps to.
type fixtureWant struct {
	e, fw, scenario string
	capture         bool
	// sessions maps each session's agent_name to its parent's ("" for a
	// root).
	sessions map[string]string
	// calls is each session's post_call [input, output] tokens in order.
	calls map[string][][2]int64
	// tools is each session's tool_call names in order.
	tools map[string][]string
	// provider is every post_call's provider; "" means none is sent.
	provider   string
	totalInput int64
	version    string
}

var fixtureWants = []fixtureWant{
	{e: "E1", fw: fxPydantic, scenario: "tool-protobuf", capture: true,
		sessions: map[string]string{"pydantic_ai/weather_agent": ""},
		calls:    map[string][][2]int64{"pydantic_ai/weather_agent": {{658, 54}, {732, 18}}},
		tools:    map[string][]string{"pydantic_ai/weather_agent": {"get_weather"}},
		provider: "anthropic", totalInput: 1390, version: "2.64.0"},
	{e: "E2", fw: fxPydantic, scenario: "tool-json", capture: true,
		sessions: map[string]string{"pydantic_ai/weather_agent": ""},
		calls:    map[string][][2]int64{"pydantic_ai/weather_agent": {{658, 54}, {732, 18}}},
		tools:    map[string][]string{"pydantic_ai/weather_agent": {"get_weather"}},
		provider: "anthropic", totalInput: 1390, version: "2.64.0"},
	{e: "E3", fw: fxPydantic, scenario: "subagent-protobuf", capture: true,
		sessions: map[string]string{"pydantic_ai/assistant": "", "pydantic_ai/assistant/weather_agent": "pydantic_ai/assistant"},
		calls: map[string][][2]int64{
			"pydantic_ai/assistant":               {{666, 62}, {764, 18}},
			"pydantic_ai/assistant/weather_agent": {{647, 54}, {721, 27}},
		},
		tools: map[string][]string{
			"pydantic_ai/assistant":               {"ask_weather_agent"},
			"pydantic_ai/assistant/weather_agent": {"get_weather"},
		},
		provider: "anthropic", totalInput: 2798, version: "2.64.0"},
	{e: "E4", fw: fxPydantic, scenario: "tool-error-protobuf", capture: true,
		sessions: map[string]string{"pydantic_ai/orders_agent": ""},
		calls:    map[string][][2]int64{"pydantic_ai/orders_agent": {{662, 56}}},
		tools:    map[string][]string{"pydantic_ai/orders_agent": {"lookup_order"}},
		provider: "anthropic", totalInput: 662, version: "2.64.0"},
	{e: "E5", fw: fxPydantic, scenario: "tool-no-content-protobuf", capture: false,
		sessions: map[string]string{"pydantic_ai/weather_agent": ""},
		calls:    map[string][][2]int64{"pydantic_ai/weather_agent": {{658, 54}, {732, 18}}},
		tools:    map[string][]string{"pydantic_ai/weather_agent": {"get_weather"}},
		provider: "anthropic", totalInput: 1390, version: "2.64.0"},
	{e: "E6", fw: fxStrands, scenario: "tool-protobuf", capture: true,
		sessions:   map[string]string{"strands/weather_agent": ""},
		calls:      map[string][][2]int64{"strands/weather_agent": {{78, 14}, {107, 15}}},
		tools:      map[string][]string{"strands/weather_agent": {"get_weather"}},
		totalInput: 185, version: "1.63.0"},
	{e: "E7", fw: fxStrands, scenario: "tool-latest-json", capture: true,
		sessions:   map[string]string{"strands/weather_agent": ""},
		calls:      map[string][][2]int64{"strands/weather_agent": {{78, 14}, {107, 15}}},
		tools:      map[string][]string{"strands/weather_agent": {"get_weather"}},
		totalInput: 185, version: "1.63.0"},
	{e: "E8", fw: fxStrands, scenario: "tool-redacted-protobuf", capture: true,
		sessions:   map[string]string{"strands/weather_agent": ""},
		calls:      map[string][][2]int64{"strands/weather_agent": {{78, 14}, {107, 15}}},
		tools:      map[string][]string{"strands/weather_agent": {"get_weather"}},
		totalInput: 185, version: "1.63.0"},
	{e: "E9", fw: fxStrands, scenario: "subagent-protobuf", capture: true,
		sessions: map[string]string{"strands/assistant": "", "strands/assistant/weather_agent": "strands/assistant"},
		calls: map[string][][2]int64{
			"strands/assistant":               {{86, 22}, {133, 17}},
			"strands/assistant/weather_agent": {{68, 14}, {97, 17}},
		},
		tools: map[string][]string{
			"strands/assistant":               {"ask_weather_agent"},
			"strands/assistant/weather_agent": {"get_weather"},
		},
		totalInput: 384, version: "1.63.0"},
	{e: "E10", fw: fxStrands, scenario: "tool-error-protobuf", capture: true,
		sessions:   map[string]string{"strands/orders_agent": ""},
		calls:      map[string][][2]int64{"strands/orders_agent": {{76, 15}, {106, 8}}},
		tools:      map[string][]string{"strands/orders_agent": {"lookup_order"}},
		totalInput: 182, version: "1.63.0"},
	{e: "E11", fw: fxOpenAI, scenario: "tool-protobuf", capture: true,
		sessions:   map[string]string{"openai_agents/weather_agent": ""},
		calls:      map[string][][2]int64{"openai_agents/weather_agent": {{77, 15}, {107, 16}}},
		tools:      map[string][]string{"openai_agents/weather_agent": {"get_weather"}},
		totalInput: 184},
	{e: "E11", fw: fxOpenAI, scenario: "tool-json", capture: true,
		sessions:   map[string]string{"openai_agents/weather_agent": ""},
		calls:      map[string][][2]int64{"openai_agents/weather_agent": {{77, 15}, {107, 16}}},
		tools:      map[string][]string{"openai_agents/weather_agent": {"get_weather"}},
		totalInput: 184},
	{e: "E12", fw: fxOpenAI, scenario: "tool-no-content-protobuf", capture: false,
		sessions:   map[string]string{"openai_agents/weather_agent": ""},
		calls:      map[string][][2]int64{"openai_agents/weather_agent": {{77, 15}, {107, 16}}},
		tools:      map[string][]string{"openai_agents/weather_agent": {"get_weather"}},
		totalInput: 184},
	{e: "E13", fw: fxOpenAI, scenario: "tool-error-protobuf", capture: true,
		sessions:   map[string]string{"openai_agents/orders_agent": ""},
		calls:      map[string][][2]int64{"openai_agents/orders_agent": {{78, 16}, {114, 26}}},
		tools:      map[string][]string{"openai_agents/orders_agent": {"lookup_order"}},
		totalInput: 192},
	{e: "E14", fw: fxOpenAI, scenario: "subagent-protobuf", capture: true,
		sessions: map[string]string{"openai_agents/assistant": "", "openai_agents/assistant/weather_agent": "openai_agents/assistant"},
		calls: map[string][][2]int64{
			"openai_agents/assistant":               {{93, 22}, {138, 16}},
			"openai_agents/assistant/weather_agent": {{66, 15}, {96, 16}},
		},
		tools: map[string][]string{
			"openai_agents/assistant":               {"ask_weather_agent"},
			"openai_agents/assistant/weather_agent": {"get_weather"},
		},
		totalInput: 393},
	{e: "E15", fw: fxOpenAI, scenario: "handoff-protobuf", capture: true,
		sessions: map[string]string{"openai_agents/triage_agent": "", "openai_agents/weather_agent": ""},
		calls: map[string][][2]int64{
			"openai_agents/triage_agent":  {{69, 13}},
			"openai_agents/weather_agent": {{102, 15}, {132, 16}},
		},
		tools:      map[string][]string{"openai_agents/weather_agent": {"get_weather"}},
		totalInput: 303},
	{e: "E16", fw: fxADK, scenario: "tool-protobuf", capture: true,
		sessions: map[string]string{"google_adk/weather_agent": ""},
		calls:    map[string][][2]int64{"google_adk/weather_agent": {{103, 14}, {137, 15}}},
		tools:    map[string][]string{"google_adk/weather_agent": {"get_weather"}},
		provider: "openai", totalInput: 240, version: "2.13.0"},
	{e: "E17", fw: fxADK, scenario: "tool-no-content-protobuf", capture: false,
		sessions: map[string]string{"google_adk/weather_agent": ""},
		calls:    map[string][][2]int64{"google_adk/weather_agent": {{103, 14}, {137, 15}}},
		tools:    map[string][]string{"google_adk/weather_agent": {"get_weather"}},
		provider: "openai", totalInput: 240, version: "2.13.0"},
	{e: "E18", fw: fxADK, scenario: "tool-error-protobuf", capture: true,
		sessions: map[string]string{"google_adk/orders_agent": ""},
		calls:    map[string][][2]int64{"google_adk/orders_agent": {{93, 15}}},
		tools:    map[string][]string{"google_adk/orders_agent": {"lookup_order"}},
		provider: "openai", totalInput: 93, version: "2.13.0"},
	{e: "E19", fw: fxADK, scenario: "subagent-protobuf", capture: true,
		sessions: map[string]string{"google_adk/assistant": "", "google_adk/assistant/weather_agent": "google_adk/assistant"},
		calls: map[string][][2]int64{
			"google_adk/assistant":               {{79, 17}, {124, 16}},
			"google_adk/assistant/weather_agent": {{89, 14}, {123, 16}},
		},
		tools: map[string][]string{
			"google_adk/assistant":               {"weather_agent"},
			"google_adk/assistant/weather_agent": {"get_weather"},
		},
		provider: "openai", totalInput: 415, version: "2.13.0"},
	{e: "E20", fw: fxADK, scenario: "handoff-protobuf", capture: true,
		sessions: map[string]string{"google_adk/triage_agent": "", "google_adk/weather_agent": ""},
		calls: map[string][][2]int64{
			"google_adk/triage_agent":  {{244, 17}},
			"google_adk/weather_agent": {{553, 14}, {587, 16}},
		},
		tools: map[string][]string{
			"google_adk/triage_agent":  {"transfer_to_agent"},
			"google_adk/weather_agent": {"get_weather"},
		},
		provider: "openai", totalInput: 1384, version: "2.13.0"},
}

// E1-E20: sessions, parents, per-call tokens (from the outermost model
// span only: Pydantic AI's nested Anthropic SDK spans, Strands' agent
// totals and ADK's log records are never counted), tools and providers.
func TestFixtureScenarios(t *testing.T) {
	for _, w := range fixtureWants {
		t.Run(w.e+"/"+w.fw+"/"+w.scenario, func(t *testing.T) {
			evs := Resolve(fixtureInput(t, w.fw, w.scenario, w.capture))
			starts := startsByName(t, evs)
			if len(starts) != len(w.sessions) {
				t.Fatalf("sessions %v, want %v", keys(starts), w.sessions)
			}
			for name, parent := range w.sessions {
				st, ok := starts[name]
				if !ok {
					t.Fatalf("no session %q (have %v)", name, keys(starts))
				}
				if parent == "" {
					if st["parent_session_id"] != nil || st["agent_role"] != nil {
						t.Errorf("%s is not a root: %v", name, st)
					}
					continue
				}
				if st["parent_session_id"] != starts[parent]["session_id"] {
					t.Errorf("%s parent = %v, want %s", name, st["parent_session_id"], parent)
				}
				role := name[strings.LastIndexByte(name, '/')+1:]
				if st["agent_role"] != role {
					t.Errorf("%s role = %v, want %s", name, st["agent_role"], role)
				}
				if st["agent_id"] != identity.AgentID(defaultAgentType, unknownIdentity, unknownIdentity, ClientType, parentRoot(name), role) {
					t.Errorf("%s agent_id derived from the wrong tuple", name)
				}
			}
			if got := tokens(evs); !reflect.DeepEqual(got, w.calls) {
				t.Errorf("post_call tokens = %v, want %v", got, w.calls)
			}
			if got := totalInput(evs); got != w.totalInput {
				t.Errorf("total input = %d, want %d", got, w.totalInput)
			}
			if got := toolNames(evs); !reflect.DeepEqual(got, w.tools) {
				t.Errorf("tools = %v, want %v", got, w.tools)
			}
			for _, p := range ofType(evs, "post_call") {
				got, _ := p["provider"].(string)
				if got != w.provider {
					t.Errorf("provider = %q, want %q", got, w.provider)
				}
			}
			for _, st := range starts {
				if st["sensor_version"] != w.version || st["capture_prompts"] != w.capture {
					t.Errorf("start sensor_version %v capture %v", st["sensor_version"], st["capture_prompts"])
				}
			}
		})
	}
}

// parentRoot is the root agent_name a child's id derives from: its
// agent_name without the role.
func parentRoot(name string) string { return name[:strings.LastIndexByte(name, '/')] }

func keys(m map[string]map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

// Every recorded GenAI scenario maps to a well-formed, content-free
// event sequence: unique ids, every event inside a started session,
// starts parents first and ends children first, no content, and the
// same events when ADK's log records are left out (they are never
// mapped to events).
func TestFixtureInvariants(t *testing.T) {
	for _, fw := range []string{fxPydantic, fxStrands, fxOpenAI, fxADK} {
		ents, err := os.ReadDir(filepath.Join(fixtureRoot, fw))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range ents {
			for i, ft := range loadScenario(t, fw, e.Name()) {
				for _, capture := range []bool{true, false} {
					name := fw + "/" + e.Name() + "/" + strconv.Itoa(i) + "/capture=" + strconv.FormatBool(capture)
					t.Run(name, func(t *testing.T) {
						in := inputOf(ft, capture)
						evs := Resolve(in)
						checkSequence(t, evs)
						spansOnly := in
						spansOnly.Facts = nil
						for _, f := range in.Facts {
							if f.Kind == otlpstage.KindSpan {
								spansOnly.Facts = append(spansOnly.Facts, f)
							}
						}
						if !reflect.DeepEqual(Resolve(spansOnly), evs) {
							t.Error("log records changed the mapping")
						}
						for _, ev := range evs {
							checkNoContent(t, ev, capture)
						}
					})
				}
			}
		}
	}
}

// checkNoContent asserts an event carries no content: no content
// object, and error text only as the capture-off placeholder.
func checkNoContent(t *testing.T, ev Event, capture bool) {
	t.Helper()
	p := ev.Payload
	if p["has_content"] != false || p["content"] != nil {
		t.Errorf("%s carries content", ev.EventType)
	}
	block, _ := p["error"].(map[string]any)
	if block == nil {
		return
	}
	msg, has := block["message"]
	switch ev.EventType {
	case "tool_call":
		if capture && has || !capture && msg != redactedMessage {
			t.Errorf("tool error message %v with capture %v", msg, capture)
		}
	case "session_end":
		if has {
			t.Errorf("session error carries a message: %v", msg)
		}
	}
}

// checkSequence asserts the publish order and id rules on one assembly.
func checkSequence(t *testing.T, evs []Event) {
	t.Helper()
	ids := map[string]bool{}
	started := map[string]map[string]any{}
	ended := map[string]bool{}
	phase := 0 // 0 starts, 1 calls, 2 ends
	for _, ev := range evs {
		p := ev.Payload
		id := p["id"].(string)
		if ids[id] {
			t.Fatalf("duplicate event id %s", id)
		}
		ids[id] = true
		if p["session_id"] != ev.SessionID || p["event_type"] != ev.EventType {
			t.Fatalf("event header disagrees with payload: %v", ev)
		}
		switch ev.EventType {
		case "session_start":
			if phase != 0 {
				t.Fatal("session_start after a call")
			}
			if parent, ok := p["parent_session_id"].(string); ok && started[parent] == nil {
				t.Fatal("child started before its parent")
			}
			started[ev.SessionID] = p
			ctx := p["context"].(map[string]any)
			if ctx["telemetry"] != "otlp" || ctx["supports_directives"] != false || ctx["otel_trace_id"] == nil || ctx["otel_assembly"] != "complete" {
				t.Errorf("start context = %v", ctx)
			}
			if fws := ctx["frameworks"].([]any); len(fws) != 1 || !strings.HasPrefix(fws[0].(string), p["framework"].(string)) {
				t.Errorf("frameworks = %v", fws)
			}
		case "session_end":
			phase = 2
			for sid, st := range started {
				if st["parent_session_id"] == ev.SessionID && !ended[sid] {
					t.Fatal("parent ended before its child")
				}
			}
			ended[ev.SessionID] = true
		default:
			if phase == 2 {
				t.Fatal("call after a session_end")
			}
			phase = 1
		}
		if started[ev.SessionID] == nil {
			t.Fatalf("%s outside a started session", ev.EventType)
		}
		if p["client_type"] != ClientType {
			t.Fatalf("client_type = %v", p["client_type"])
		}
	}
	if len(ended) != len(started) {
		t.Errorf("%d sessions started, %d ended", len(started), len(ended))
	}
}

// E1, E3: Pydantic AI's nested Anthropic SDK spans are a foreign scope,
// so they only link and are never a call.
func TestE1E3NestedSDKSpansDropped(t *testing.T) {
	for _, sc := range []string{"tool-protobuf", "subagent-protobuf"} {
		in := fixtureInput(t, fxPydantic, sc, true)
		sdk := map[string]bool{}
		prefix := idPrefix + fixtureToken + "/" + hexID(in.Trace.Key.TraceID[:])
		for _, f := range in.Facts {
			if f.ScopeName == "com.anthropic.sdk.python" {
				sdk[identity.UUID5(identity.NamespaceFlightdeck, prefix+"/event/"+hexID(f.SpanID[:]))] = true
			}
		}
		if len(sdk) == 0 {
			t.Fatal("recording holds no Anthropic SDK spans")
		}
		for _, ev := range Resolve(in) {
			if sdk[ev.Payload["id"].(string)] {
				t.Errorf("%s: an Anthropic SDK span was mapped", sc)
			}
		}
	}
}

// E4, E18: a failed tool carries the error block, and a failed agent
// ends its session with state=error and its error class; the text is
// content, so with capture off the tool's message is the placeholder.
func TestE4E18Errors(t *testing.T) {
	for _, fw := range []string{fxPydantic, fxADK} {
		for _, capture := range []bool{true, false} {
			evs := Resolve(fixtureInput(t, fw, "tool-error-protobuf", capture))
			block := ofType(evs, "tool_call")[0]["error"].(map[string]any)
			if block["error_type"] != "other" || block["error_class"] != "ValueError" {
				t.Errorf("%s tool error = %v", fw, block)
			}
			if msg, has := block["message"]; capture && has || !capture && msg != redactedMessage {
				t.Errorf("%s capture %v: tool error message %v", fw, capture, msg)
			}
			end := ofType(evs, "session_end")[0]
			if end["state"] != "error" || end["error"].(map[string]any)["error_class"] != "ValueError" || end["close_reason"] != "normal_exit" {
				t.Errorf("%s end = %v", fw, end)
			}
		}
	}
}

// E18: ADK's <not specified> call id means none.
func TestE18NotSpecifiedToolID(t *testing.T) {
	tool := ofType(Resolve(fixtureInput(t, fxADK, "tool-error-protobuf", true)), "tool_call")[0]
	if _, ok := tool["tool_use_id"]; ok {
		t.Errorf("tool_use_id = %v, want none", tool["tool_use_id"])
	}
	ok := ofType(Resolve(fixtureInput(t, fxADK, "tool-protobuf", true)), "tool_call")[0]
	if id, _ := ok["tool_use_id"].(string); !strings.HasPrefix(id, "call_") {
		t.Errorf("a real call id was dropped: %v", ok["tool_use_id"])
	}
}

// E10, E13: a tool that fails while the run goes on; OpenAI Agents
// names no class, so the block has none, and neither agent fails.
func TestE10E13RecoveredToolErrors(t *testing.T) {
	for _, tc := range []struct{ fw, class string }{{fxStrands, "ValueError"}, {fxOpenAI, ""}} {
		evs := Resolve(fixtureInput(t, tc.fw, "tool-error-protobuf", true))
		block := ofType(evs, "tool_call")[0]["error"].(map[string]any)
		if got, _ := block["error_class"].(string); got != tc.class {
			t.Errorf("%s error_class = %q, want %q", tc.fw, got, tc.class)
		}
		if end := ofType(evs, "session_end")[0]; end["state"] != nil {
			t.Errorf("%s: a recovered run ended in error", tc.fw)
		}
	}
}

// E6, E7: Strands names itself as the provider, so none is passed
// through; its time to first token becomes the call's streaming block,
// and its service.name is not taken for a flavor.
func TestE6E7Strands(t *testing.T) {
	for _, sc := range []string{"tool-protobuf", "tool-latest-json"} {
		for _, p := range ofType(Resolve(fixtureInput(t, fxStrands, sc, true)), "post_call") {
			if _, ok := p["provider"]; ok {
				t.Errorf("%s: provider %v passed through", sc, p["provider"])
			}
			s, ok := p["streaming"].(map[string]any)
			if !ok || s["final_outcome"] != "completed" || s["ttft_ms"].(float64) <= 0 {
				t.Errorf("%s: streaming = %v", sc, p["streaming"])
			}
			if p["flavor"] != LabelStrands {
				t.Errorf("%s: flavor %v", sc, p["flavor"])
			}
		}
	}
}

// E11, E16: models, response ids, the session's context and its bounds;
// OpenAI Agents' configured provider is not passed through, ADK's is,
// and ADK's LiteLLM-prefixed model stays raw.
func TestE11E16CallFields(t *testing.T) {
	oa := Resolve(fixtureInput(t, fxOpenAI, "tool-protobuf", true))
	p := ofType(oa, "post_call")[0]
	if p["model_requested"] != "gpt-4o-mini-2024-07-18" || p["model_served"] == nil {
		t.Errorf("OpenAI Agents models: %v / %v", p["model_requested"], p["model_served"])
	}
	if id, _ := p["provider_metadata"].(map[string]any)["response_id"].(string); !strings.HasPrefix(id, "resp_") {
		t.Errorf("response id = %v", p["provider_metadata"])
	}
	if _, ok := ofType(oa, "tool_call")[0]["tool_use_id"]; ok {
		t.Error("OpenAI Agents sends no call id")
	}
	ctx := ofType(oa, "session_start")[0]["context"].(map[string]any)
	if ctx["frameworks"].([]any)[0] != LabelOpenAIAgents || ctx["otel_scope"] != "opentelemetry.instrumentation.openai_agents" ||
		len(ctx["otel_span_id"].(string)) != 16 || len(ctx["otel_trace_id"].(string)) != 32 {
		t.Errorf("OpenAI Agents context = %v", ctx)
	}

	in := fixtureInput(t, fxADK, "tool-protobuf", true)
	adk := Resolve(in)
	p = ofType(adk, "post_call")[0]
	if p["model_requested"] != "openai/gpt-4o-mini" || p["provider"] != "openai" {
		t.Errorf("ADK call: %v %v", p["model_requested"], p["provider"])
	}
	ctx = ofType(adk, "session_start")[0]["context"].(map[string]any)
	if ctx["frameworks"].([]any)[0] != "google_adk/2.13.0" || ctx["gen_ai_conversation_id"] == nil {
		t.Errorf("ADK context = %v", ctx)
	}
	for _, f := range in.Facts {
		if f.Op != opInvokeAgent {
			continue
		}
		if st := ofType(adk, "session_start")[0]; st["timestamp"] != stamp(f.StartNs) {
			t.Errorf("start %v, want the agent span's start", st["timestamp"])
		}
		if end := ofType(adk, "session_end")[0]; end["timestamp"] != stamp(f.EndNs) {
			t.Errorf("end %v, want the agent span's end", end["timestamp"])
		}
	}
}

// E14: the subagent run arrived in two exports, the root and both agent
// spans in the second. Assembled whole it maps like any run (above);
// assembled from the first export alone (its root never came) its calls
// go to the unattributed session, and the second export, assembled
// late, adds the agents without counting those calls again.
func TestE14SplitExport(t *testing.T) {
	ft := loadScenario(t, fxOpenAI, "subagent-protobuf")[0]
	first := &fixtureTrace{row: ft.row}
	for i, f := range ft.facts {
		if ft.arrived[i] == 0 {
			first.facts = append(first.facts, f)
			first.arrived = append(first.arrived, 0)
		}
	}
	in := inputOf(first, true)
	in.Reason = otlpstage.ReasonQuiet
	early := Resolve(in)
	starts := ofType(early, "session_start")
	if len(starts) != 1 || starts[0]["context"].(map[string]any)["otel_unattributed"] != true {
		t.Fatalf("first export alone: sessions %v", starts)
	}
	if got := totalInput(early); got != 93+66 {
		t.Errorf("first export's input = %d, want %d", got, 93+66)
	}

	late := inputOf(ft, true)
	late.Trace.AssemblyCount = 1
	for i := range late.Facts {
		late.Facts[i].Assembled = ft.arrived[i] == 0
	}
	evs := Resolve(late)
	earlyIDs := map[string]bool{}
	for _, ev := range early {
		earlyIDs[ev.Payload["id"].(string)] = true
	}
	for _, ev := range evs {
		if earlyIDs[ev.Payload["id"].(string)] {
			t.Errorf("late assembly re-published %s", ev.EventType)
		}
		if ev.SessionID == starts[0]["session_id"] {
			t.Errorf("the unattributed session gained %s", ev.EventType)
		}
	}
	if got := totalInput(evs); got != 138+96 {
		t.Errorf("late input = %d, want %d", got, 138+96)
	}
	names := startsByName(t, evs)
	if names["openai_agents/assistant/weather_agent"]["parent_session_id"] != names["openai_agents/assistant"]["session_id"] {
		t.Error("late child not under its parent")
	}
}

// E15, E20: hand-off agents are sibling roots (above), and the hand-off
// is an agent_handoff signal on the agent handing off; ADK's transfer
// tool also stays a tool call.
func TestE15E20Handoffs(t *testing.T) {
	for _, tc := range []struct{ fw, label string }{{fxOpenAI, LabelOpenAIAgents}, {fxADK, LabelGoogleADK}} {
		signals := ofType(Resolve(fixtureInput(t, tc.fw, "handoff-protobuf", true)), "session_signal")
		if len(signals) != 1 {
			t.Fatalf("%s: %d signals", tc.fw, len(signals))
		}
		s := signals[0]
		want := map[string]any{"from": "triage_agent", "to": "weather_agent"}
		if s["signal"] != signalHandoff || !reflect.DeepEqual(s["signal_data"], want) || s["agent_name"] != tc.label+"/triage_agent" {
			t.Errorf("%s signal = %v", tc.fw, s)
		}
	}
}

// E19: an agent called as a tool through ADK's nested invoke_workflow
// is a child, and every event of the child carries its parent and role.
func TestE19DepthThroughLinkSpans(t *testing.T) {
	evs := Resolve(fixtureInput(t, fxADK, "subagent-protobuf", true))
	names := startsByName(t, evs)
	child := names["google_adk/assistant/weather_agent"]
	if child == nil || child["parent_session_id"] != names["google_adk/assistant"]["session_id"] {
		t.Fatalf("child = %v", child)
	}
	for _, ev := range evs {
		if ev.SessionID == child["session_id"] && (ev.Payload["parent_session_id"] == nil || ev.Payload["agent_role"] != "weather_agent") {
			t.Errorf("child %s lacks its parent or role", ev.EventType)
		}
	}
}

// The cache recordings: input_tokens already includes cache in every
// framework, so it is taken as it is, and the cached share comes from
// the first cache spelling sent (none from OpenAI Agents).
func TestCacheRecordings(t *testing.T) {
	for _, tc := range []struct {
		fw, sc           string
		input            int64
		reads, creations []any
	}{
		{fxPydantic, "cache-no-content-protobuf", 6682, []any{int64(0), int64(6670)}, []any{int64(6670), int64(0)}},
		{fxStrands, "cache-protobuf", 1933, []any{int64(0), int64(1792)}, []any{nil, nil}},
		{fxADK, "cache-no-content-protobuf", 1934, []any{int64(1024), int64(1792)}, []any{nil, nil}},
		{fxOpenAI, "cache-no-content-protobuf", 1921, []any{nil, nil}, []any{nil, nil}},
	} {
		traces := loadScenario(t, tc.fw, tc.sc)
		if len(traces) != 2 {
			t.Fatalf("%s: %d traces, want one per call", tc.fw, len(traces))
		}
		var reads, creations []any
		for _, ft := range traces {
			calls := ofType(Resolve(inputOf(ft, false)), "post_call")
			if len(calls) != 1 {
				t.Fatalf("%s: %d calls in a trace", tc.fw, len(calls))
			}
			p := calls[0]
			if p["tokens_input"] != tc.input {
				t.Errorf("%s: tokens_input %v, want %d", tc.fw, p["tokens_input"], tc.input)
			}
			if meta, _ := p["provider_metadata"].(map[string]any); meta["input_excluded_cache"] != nil {
				t.Errorf("%s: cache added to an input that includes it", tc.fw)
			}
			reads = append(reads, p["tokens_cache_read"])
			creations = append(creations, p["tokens_cache_creation"])
		}
		if !reflect.DeepEqual(reads, tc.reads) || !reflect.DeepEqual(creations, tc.creations) {
			t.Errorf("%s: cache reads %v creations %v, want %v %v", tc.fw, reads, creations, tc.reads, tc.creations)
		}
	}
}

// The model-error recordings: a failed model call is an llm_error on its
// agent's session, never a post_call, classified from its class name.
func TestModelErrorRecordings(t *testing.T) {
	for _, tc := range []struct{ fw, sc, errorType, message, provider string }{
		{fxPydantic, "model-error-protobuf", "not_found", "pydantic_ai.exceptions.ModelNotFoundError", "anthropic"},
		{fxPydantic, "model-error-json", "not_found", "pydantic_ai.exceptions.ModelNotFoundError", "anthropic"},
		{fxStrands, "model-error-protobuf", "not_found", "openai.NotFoundError", ""},
		{fxStrands, "model-error-json", "not_found", "openai.NotFoundError", ""},
		{fxOpenAI, "model-error-protobuf", "other", modelErrorMessage, ""},
		{fxOpenAI, "model-error-json", "other", modelErrorMessage, ""},
		{fxADK, "model-error-protobuf", "not_found", "litellm.exceptions.NotFoundError", "openai"},
	} {
		evs := Resolve(fixtureInput(t, tc.fw, tc.sc, true))
		if n := len(ofType(evs, "post_call")); n != 0 {
			t.Errorf("%s/%s: %d post_calls", tc.fw, tc.sc, n)
		}
		errs := ofType(evs, "llm_error")
		if len(errs) != 1 {
			t.Fatalf("%s/%s: %d llm_errors", tc.fw, tc.sc, len(errs))
		}
		block := errs[0]["error"].(map[string]any)
		if block["error_type"] != tc.errorType || block["error_message"] != tc.message || block["is_retryable"] != false {
			t.Errorf("%s/%s: error = %v", tc.fw, tc.sc, block)
		}
		if got, _ := errs[0]["provider"].(string); got != tc.provider {
			t.Errorf("%s/%s: provider %q, want %q", tc.fw, tc.sc, got, tc.provider)
		}
		if end := ofType(evs, "session_end")[0]; end["state"] != "error" {
			t.Errorf("%s/%s: the failed agent did not end in error", tc.fw, tc.sc)
		}
	}
}
