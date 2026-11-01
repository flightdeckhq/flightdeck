package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/session"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// ccFixtureRoot holds the OTLP requests Claude Code 2.1.316 exported.
var ccFixtureRoot = filepath.Join("..", "..", "..", "tests", "fixtures", "otlp", "claude-code-2.1.316")

// ccFixtureNow is a few minutes after the fixtures were recorded, so
// their timestamps sit inside the validation window.
var ccFixtureNow = time.Date(2026, 11, 1, 12, 5, 0, 0, time.UTC)

// The Claude Code session ids of the recorded scenarios.
const (
	ccBashSession     = "64d4ab20-8afe-4f09-9a67-de1954585c05"
	ccSubagentSession = "898e9d82-4172-4be8-88e7-1df336742e10"
	ccSubagentAgentID = "aad3b518eff5ab279"
	ccFixtureUser     = "user@example.com"
)

// ccLogRequests decodes a scenario's log exports, in the order they were
// sent, through the receiver's own decoder.
func ccLogRequests(t *testing.T, scenario string) []*collogs.ExportLogsServiceRequest {
	t.Helper()
	dir := filepath.Join(ccFixtureRoot, scenario)
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m otlpFixtureManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	var out []*collogs.ExportLogsServiceRequest
	for _, r := range m.Requests {
		if r.Path != "/v1/logs" {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, r.File))
		if err != nil {
			t.Fatal(err)
		}
		enc := otlpEncodingJSON
		if r.ContentType == otlpMediaProtobuf {
			enc = otlpEncodingProtobuf
		}
		req := &collogs.ExportLogsServiceRequest{}
		if status, msg := decodeOTLPRequest(enc, body, req); status != 0 {
			t.Fatalf("%s/%s: %d %s", scenario, r.File, status, msg)
		}
		out = append(out, req)
	}
	if len(out) == 0 {
		t.Fatalf("%s has no log exports", scenario)
	}
	return out
}

// fakeSessionStore answers session reads from rows by session id;
// elsewhere names the Claude Code sessions another client reports.
type fakeSessionStore struct {
	mu        sync.Mutex
	rows      map[string]string // Flightdeck session id -> state
	elsewhere map[string]bool
	err       error
	calls     []string
}

func newFakeStore() *fakeSessionStore {
	return &fakeSessionStore{rows: map[string]string{}, elsewhere: map[string]bool{}}
}

func (f *fakeSessionStore) LookupOTLPSession(_ context.Context, id, root, cc string) (session.OTLPSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, id)
	if f.err != nil {
		return session.OTLPSession{}, f.err
	}
	return session.OTLPSession{
		State:             f.rows[id],
		RootStored:        f.rows[root] != "",
		ReportedElsewhere: f.elsewhere[cc],
	}, nil
}

func (f *fakeSessionStore) lookups() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// mappedEvent is one published event, decoded.
type mappedEvent struct {
	Type    string
	Session string
	Raw     []byte
	P       map[string]any
}

// clock is a settable test clock.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newTestDialect(store ClaudeCodeSessionStore) (*ClaudeCodeDialect, *clock) {
	c := &clock{t: ccFixtureNow}
	return newClaudeCodeDialect(store, c.now), c
}

// mapAll maps requests in order as the receiver does, committing each
// request's mapping as if its events were published.
func mapAll(t *testing.T, d *ClaudeCodeDialect, reqs []*collogs.ExportLogsServiceRequest) ([]mappedEvent, int64, []string) {
	t.Helper()
	var events []mappedEvent
	var rejected int64
	var messages []string
	for _, req := range reqs {
		m := d.MapLogs(context.Background(), req)
		if m.Err != nil {
			t.Fatalf("MapLogs: %v", m.Err)
		}
		if m.Published != nil {
			m.Published()
		}
		rejected += m.Rejected
		if m.Message != "" {
			messages = append(messages, m.Message)
		}
		for _, ev := range m.Events {
			var p map[string]any
			if err := json.Unmarshal(ev.Payload, &p); err != nil {
				t.Fatal(err)
			}
			if p["event_type"] != ev.EventType || p["session_id"] != ev.SessionID {
				t.Fatalf("event %s/%s carries %v/%v", ev.EventType, ev.SessionID, p["event_type"], p["session_id"])
			}
			events = append(events, mappedEvent{Type: ev.EventType, Session: ev.SessionID, Raw: ev.Payload, P: p})
		}
	}
	return events, rejected, messages
}

func eventTypes(events []mappedEvent) []string {
	out := make([]string, len(events))
	for i, e := range events {
		out[i] = e.Type
	}
	return out
}

func ofType(events []mappedEvent, eventType string) []mappedEvent {
	var out []mappedEvent
	for _, e := range events {
		if e.Type == eventType {
			out = append(out, e)
		}
	}
	return out
}

// setResourceAttr sets a string resource attribute on every resource of
// the requests, as an operator does with OTEL_RESOURCE_ATTRIBUTES.
func setResourceAttr(reqs []*collogs.ExportLogsServiceRequest, key, value string) {
	for _, req := range reqs {
		for _, rl := range req.GetResourceLogs() {
			rl.Resource.Attributes = append(rl.Resource.Attributes, &commonpb.KeyValue{
				Key: key, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
			})
		}
	}
}

func recordsOf(reqs []*collogs.ExportLogsServiceRequest) []*logspb.LogRecord {
	var out []*logspb.LogRecord
	for _, req := range reqs {
		for _, rl := range req.GetResourceLogs() {
			for _, sl := range rl.GetScopeLogs() {
				out = append(out, sl.GetLogRecords()...)
			}
		}
	}
	return out
}

func recordNamed(t *testing.T, reqs []*collogs.ExportLogsServiceRequest, name string) *logspb.LogRecord {
	t.Helper()
	for _, r := range recordsOf(reqs) {
		if newOTLPAttrs(r.GetAttributes()).text("event.name") == name {
			return r
		}
	}
	t.Fatalf("no %s record", name)
	return nil
}

func setAttr(r *logspb.LogRecord, key string, v *commonpb.AnyValue) {
	for _, kv := range r.Attributes {
		if kv.Key == key {
			kv.Value = v
			return
		}
	}
	r.Attributes = append(r.Attributes, &commonpb.KeyValue{Key: key, Value: v})
}

func strVal(s string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: s}}
}

func num(t *testing.T, p map[string]any, key string) float64 {
	t.Helper()
	v, ok := p[key].(float64)
	if !ok {
		t.Fatalf("%s is %#v, not a number", key, p[key])
	}
	return v
}

// The bash scenario over OTLP JSON maps to the session's synthetic
// start, its prompt, the rejected Bash call, three model calls and the
// tool call, with Claude Code's response and the accepted decision
// counted as rejected.
func TestClaudeCodeBashScenario(t *testing.T) {
	store := newFakeStore()
	d, _ := newTestDialect(store)
	events, rejected, messages := mapAll(t, d, ccLogRequests(t, "bash-json-prompts"))

	want := []string{"session_start", "pre_call", "session_signal", "post_call", "post_call", "tool_call", "post_call"}
	if got := eventTypes(events); !reflect.DeepEqual(got, want) {
		t.Fatalf("event types %v, want %v", got, want)
	}
	if rejected != 2 {
		t.Errorf("rejected %d, want 2 (assistant_response, accepted tool_decision): %v", rejected, messages)
	}
	joined := strings.Join(messages, " | ")
	for _, want := range []string{`"claude_code.assistant_response" is not mapped (1)`, `"claude_code.tool_decision" other than a reject is not mapped (1)`} {
		if !strings.Contains(joined, want) {
			t.Errorf("messages %q lack %q", joined, want)
		}
	}

	sid := identity.UUID5(identity.NamespaceFlightdeck, "flightdeck://otlp/claude-code/session/"+ccBashSession)
	agentID := identity.AgentID("coding", ccFixtureUser, "unknown", "claude_code", ccFixtureUser+"@unknown", "")
	for _, e := range events {
		if e.Session != sid {
			t.Errorf("%s on session %s, want %s", e.Type, e.Session, sid)
		}
		p := e.P
		for key, want := range map[string]any{
			"agent_type": "coding", "client_type": "claude_code", "flavor": "claude-code",
			"agent_id": agentID, "agent_name": ccFixtureUser + "@unknown", "user": ccFixtureUser,
			"hostname": "unknown", "host": "unknown", "framework": "claude-code",
		} {
			if p[key] != want {
				t.Errorf("%s %s = %v, want %v", e.Type, key, p[key], want)
			}
		}
		if _, ok := p["parent_session_id"]; ok {
			t.Errorf("%s of a root session carries parent_session_id", e.Type)
		}
	}

	start := events[0].P
	if start["sensor_version"] != "2.1.316" || start["capture_prompts"] != false {
		t.Errorf("session_start version/capture: %v %v", start["sensor_version"], start["capture_prompts"])
	}
	wantCtx := map[string]any{
		"claude_code_session_id": ccBashSession, "claude_code_version": "2.1.316",
		"os": "linux", "arch": "amd64", "terminal_type": "wsl-Ubuntu",
		"telemetry": "otlp", "supports_directives": false,
	}
	if !reflect.DeepEqual(start["context"], wantCtx) {
		t.Errorf("session_start context %v, want %v", start["context"], wantCtx)
	}
	startAt, _ := time.Parse(time.RFC3339Nano, start["timestamp"].(string))
	firstAt, _ := time.Parse(time.RFC3339Nano, events[1].P["timestamp"].(string))
	if !startAt.Equal(firstAt.Add(-time.Microsecond)) {
		t.Errorf("session_start at %v, first record at %v: want one microsecond before", startAt, firstAt)
	}
	firstID := events[1].P["id"].(string)
	if start["id"] != identity.UUID5(identity.NamespaceFlightdeck, "flightdeck://otlp/claude-code/start/"+sid+"/"+firstID) {
		t.Errorf("session_start id %v does not derive from the session and its first record", start["id"])
	}

	signal := events[2].P
	if signal["signal"] != "permission_denied" {
		t.Errorf("signal %v", signal["signal"])
	}
	wantData := map[string]any{"tool_name": "Bash", "tool_use_id": "toolu_01DqD6qjRf6HQyG4vf8mLrgJ", "reason": "config"}
	if !reflect.DeepEqual(signal["signal_data"], wantData) {
		t.Errorf("signal_data %v, want %v (never the tool's input)", signal["signal_data"], wantData)
	}

	call := events[3].P
	for key, want := range map[string]float64{
		"tokens_input": 10 + 14595 + 7474, "tokens_output": 155, "tokens_total": 10 + 14595 + 7474 + 155,
		"tokens_cache_read": 14595, "tokens_cache_creation": 7474, "tokens_cache_creation_1h": 7474,
		"latency_ms": 1937, "cost_reported": 0.0171925,
	} {
		if got := num(t, call, key); got != want {
			t.Errorf("post_call %s = %v, want %v", key, got, want)
		}
	}
	for key, want := range map[string]any{
		"model": "claude-haiku-4-5-20251001", "model_requested": "claude-haiku-4-5-20251001",
		"model_served": "claude-haiku-4-5-20251001", "provider": "anthropic",
		"cost_source": "agent", "billing_mode": "subscription",
	} {
		if call[key] != want {
			t.Errorf("post_call %s = %v, want %v", key, call[key], want)
		}
	}
	if want := map[string]any{"ttft_ms": 1062.0, "final_outcome": "completed"}; !reflect.DeepEqual(call["streaming"], want) {
		t.Errorf("streaming %v, want only %v", call["streaming"], want)
	}
	if want := map[string]any{"request_id": "req_011CgcAuy88rXygZkQWnsu4j", "query_source": "sdk"}; !reflect.DeepEqual(call["provider_metadata"], want) {
		t.Errorf("provider_metadata %v, want %v", call["provider_metadata"], want)
	}

	tool := events[5].P
	if tool["tool_name"] != "Bash" || tool["tool_use_id"] != "toolu_01WM2ChHS7BPk8o5Jh2Z4v97" ||
		num(t, tool, "duration_ms") != 409 || num(t, tool, "latency_ms") != 409 {
		t.Errorf("tool_call %v", tool)
	}
	if _, ok := tool["error"]; ok {
		t.Error("a successful tool carries an error block")
	}
}

// A record's event id is uuid5 of its session, type, sequence and time,
// so an exporter retrying a request maps it to the same ids.
func TestClaudeCodeEventIDsAreIdempotent(t *testing.T) {
	reqs := ccLogRequests(t, "bash-json-prompts")
	d1, _ := newTestDialect(newFakeStore())
	d2, _ := newTestDialect(newFakeStore())
	first, _, _ := mapAll(t, d1, reqs)
	again, _, _ := mapAll(t, d2, reqs)
	if len(first) != len(again) {
		t.Fatalf("%d events then %d", len(first), len(again))
	}
	for i := range first {
		if !bytes.Equal(first[i].Raw, again[i].Raw) {
			t.Errorf("event %d differs between runs:\n%s\n%s", i, first[i].Raw, again[i].Raw)
		}
	}
	rec := recordNamed(t, reqs, "api_request")
	want := identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/event/"+ccBashSession+"/api_request/11/"+"1793534442388000000")
	if rec.GetTimeUnixNano() != 1793534442388000000 {
		t.Fatalf("fixture changed: %d", rec.GetTimeUnixNano())
	}
	if ofType(first, "post_call")[0].P["id"] != want {
		t.Errorf("post_call id %v, want %s", ofType(first, "post_call")[0].P["id"], want)
	}
}

// The protobuf recording (the same prompt as the JSON one, run again, so
// the model chose one call fewer) maps to the same kinds of events, and
// a protobuf request re-encoded as OTLP JSON maps to exactly the same
// events: the encoding does not change the mapping.
func TestClaudeCodeProtobufMapsLikeJSON(t *testing.T) {
	pbReqs := ccLogRequests(t, "bash-protobuf-gzip")
	pbDialect, _ := newTestDialect(newFakeStore())
	pbEvents, pbRejected, _ := mapAll(t, pbDialect, pbReqs)
	want := []string{"session_start", "pre_call", "session_signal", "post_call", "tool_call", "post_call"}
	if !reflect.DeepEqual(eventTypes(pbEvents), want) || pbRejected != 2 {
		t.Errorf("protobuf mapped %v (%d rejected), want %v (2)", eventTypes(pbEvents), pbRejected, want)
	}
	if signal := ofType(pbEvents, "session_signal")[0].P; signal["signal"] != "permission_denied" {
		t.Errorf("protobuf signal %v", signal)
	}

	var reencoded []*collogs.ExportLogsServiceRequest
	for _, req := range pbReqs {
		// protojson writes trace and span ids in base64 where OTLP JSON
		// writes hex; the mapping reads neither.
		req = proto.Clone(req).(*collogs.ExportLogsServiceRequest)
		for _, r := range recordsOf([]*collogs.ExportLogsServiceRequest{req}) {
			r.TraceId, r.SpanId = nil, nil
		}
		body, err := protojson.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		back := &collogs.ExportLogsServiceRequest{}
		if status, msg := decodeOTLPRequest(otlpEncodingJSON, body, back); status != 0 {
			t.Fatalf("%d %s", status, msg)
		}
		reencoded = append(reencoded, back)
	}
	viaJSON, _ := newTestDialect(newFakeStore())
	jsonOfPB, _, _ := mapAll(t, viaJSON, reencoded)
	if len(jsonOfPB) != len(pbEvents) {
		t.Fatalf("%d events from protobuf, %d from its JSON", len(pbEvents), len(jsonOfPB))
	}
	for i := range pbEvents {
		if !bytes.Equal(pbEvents[i].Raw, jsonOfPB[i].Raw) {
			t.Errorf("event %d differs:\n%s\n%s", i, pbEvents[i].Raw, jsonOfPB[i].Raw)
		}
	}
}

// A sub-agent's records go to a child session keyed by its agent_id,
// started after the root and ended by subagent_completed; the Agent
// tool's own result stays a tool_call on the parent.
func TestClaudeCodeSubagentScenario(t *testing.T) {
	store := newFakeStore()
	d, _ := newTestDialect(store)
	events, _, _ := mapAll(t, d, ccLogRequests(t, "subagent-json"))

	root := identity.UUID5(identity.NamespaceFlightdeck, "flightdeck://otlp/claude-code/session/"+ccSubagentSession)
	child := identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/session/"+ccSubagentSession+"/"+ccSubagentAgentID)
	childAgent := identity.AgentID("coding", ccFixtureUser, "unknown", "claude_code", ccFixtureUser+"@unknown", "general-purpose")

	var childEvents []string
	starts := map[string]int{}
	for _, e := range events {
		if e.Type == "session_start" {
			starts[e.Session]++
		}
		if e.Session != child {
			if e.Session != root {
				t.Errorf("event on unknown session %s", e.Session)
			}
			continue
		}
		childEvents = append(childEvents, e.Type)
		for key, want := range map[string]any{
			"parent_session_id": root, "agent_role": "general-purpose", "agent_id": childAgent,
			"agent_name": ccFixtureUser + "@unknown/general-purpose",
		} {
			if e.P[key] != want {
				t.Errorf("child %s %s = %v, want %v", e.Type, key, e.P[key], want)
			}
		}
	}
	if starts[root] != 1 || starts[child] != 1 {
		t.Errorf("session_starts %v, want one each", starts)
	}
	wantChild := []string{"session_start", "post_call", "tool_call", "post_call", "session_end"}
	if !reflect.DeepEqual(childEvents, wantChild) {
		t.Errorf("child events %v, want %v", childEvents, wantChild)
	}
	for _, e := range events {
		if e.Type == "session_end" && e.P["close_reason"] != "normal_exit" {
			t.Errorf("session_end close_reason %v", e.P["close_reason"])
		}
		if e.Type == "tool_call" && e.P["tool_name"] == "Agent" && e.Session != root {
			t.Error("the Agent tool's result moved off the parent")
		}
	}
	// The root is started before anything of its sub-agent.
	if events[0].Type != "session_start" || events[0].Session != root {
		t.Errorf("first event %s on %s", events[0].Type, events[0].Session)
	}
	// subagent_completed dropped the child from the cache; the root stays.
	if _, ok := d.cache.get(child); ok {
		t.Error("the ended child is still cached")
	}
	if _, ok := d.cache.get(root); !ok {
		t.Error("the root is not cached")
	}
}

// The role comes from agent.name, else an agent:builtin:<type>
// query_source; a sub-agent's later records without either take it from
// the cache.
func TestClaudeCodeSubagentRoleSources(t *testing.T) {
	reqs := ccLogRequests(t, "subagent-json")
	for _, r := range recordsOf(reqs) {
		kept := r.Attributes[:0]
		for _, kv := range r.Attributes {
			if kv.Key != "agent.name" {
				kept = append(kept, kv)
			}
		}
		r.Attributes = kept
	}
	d, _ := newTestDialect(newFakeStore())
	events, _, _ := mapAll(t, d, reqs)
	for _, e := range events {
		if e.P["parent_session_id"] != nil && e.P["agent_role"] != "general-purpose" {
			t.Errorf("child %s role %v from query_source", e.Type, e.P["agent_role"])
		}
	}

	// A later export holding only a role-less tool result of the child.
	var tool *logspb.LogRecord
	for _, r := range recordsOf(ccLogRequests(t, "subagent-json")) {
		a := newOTLPAttrs(r.GetAttributes())
		if a.text("event.name") == "tool_result" && a.text("agent_id") != "" {
			tool = r
		}
	}
	d2, _ := newTestDialect(newFakeStore())
	first := ccLogRequests(t, "subagent-json")[:3] // up to the child's first model call
	mapAll(t, d2, first)
	later := &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		Resource:  first[0].ResourceLogs[0].Resource,
		ScopeLogs: []*logspb.ScopeLogs{{Scope: first[0].ResourceLogs[0].ScopeLogs[0].Scope, LogRecords: []*logspb.LogRecord{tool}}},
	}}}
	got, _, _ := mapAll(t, d2, []*collogs.ExportLogsServiceRequest{later})
	if len(got) != 1 || got[0].P["agent_role"] != "general-purpose" {
		t.Errorf("role-less child record mapped to %v", got)
	}
}

// An MCP tool record names its server and tool in tool_parameters and
// maps to mcp_tool_call; the connection records are not mapped.
func TestClaudeCodeMCPScenario(t *testing.T) {
	d, _ := newTestDialect(newFakeStore())
	events, _, messages := mapAll(t, d, ccLogRequests(t, "mcp-json"))
	calls := ofType(events, "mcp_tool_call")
	if len(calls) != 1 {
		t.Fatalf("%d mcp_tool_calls in %v", len(calls), eventTypes(events))
	}
	p := calls[0].P
	if p["server_name"] != "flightdeck-mcp-reference" || p["tool_name"] != "echo" ||
		p["tool_use_id"] != "toolu_01Ta6qNaMK7UaAmRshfsjLLJ" || num(t, p, "duration_ms") != 7 {
		t.Errorf("mcp_tool_call %v", p)
	}
	if tools := ofType(events, "tool_call"); len(tools) != 1 || tools[0].P["tool_name"] != "ToolSearch" {
		t.Errorf("tool_calls %v", tools)
	}
	if !strings.Contains(strings.Join(messages, " "), `"claude_code.mcp_server_connection" is not mapped`) {
		t.Errorf("messages %v", messages)
	}

	// Without OTEL_LOG_TOOL_DETAILS the record has no tool_parameters and
	// stays a tool_call named mcp_tool.
	reqs := ccLogRequests(t, "mcp-json")
	for _, r := range recordsOf(reqs) {
		kept := r.Attributes[:0]
		for _, kv := range r.Attributes {
			if kv.Key != "tool_parameters" {
				kept = append(kept, kv)
			}
		}
		r.Attributes = kept
	}
	d2, _ := newTestDialect(newFakeStore())
	plain, _, _ := mapAll(t, d2, reqs)
	if len(ofType(plain, "mcp_tool_call")) != 0 {
		t.Error("mcp_tool_call without tool_parameters")
	}
	found := false
	for _, e := range ofType(plain, "tool_call") {
		found = found || e.P["tool_name"] == "mcp_tool"
	}
	if !found {
		t.Error("no tool_call named mcp_tool")
	}
}

// A rejected MCP call's signal names the server, never the arguments.
func TestClaudeCodeMCPPermissionDenied(t *testing.T) {
	reqs := ccLogRequests(t, "mcp-json")
	for _, r := range recordsOf(reqs) {
		a := newOTLPAttrs(r.GetAttributes())
		if a.text("event.name") == "tool_decision" && a.text("tool_name") == "mcp_tool" {
			setAttr(r, "decision", strVal("reject"))
			setAttr(r, "source", strVal("user_reject"))
		}
	}
	d, _ := newTestDialect(newFakeStore())
	events, _, _ := mapAll(t, d, reqs)
	signals := ofType(events, "session_signal")
	if len(signals) != 1 {
		t.Fatalf("%d signals", len(signals))
	}
	want := map[string]any{
		"tool_name": "echo", "mcp_server": "flightdeck-mcp-reference",
		"tool_use_id": "toolu_01Ta6qNaMK7UaAmRshfsjLLJ", "reason": "user_reject",
	}
	if !reflect.DeepEqual(signals[0].P["signal_data"], want) {
		t.Errorf("signal_data %v, want %v", signals[0].P["signal_data"], want)
	}
}

// An API error maps to llm_error classified from its status, without
// terminal, and without its text while capture is off.
func TestClaudeCodeAPIError(t *testing.T) {
	d, _ := newTestDialect(newFakeStore())
	events, _, _ := mapAll(t, d, ccLogRequests(t, "api-error-json"))
	errs := ofType(events, "llm_error")
	if len(errs) != 1 {
		t.Fatalf("llm_errors %v", eventTypes(events))
	}
	p := errs[0].P
	if _, ok := p["terminal"]; ok {
		t.Error("llm_error sets terminal")
	}
	if p["provider"] != "anthropic" || num(t, p, "retry_attempt") != 1 || p["model"] != "claude-fd-does-not-exist" {
		t.Errorf("llm_error %v", p)
	}
	block := p["error"].(map[string]any)
	want := map[string]any{
		"error_type": "not_found", "provider": "anthropic", "http_status": 404.0,
		"provider_error_code": nil, "error_message": "Claude Code API error (HTTP 404)",
		"request_id": "req_011CgcAyXzQBV5zW2zi4E1GU", "retry_after": nil, "is_retryable": false,
	}
	if !reflect.DeepEqual(block, want) {
		t.Errorf("error block %v, want %v", block, want)
	}

	reqs := ccLogRequests(t, "api-error-json")
	setResourceAttr(reqs, otlpAttrCapturePrompts, "true")
	d2, _ := newTestDialect(newFakeStore())
	on, _, _ := mapAll(t, d2, reqs)
	msg := ofType(on, "llm_error")[0].P["error"].(map[string]any)["error_message"]
	if msg != "Claude Code API error (HTTP 404): model: claude-fd-does-not-exist" {
		t.Errorf("capture-on error_message %v", msg)
	}
}

func TestClassifyClaudeCodeAPIError(t *testing.T) {
	cases := []struct {
		status int64
		text   string
		want   string
	}{
		{400, "messages: bad", "invalid_request"},
		{400, "Prompt is too long: 210000 tokens", "context_overflow"},
		{400, "Your credit balance is too low", "quota_exceeded"},
		{401, "", "authentication"},
		{402, "", "quota_exceeded"},
		{403, "", "permission"},
		{404, "", "not_found"},
		{408, "", "timeout"},
		{413, "", "request_too_large"},
		{422, "", "invalid_request"},
		{429, "rate limited", "rate_limit"},
		{429, "you have reached your spend limit", "quota_exceeded"},
		{500, "", "api_error"},
		{503, "", "api_error"},
		{504, "", "timeout"},
		{529, "", "overloaded"},
		{0, "Request timed out", "timeout"},
		{0, "connection reset", "other"},
	}
	for _, c := range cases {
		if got := classifyClaudeCodeAPIError(c.status, c.text); got != c.want {
			t.Errorf("classify(%d, %q) = %s, want %s", c.status, c.text, got, c.want)
		}
	}
}

// A failed tool carries an error block whose text is redacted while
// capture is off.
func TestClaudeCodeFailedTool(t *testing.T) {
	for _, capture := range []bool{false, true} {
		reqs := ccLogRequests(t, "bash-json-prompts")
		r := recordNamed(t, reqs, "tool_result")
		setAttr(r, "success", strVal("false"))
		setAttr(r, "error", strVal("Exit code 2: ls: cannot access '/secret-dir'"))
		if capture {
			setResourceAttr(reqs, otlpAttrCapturePrompts, "true")
		}
		d, _ := newTestDialect(newFakeStore())
		events, _, _ := mapAll(t, d, reqs)
		block := ofType(events, "tool_call")[0].P["error"].(map[string]any)
		wantMsg := otlpRedactedErrorMessage
		if capture {
			wantMsg = "Exit code 2: ls: cannot access '/secret-dir'"
		}
		want := map[string]any{"error_type": "other", "error_class": "ClaudeCodeToolError", "message": wantMsg}
		if !reflect.DeepEqual(block, want) {
			t.Errorf("capture=%v error %v, want %v", capture, block, want)
		}
	}
}

// Claude Code sends numbers as strings, and a token count may arrive as
// a double: each maps as the number it is. A count that is not one is
// refused by validation and counted as rejected.
func TestClaudeCodeStringNumerics(t *testing.T) {
	reqs := ccLogRequests(t, "bash-json-prompts")
	r := recordNamed(t, reqs, "api_request")
	setAttr(r, "input_tokens", strVal("10"))
	setAttr(r, "output_tokens", &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: 155}})
	setAttr(r, "cache_read_tokens", strVal(" 14595 "))
	setAttr(r, "cost_usd", strVal("0.0171925"))
	setAttr(r, "duration_ms", strVal("1937.0"))
	setAttr(r, "ttft_ms", strVal("1062"))
	d, _ := newTestDialect(newFakeStore())
	events, _, _ := mapAll(t, d, reqs)
	call := ofType(events, "post_call")[0].P
	for key, want := range map[string]float64{
		"tokens_input": 10 + 14595 + 7474, "tokens_output": 155, "latency_ms": 1937, "cost_reported": 0.0171925,
	} {
		if got := num(t, call, key); got != want {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}
	if call["streaming"].(map[string]any)["ttft_ms"] != 1062.0 {
		t.Errorf("ttft %v", call["streaming"])
	}

	bad := ccLogRequests(t, "bash-json-prompts")
	setAttr(recordNamed(t, bad, "api_request"), "output_tokens", strVal("lots"))
	d2, _ := newTestDialect(newFakeStore())
	events2, rejected, messages := mapAll(t, d2, bad)
	if len(ofType(events2, "post_call")) != 2 || rejected != 3 {
		t.Errorf("%d post_calls, %d rejected", len(ofType(events2, "post_call")), rejected)
	}
	if !strings.Contains(strings.Join(messages, " "), `"claude_code.api_request" event is invalid: tokens_input must be >= 0`) {
		t.Errorf("messages %v", messages)
	}
}

func TestOTLPAttrCoercion(t *testing.T) {
	a := otlpAttrs{
		"i": {Value: &commonpb.AnyValue_IntValue{IntValue: 7}},
		"d": {Value: &commonpb.AnyValue_DoubleValue{DoubleValue: 7}},
		"f": {Value: &commonpb.AnyValue_DoubleValue{DoubleValue: 7.5}},
		"s": strVal("7"), "sf": strVal("7.0"), "x": strVal("seven"),
		"t": strVal("TRUE"), "b": {Value: &commonpb.AnyValue_BoolValue{BoolValue: true}},
		"r": strVal(otlpRedacted), "e": strVal(""),
	}
	for _, key := range []string{"i", "d", "s", "sf"} {
		if n, present, ok := a.integer(key); !present || !ok || n != 7 {
			t.Errorf("integer(%s) = %d %v %v", key, n, present, ok)
		}
	}
	for _, key := range []string{"f", "x"} {
		if _, present, ok := a.integer(key); !present || ok {
			t.Errorf("integer(%s) accepted", key)
		}
	}
	if _, present, _ := a.integer("missing"); present {
		t.Error("missing integer present")
	}
	if f, _, ok := a.number("f"); !ok || f != 7.5 {
		t.Errorf("number(f) = %v", f)
	}
	for _, key := range []string{"t", "b"} {
		if b, _, ok := a.boolean(key); !ok || !b {
			t.Errorf("boolean(%s) = %v %v", key, b, ok)
		}
	}
	if s, _ := a.str("i"); s != "7" {
		t.Errorf("str(i) = %q", s)
	}
	for _, key := range []string{"r", "e", "i", "missing"} {
		if _, ok := a.content(key); ok {
			t.Errorf("content(%s) counted as content", key)
		}
	}
}

// fixtureContent collects the content a scenario's records carry: the
// prompts, responses, tool inputs and parameters and error texts, whole
// and, for JSON documents, each string value long enough to be specific.
// The MCP server and tool names in tool_parameters are identifiers, not
// content, and are left out.
func fixtureContent(t *testing.T, reqs []*collogs.ExportLogsServiceRequest) []string {
	t.Helper()
	const minSpecific = 6
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if len(s) >= minSpecific && s != otlpRedacted && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	var walk func(v any, key string)
	walk = func(v any, key string) {
		switch x := v.(type) {
		case string:
			if key != "mcp_server_name" && key != "mcp_tool_name" {
				add(x)
			}
		case map[string]any:
			for k, item := range x {
				walk(item, k)
			}
		case []any:
			for _, item := range x {
				walk(item, key)
			}
		}
	}
	for _, r := range recordsOf(reqs) {
		a := newOTLPAttrs(r.GetAttributes())
		for _, key := range []string{"prompt", "prompt_text", "response", "tool_input", "tool_parameters", "error"} {
			s, ok := a.content(key)
			if !ok {
				continue
			}
			if key != "tool_parameters" {
				add(s)
			}
			var doc any
			if key != "error" && json.Unmarshal([]byte(s), &doc) == nil {
				walk(doc, "")
			}
		}
	}
	return out
}

// With capture off no prompt, response, tool input, MCP argument or
// error text reaches any field of any event, nor any log line written
// while mapping, in every recorded scenario.
func TestClaudeCodeCaptureOffSendsNoContent(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	total := 0
	for _, scenario := range []string{"bash-json-prompts", "bash-protobuf-gzip", "subagent-json", "mcp-json", "api-error-json"} {
		reqs := ccLogRequests(t, scenario)
		// A failed tool's error text joins the recorded content.
		for _, rec := range recordsOf(reqs) {
			if newOTLPAttrs(rec.GetAttributes()).text("event.name") == "tool_result" {
				setAttr(rec, "success", strVal("false"))
				setAttr(rec, "error", strVal("stderr: secret-token-"+scenario))
				break
			}
		}
		content := fixtureContent(t, reqs)
		d, _ := newTestDialect(newFakeStore())
		events, _, messages := mapAll(t, d, reqs)
		if len(events) == 0 {
			t.Fatalf("%s mapped nothing", scenario)
		}
		for _, e := range events {
			if e.P["has_content"] != false || e.P["content"] != nil {
				t.Errorf("%s %s carries content", scenario, e.Type)
			}
			for _, c := range content {
				if bytes.Contains(e.Raw, []byte(c)) || strings.Contains(string(mustMarshal(t, e.P)), c) {
					t.Errorf("%s %s carries content %q", scenario, e.Type, c)
				}
			}
		}
		for _, c := range content {
			if strings.Contains(strings.Join(messages, " "), c) || strings.Contains(logs.String(), c) {
				t.Errorf("%s: content %q in a message or log line", scenario, c)
			}
		}
		total += len(content)
	}
	if total < 20 {
		t.Fatalf("only %d content strings found in the fixtures; the walk is not looking", total)
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// With flightdeck.capture_prompts=true the prompt rides on pre_call as
// a PromptContent and a tool's input on its tool_call, and the session
// declares the posture the worker stores content under.
func TestClaudeCodeCaptureOn(t *testing.T) {
	reqs := ccLogRequests(t, "mcp-json")
	setResourceAttr(reqs, otlpAttrCapturePrompts, "true")
	d, _ := newTestDialect(newFakeStore())
	events, _, _ := mapAll(t, d, reqs)
	if events[0].Type != "session_start" || events[0].P["capture_prompts"] != true {
		t.Fatalf("first event %v", events[0].P)
	}
	pre := ofType(events, "pre_call")[0].P
	content := pre["content"].(map[string]any)
	msgs := content["messages"].([]any)
	if pre["has_content"] != true || content["provider"] != "anthropic" || len(msgs) != 1 ||
		!strings.HasPrefix(msgs[0].(map[string]any)["content"].(string), "Call the echo tool of the flightdeck-mcp-reference") {
		t.Errorf("pre_call content %v", content)
	}
	mcp := ofType(events, "mcp_tool_call")[0].P
	mc := mcp["content"].(map[string]any)
	if mcp["has_content"] != true || mc["provider"] != "mcp" || mc["model"] != "flightdeck-mcp-reference" ||
		!reflect.DeepEqual(mc["tool_input"], map[string]any{"text": "hi"}) {
		t.Errorf("mcp content %v", mc)
	}
	tool := ofType(events, "tool_call")[0].P["content"].(map[string]any)
	if tool["provider"] != "anthropic" || tool["tool_input"].(map[string]any)["max_results"] != 1.0 {
		t.Errorf("tool content %v", tool)
	}

	// Claude Code's <REDACTED> placeholder is no content, capture or not.
	red := ccLogRequests(t, "api-error-json")
	setResourceAttr(red, otlpAttrCapturePrompts, "true")
	d2, _ := newTestDialect(newFakeStore())
	evs, _, _ := mapAll(t, d2, red)
	if p := ofType(evs, "pre_call")[0].P; p["has_content"] != false || p["content"] != nil {
		t.Errorf("redacted prompt captured: %v", p)
	}
}

// Content past the event size limit is cut to fit, marked, as the
// plugin cuts it.
func TestClaudeCodeContentCutToFit(t *testing.T) {
	reqs := ccLogRequests(t, "bash-json-prompts")
	setResourceAttr(reqs, otlpAttrCapturePrompts, "true")
	huge := strings.Repeat("x<y&z ", (1<<20)/6)
	setAttr(recordNamed(t, reqs, "user_prompt"), "prompt", strVal(huge))
	d, _ := newTestDialect(newFakeStore())
	events, _, _ := mapAll(t, d, reqs)
	pre := ofType(events, "pre_call")[0]
	if len(pre.Raw) > maxOTLPEventBodyBytes {
		t.Fatalf("pre_call is %d bytes", len(pre.Raw))
	}
	text := pre.P["content"].(map[string]any)["messages"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.Contains(text, "[flightdeck: kept ") || len(text) < 100_000 {
		t.Errorf("cut prompt is %d bytes, marker present %v", len(text), strings.Contains(text, "[flightdeck: kept "))
	}
}

// A session another client reports is not reported again: its records,
// and its sub-agents' (without a read of their own), are rejected. One
// whose root is already stored over OTLP keeps being reported.
func TestClaudeCodeDedupe(t *testing.T) {
	store := newFakeStore()
	store.elsewhere[ccSubagentSession] = true
	d, _ := newTestDialect(store)
	events, rejected, messages := mapAll(t, d, ccLogRequests(t, "subagent-json"))
	if len(events) != 0 {
		t.Errorf("deduped session published %v", eventTypes(events))
	}
	if rejected == 0 || !strings.Contains(strings.Join(messages, " "), "reported by another Flightdeck client") {
		t.Errorf("rejected %d, messages %v", rejected, messages)
	}
	if n := store.lookups(); n != 1 {
		t.Errorf("%d reads, want one for the root (cached after)", n)
	}

	stored := newFakeStore()
	stored.elsewhere[ccSubagentSession] = true
	root := identity.UUID5(identity.NamespaceFlightdeck, "flightdeck://otlp/claude-code/session/"+ccSubagentSession)
	stored.rows[root] = "active"
	d2, _ := newTestDialect(stored)
	events2, _, _ := mapAll(t, d2, ccLogRequests(t, "subagent-json"))
	if len(ofType(events2, "post_call")) == 0 {
		t.Error("a session already stored over OTLP was dropped")
	}
	for _, e := range ofType(events2, "session_start") {
		if e.Session == root {
			t.Error("an active root was started again")
		}
	}
}

// A synthetic session_start precedes a session's events when its row is
// missing or closed, and only then.
func TestClaudeCodeSyntheticStartByState(t *testing.T) {
	sid := identity.UUID5(identity.NamespaceFlightdeck, "flightdeck://otlp/claude-code/session/"+ccBashSession)
	for state, want := range map[string]bool{"": true, "closed": true, "active": false, "idle": false, "stale": false, "lost": false} {
		store := newFakeStore()
		store.rows[sid] = state
		d, _ := newTestDialect(store)
		events, _, _ := mapAll(t, d, ccLogRequests(t, "bash-json-prompts"))
		if got := len(ofType(events, "session_start")) == 1; got != want {
			t.Errorf("state %q: session_start %v, want %v", state, got, want)
		}
	}
}

// The cache saves the read for ten minutes, is committed only when the
// request's events were published, and forgets a session at its end.
func TestClaudeCodeSessionCache(t *testing.T) {
	store := newFakeStore()
	d, clk := newTestDialect(store)
	reqs := ccLogRequests(t, "bash-json-prompts")

	// Not published (a refused request): nothing is cached.
	m := d.MapLogs(context.Background(), reqs[0])
	if m.Err != nil || len(m.Events) != 2 || m.Events[0].EventType != "session_start" {
		t.Fatalf("first map: %v %v", m.Err, m.Events)
	}
	if d.cache.len() != 0 {
		t.Fatal("cached before publish")
	}
	again := d.MapLogs(context.Background(), reqs[0])
	if again.Events[0].EventType != "session_start" || !bytes.Equal(again.Events[0].Payload, m.Events[0].Payload) {
		t.Error("a retried request does not publish the same session_start")
	}
	again.Published()

	before := store.lookups()
	next := d.MapLogs(context.Background(), reqs[1])
	if store.lookups() != before {
		t.Error("a cached session was read again")
	}
	for _, ev := range next.Events {
		if ev.EventType == "session_start" {
			t.Error("a cached session was started again")
		}
	}
	next.Published()

	clk.advance(otlpSessionCacheTTL)
	d.MapLogs(context.Background(), reqs[2])
	if store.lookups() != before+1 {
		t.Error("an expired entry was not read again")
	}

	// A lookup failure fails the request.
	failing := newFakeStore()
	failing.err = errors.New("db down")
	fd, _ := newTestDialect(failing)
	if got := fd.MapLogs(context.Background(), reqs[0]); got.Err == nil || len(got.Events) != 0 {
		t.Errorf("lookup failure mapped %v", got)
	}
}

func TestOTLPSessionCacheBound(t *testing.T) {
	c := &clock{t: ccFixtureNow}
	cache := newOTLPSessionCache(c.now)
	for i := range otlpSessionCacheMaxEntries {
		cache.put(identity.UUID5(identity.NamespaceFlightdeck, string(rune(i))+strings.Repeat("k", i%7)), false, "")
	}
	n := cache.len()
	cache.put("one-more", false, "")
	if cache.len() != n || n > otlpSessionCacheMaxEntries {
		t.Errorf("cache grew past its bound: %d then %d", n, cache.len())
	}
	c.advance(otlpSessionCacheTTL)
	cache.put("after-expiry", false, "")
	if cache.len() != 1 {
		t.Errorf("a full cache of expired entries holds %d after a sweep", cache.len())
	}
}

// Events too old for the validation window are counted as rejected, as
// POST /v1/events refuses them.
func TestClaudeCodeValidationRejects(t *testing.T) {
	d, clk := newTestDialect(newFakeStore())
	clk.advance(72 * time.Hour)
	events, rejected, messages := mapAll(t, d, ccLogRequests(t, "bash-json-prompts"))
	if len(events) != 0 || rejected != 8 {
		t.Errorf("%d events, %d rejected", len(events), rejected)
	}
	if !strings.Contains(strings.Join(messages, " "), "clock-skew window") {
		t.Errorf("messages %v", messages)
	}
}

// Records of other sources and scopes, and Claude Code's spans and
// metrics, are counted as rejected.
func TestClaudeCodeOtherSourcesRejected(t *testing.T) {
	req := ccLogRequests(t, "bash-json-prompts")[2]
	other := proto.Clone(req).(*collogs.ExportLogsServiceRequest)
	for _, kv := range other.ResourceLogs[0].Resource.Attributes {
		if kv.Key == "service.name" {
			kv.Value = strVal("codex")
		}
	}
	scoped := proto.Clone(req).(*collogs.ExportLogsServiceRequest)
	scoped.ResourceLogs[0].ScopeLogs[0].Scope.Name = "io.other"
	d, _ := newTestDialect(newFakeStore())
	for name, r := range map[string]*collogs.ExportLogsServiceRequest{`source "codex"`: other, `scope "io.other"`: scoped} {
		m := d.MapLogs(context.Background(), r)
		if len(m.Events) != 0 || m.Rejected != 3 || !strings.Contains(m.Message, name+" is not mapped (3)") {
			t.Errorf("%s: %d events, %d rejected, %q", name, len(m.Events), m.Rejected, m.Message)
		}
	}
}

func TestRejectionSetMessage(t *testing.T) {
	r := newRejectionSet()
	if r.message("log record") != "" {
		t.Error("empty set has a message")
	}
	r.add("b", 1)
	if got := r.message("log record"); got != "1 log record not used: b (1)" {
		t.Errorf("%q", got)
	}
	for i := range 8 {
		r.add(strings.Repeat("r", i+1), int64(i+2))
	}
	got := r.message("log record")
	if !strings.HasPrefix(got, "45 log records not used: rrrrrrrr (9); rrrrrrr (8)") || !strings.HasSuffix(got, "; 10 for other reasons") {
		t.Errorf("%q", got)
	}
	long := newRejectionSet()
	long.add(strings.Repeat("é", 200), 1)
	if m := long.message("log record"); len(m) > 200 {
		t.Errorf("reason not cut: %d bytes", len(m))
	}
}
