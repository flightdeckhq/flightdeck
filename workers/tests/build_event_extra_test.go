package tests

import (
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
)

// Phase 4: BuildEventExtra used to short-circuit for every event type
// except directive_result. That behaviour masked the Phase 4 LLM_ERROR
// and streaming sub-objects because neither is a directive event. The
// gate is now lifted; the tests below pin the intended behaviour so a
// future refactor cannot regress it silently.

func TestBuildEventExtra_LLMError_SerializesStructuredError(t *testing.T) {
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "llm_error",
		Error: json.RawMessage(
			`{"error_type":"rate_limit","provider":"anthropic","http_status":429,"is_retryable":true}`,
		),
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("expected non-empty extra for llm_error event")
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	inner, ok := parsed["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.error should be a map, got %T: %v", parsed["error"], parsed)
	}
	if inner["error_type"] != "rate_limit" {
		t.Errorf("error_type: want rate_limit, got %v", inner["error_type"])
	}
	if inner["is_retryable"] != true {
		t.Errorf("is_retryable: want true, got %v", inner["is_retryable"])
	}
}

func TestBuildEventExtra_Streaming_SerializesSubObject(t *testing.T) {
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "post_call",
		Streaming: json.RawMessage(
			`{"ttft_ms":320,"chunk_count":42,"final_outcome":"completed"}`,
		),
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	inner, ok := parsed["streaming"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.streaming should be a map, got %T: %v", parsed["streaming"], parsed)
	}
	if int(inner["chunk_count"].(float64)) != 42 {
		t.Errorf("chunk_count: want 42, got %v", inner["chunk_count"])
	}
}

func TestBuildEventExtra_DirectiveResultStillWorks(t *testing.T) {
	// Regression guard: the directive_result path must keep emitting
	// its legacy extras when the gate is lifted.
	e := consumer.EventPayload{
		SessionID:       "x",
		EventType:       "directive_result",
		DirectiveName:   "warn",
		DirectiveAction: "warn",
		DirectiveStatus: "ok",
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	if parsed["directive_name"] != "warn" {
		t.Errorf("directive_name: want 'warn', got %v", parsed["directive_name"])
	}
}

func TestBuildEventExtra_NoExtras_ReturnsNil(t *testing.T) {
	// Most event types (session_start, post_call without streaming,
	// tool_call, pre_call, heartbeat) carry no Phase 4 extras. For
	// those the function must still short-circuit to nil so the
	// payload column stays NULL -- matching pre-Phase-4 behaviour.
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "post_call",
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if out != nil {
		t.Errorf("expected nil extras for bare post_call, got %q", string(out))
	}
}

// The Claude Code plugin sends tool_use_id, mcp_server and end_reason.
// Each must land in events.payload when present and be absent
// otherwise, so a reader can tell "not sent" from "sent empty".

func TestBuildEventExtra_ToolUseID_ProjectsWhenPresent(t *testing.T) {
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "tool_call",
		ToolUseID: "toolu_01Xg9Qe5dbennMRZ7YuUVr4m",
	}
	parsed := buildExtra(t, e)
	if parsed["tool_use_id"] != "toolu_01Xg9Qe5dbennMRZ7YuUVr4m" {
		t.Errorf("tool_use_id: want toolu_01Xg9Qe5dbennMRZ7YuUVr4m, got %v", parsed["tool_use_id"])
	}
}

func TestBuildEventExtra_MCPServer_ReattachedAsOneDocument(t *testing.T) {
	e := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_tool_call",
		ServerName: "plugin:claude-mem:mcp-search",
		MCPServer:  json.RawMessage(`{"name":"plugin:claude-mem:mcp-search","source":"plugin"}`),
	}
	parsed := buildExtra(t, e)
	inner, ok := parsed["mcp_server"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.mcp_server should be a map, got %T: %v", parsed["mcp_server"], parsed)
	}
	if inner["name"] != "plugin:claude-mem:mcp-search" {
		t.Errorf("mcp_server.name: got %v", inner["name"])
	}
	if inner["source"] != "plugin" {
		t.Errorf("mcp_server.source: got %v", inner["source"])
	}
}

func TestBuildEventExtra_EndReason_ProjectsBesideCloseReason(t *testing.T) {
	e := consumer.EventPayload{
		SessionID:   "x",
		EventType:   "session_end",
		CloseReason: "normal_exit",
		EndReason:   "prompt_input_exit",
	}
	parsed := buildExtra(t, e)
	if parsed["close_reason"] != "normal_exit" {
		t.Errorf("close_reason: want normal_exit, got %v", parsed["close_reason"])
	}
	if parsed["end_reason"] != "prompt_input_exit" {
		t.Errorf("end_reason: want prompt_input_exit, got %v", parsed["end_reason"])
	}
}

func TestBuildEventExtra_PluginFieldsAbsentWhenNotSent(t *testing.T) {
	// A sensor tool_call / mcp_tool_call / session_end never carries
	// the plugin's fields; the stored payload must not grow empty keys.
	cases := []struct {
		name string
		e    consumer.EventPayload
	}{
		{"tool_call", consumer.EventPayload{SessionID: "x", EventType: "tool_call"}},
		{"mcp_tool_call", consumer.EventPayload{SessionID: "x", EventType: "mcp_tool_call", ServerName: "filesystem"}},
		{"session_end", consumer.EventPayload{SessionID: "x", EventType: "session_end", CloseReason: "normal_exit"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parsed := buildExtra(t, tc.e)
			for _, key := range []string{"tool_use_id", "mcp_server", "end_reason"} {
				if v, present := parsed[key]; present {
					t.Errorf("%s must be absent when not sent, got %v", key, v)
				}
			}
		})
	}
}

func TestBuildEventExtra_MCPServer_MalformedDropped(t *testing.T) {
	// Unreachable from the wire (the consumer's json.Unmarshal of the
	// NATS body terminates non-JSON first), like streaming; a RawMessage
	// built in-process can still hold anything, and the projection must
	// drop the document rather than fail the event.
	cases := []struct {
		name string
		raw  string
	}{
		{"truncated object", `{not json`},
		{"dangling value", `{"name":}`},
		{"bare word", `nul`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parsed := buildExtra(t, consumer.EventPayload{
				SessionID:  "x",
				EventType:  "mcp_tool_call",
				ServerName: "filesystem",
				MCPServer:  json.RawMessage(tc.raw),
			})
			if _, present := parsed["mcp_server"]; present {
				t.Errorf("malformed mcp_server must be dropped, got %v", parsed["mcp_server"])
			}
			if parsed["server_name"] != "filesystem" {
				t.Errorf("server_name must survive a dropped mcp_server, got %v", parsed["server_name"])
			}
		})
	}
}

// buildExtra runs BuildEventExtra and decodes the result; an event with
// nothing to project decodes to an empty map.
func buildExtra(t *testing.T, e consumer.EventPayload) map[string]interface{} {
	t.Helper()
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	parsed := map[string]interface{}{}
	if len(out) == 0 {
		return parsed
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	return parsed
}

// Wire-shaped bodies as plugin/hooks/scripts/observe_cli.mjs emits them,
// decoded into consumer.EventPayload the way the consumer does
// (json.Unmarshal of the NATS body) and projected by BuildEventExtra.
// Pins the json tags of tool_use_id, mcp_server and end_reason, which
// tests that build the struct directly never exercise, and covers
// tool_use_id on mcp_tool_call.
func TestBuildEventExtra_PluginWire_RoundTrip(t *testing.T) {
	const identity = `"session_id":"e1391fde-a91d-49b8-89b8-d404c85f341a",` +
		`"flavor":"claude-code","agent_type":"coding",` +
		`"agent_id":"ee76931b-06fa-5da6-a019-5a8237efd496",` +
		`"agent_name":"user@host","client_type":"claude_code",` +
		`"user":"user","hostname":"host","host":"host",` +
		`"framework":"claude-code","model":null,"tokens_input":0,` +
		`"tokens_output":0,"tokens_total":0,"tokens_cache_read":0,` +
		`"tokens_cache_creation":0,"tokens_used_session":0,` +
		`"token_limit_session":null,`
	cases := []struct {
		name     string
		body     string
		wantKeys []string
		check    func(t *testing.T, parsed map[string]interface{})
	}{
		{
			name: "tool_call success",
			body: `{` + identity +
				`"has_content":true,"content":{"provider":"anthropic",` +
				`"model":"","system":null,"messages":[],"tools":[{"type":` +
				`"tool_use","name":"Bash","input":{"command":"echo probe-ok"}}],` +
				`"response":[]},"event_type":"tool_call","tool_name":"Bash",` +
				`"tool_input":"{\"command\":\"echo probe-ok\"}","tool_result":null,` +
				`"is_subagent_call":false,"parent_session_id":null,` +
				`"latency_ms":61,"duration_ms":61,` +
				`"timestamp":"2026-10-21T07:19:03.000Z",` +
				`"tool_use_id":"toolu_01QZprSBN8zPMQDX1hRS5ABq"}`,
			wantKeys: []string{"duration_ms", "tool_use_id"},
			check: func(t *testing.T, parsed map[string]interface{}) {
				if parsed["tool_use_id"] != "toolu_01QZprSBN8zPMQDX1hRS5ABq" {
					t.Errorf("tool_use_id: got %v", parsed["tool_use_id"])
				}
				if parsed["duration_ms"] != float64(61) {
					t.Errorf("duration_ms: want 61, got %v", parsed["duration_ms"])
				}
			},
		},
		{
			name: "tool_call failure",
			body: `{` + identity +
				`"has_content":true,"content":{"provider":"anthropic",` +
				`"model":"","system":null,"messages":[],"tools":[{"type":` +
				`"tool_use","name":"Bash","input":{"command":"ls /missing"}}],` +
				`"response":[]},"event_type":"tool_call","tool_name":"Bash",` +
				`"tool_input":"{\"command\":\"ls /missing\"}","tool_result":null,` +
				`"is_subagent_call":false,"parent_session_id":null,` +
				`"latency_ms":449,"duration_ms":449,` +
				`"timestamp":"2026-10-21T07:19:02.000Z",` +
				`"tool_use_id":"toolu_01Xg9Qe5dbennMRZ7YuUVr4m",` +
				`"error":{"error_type":"other","error_class":"PluginToolError",` +
				`"message":"Exit code 2\nls: cannot access '/missing': No such file or directory",` +
				`"interrupted":false}}`,
			wantKeys: []string{"duration_ms", "error", "tool_use_id"},
			check: func(t *testing.T, parsed map[string]interface{}) {
				inner, ok := parsed["error"].(map[string]interface{})
				if !ok {
					t.Fatalf("error should be a map, got %T", parsed["error"])
				}
				if inner["error_class"] != "PluginToolError" {
					t.Errorf("error_class: got %v", inner["error_class"])
				}
				if inner["interrupted"] != false {
					t.Errorf("interrupted: got %v", inner["interrupted"])
				}
			},
		},
		{
			name: "mcp_tool_call with unresolved source",
			body: `{` + identity +
				`"has_content":true,"content":{"system":null,"messages":[],` +
				`"tools":null,"response":{},"input":null,` +
				`"tool_input":{"path":"/tmp/x"},"tool_output":null,` +
				`"provider":"mcp","model":"filesystem",` +
				`"session_id":"e1391fde-a91d-49b8-89b8-d404c85f341a",` +
				`"event_id":"","captured_at":"2026-10-21T07:19:05.000Z"},` +
				`"event_type":"mcp_tool_call","server_name":"filesystem",` +
				`"transport":null,"tool_name":"read_file","duration_ms":9,` +
				`"timestamp":"2026-10-21T07:19:05.000Z",` +
				`"mcp_server":{"name":"filesystem","source":null},` +
				`"tool_use_id":"toolu_01EcQvDizFdJhFyotPFoe13E"}`,
			wantKeys: []string{"duration_ms", "mcp_server", "server_name", "tool_use_id"},
			check: func(t *testing.T, parsed map[string]interface{}) {
				if parsed["tool_use_id"] != "toolu_01EcQvDizFdJhFyotPFoe13E" {
					t.Errorf("tool_use_id: got %v", parsed["tool_use_id"])
				}
				inner, ok := parsed["mcp_server"].(map[string]interface{})
				if !ok {
					t.Fatalf("mcp_server should be a map, got %T", parsed["mcp_server"])
				}
				if inner["name"] != "filesystem" {
					t.Errorf("mcp_server.name: got %v", inner["name"])
				}
				if source, present := inner["source"]; !present || source != nil {
					t.Errorf("mcp_server.source: want an explicit null, got %v (present=%v)", source, present)
				}
			},
		},
		{
			name: "session_end",
			body: `{` + identity +
				`"has_content":false,"content":null,` +
				`"event_type":"session_end","tool_name":null,"tool_input":null,` +
				`"is_subagent_call":false,"latency_ms":null,` +
				`"timestamp":"2026-10-21T07:19:06.000Z",` +
				`"close_reason":"normal_exit","end_reason":"prompt_input_exit"}`,
			wantKeys: []string{"close_reason", "end_reason"},
			check: func(t *testing.T, parsed map[string]interface{}) {
				if parsed["end_reason"] != "prompt_input_exit" {
					t.Errorf("end_reason: got %v", parsed["end_reason"])
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var e consumer.EventPayload
			if err := json.Unmarshal([]byte(tc.body), &e); err != nil {
				t.Fatalf("unmarshal wire body: %v", err)
			}
			parsed := buildExtra(t, e)
			if len(parsed) != len(tc.wantKeys) {
				t.Errorf("payload keys: want %v, got %v", tc.wantKeys, keysOf(parsed))
			}
			for _, key := range tc.wantKeys {
				if _, present := parsed[key]; !present {
					t.Errorf("payload key %q missing; got %v", key, keysOf(parsed))
				}
			}
			tc.check(t, parsed)
		})
	}
}

func keysOf(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// Hostile mcp_server shapes a direct publisher on the bus could send:
// ingestion rejects them, and the projection drops every non-object
// too, so events.payload never holds a number, an array or a null
// where the dashboard expects {name, source}. A nested object is still
// an object and passes through (its size is bounded by ingestion's
// request-body cap).
func TestBuildEventExtra_MCPServer_NonObjectShapesDropped(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		present bool
	}{
		{"number", `7`, false},
		{"array", `["filesystem"]`, false},
		{"null", `null`, false},
		{"string", `"filesystem"`, false},
		{"deep nesting", `{"name":"x","source":"plugin","extra":{"a":{"b":{"c":1}}}}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parsed := buildExtra(t, consumer.EventPayload{
				SessionID:  "x",
				EventType:  "mcp_tool_call",
				ServerName: "filesystem",
				MCPServer:  json.RawMessage(tc.raw),
			})
			_, present := parsed["mcp_server"]
			if present != tc.present {
				t.Errorf("mcp_server present=%v, want %v (got %v)", present, tc.present, parsed["mcp_server"])
			}
			if parsed["server_name"] != "filesystem" {
				t.Errorf("server_name must survive, got %v", parsed["server_name"])
			}
		})
	}
}

// The stored capture posture governs a plugin tool failure's error text
// the way it governs content: ToolErrorNeedsCaptureCheck selects exactly
// the plugin's tool events with an error block, and StripToolErrorMessage
// replaces the message while keeping the rest of the block.
func TestToolErrorCaptureGate(t *testing.T) {
	errBlock := json.RawMessage(`{"error_type":"other","error_class":"PluginToolError","message":"Exit code 2: secret","interrupted":false}`)
	cases := []struct {
		name string
		e    consumer.EventPayload
		want bool
	}{
		{"plugin tool_call with error", consumer.EventPayload{ClientType: "claude_code", EventType: "tool_call", Error: errBlock}, true},
		{"plugin mcp_tool_call with error", consumer.EventPayload{ClientType: "claude_code", EventType: "mcp_tool_call", Error: errBlock}, true},
		{"plugin tool_call without error", consumer.EventPayload{ClientType: "claude_code", EventType: "tool_call"}, false},
		{"plugin llm_error", consumer.EventPayload{ClientType: "claude_code", EventType: "llm_error", Error: errBlock}, false},
		{"sensor mcp_tool_call with error", consumer.EventPayload{ClientType: "flightdeck_sensor", EventType: "mcp_tool_call", Error: errBlock}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := processor.ToolErrorNeedsCaptureCheck(tc.e); got != tc.want {
				t.Errorf("ToolErrorNeedsCaptureCheck = %v, want %v", got, tc.want)
			}
		})
	}

	extra, err := processor.BuildEventExtra(consumer.EventPayload{
		SessionID:  "x",
		ClientType: "claude_code",
		EventType:  "tool_call",
		ToolUseID:  "toolu_01",
		Error:      errBlock,
	})
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	stripped := processor.StripToolErrorMessage(extra)
	var parsed map[string]interface{}
	if err := json.Unmarshal(stripped, &parsed); err != nil {
		t.Fatalf("parse stripped extra: %v", err)
	}
	inner, ok := parsed["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("error block missing after strip: %v", parsed)
	}
	if inner["message"] != processor.RedactedToolErrorMessage {
		t.Errorf("message: want %q, got %v", processor.RedactedToolErrorMessage, inner["message"])
	}
	if inner["error_type"] != "other" || inner["error_class"] != "PluginToolError" || inner["interrupted"] != false {
		t.Errorf("the rest of the block must survive the strip: %v", inner)
	}
	if parsed["tool_use_id"] != "toolu_01" {
		t.Errorf("sibling payload keys must survive the strip: %v", parsed)
	}
	// No error block, no message, unparseable blob: returned unchanged.
	for _, in := range [][]byte{nil, []byte(`{"duration_ms":5}`), []byte(`{"error":{"error_type":"other"}}`), []byte(`{not json`)} {
		if out := processor.StripToolErrorMessage(in); string(out) != string(in) {
			t.Errorf("StripToolErrorMessage(%q) = %q, want unchanged", in, out)
		}
	}
}
