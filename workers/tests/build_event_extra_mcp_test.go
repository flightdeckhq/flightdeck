package tests

import (
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
)

// Phase 5 — MCP event payload projection through BuildEventExtra.
//
// The dashboard contract (dashboard/tests/e2e/fixtures/mcp-events.json)
// is the source of truth for these field names + shapes. The tests
// below pin the projection so a future refactor cannot silently drop
// an MCP-specific field from events.payload JSONB.

func TestBuildEventExtra_MCPToolCall_LeanShape(t *testing.T) {
	durationMs := int64(42)
	e := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_tool_call",
		ServerName: "flightdeck-mcp-reference",
		Transport:  "stdio",
		DurationMs: &durationMs,
		Arguments:  json.RawMessage(`{"text":"fixture"}`),
		Result: json.RawMessage(
			`{"content":[{"type":"text","text":"fixture"}],"isError":false}`,
		),
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("expected non-empty extra for mcp_tool_call")
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	if parsed["server_name"] != "flightdeck-mcp-reference" {
		t.Errorf("server_name: want flightdeck-mcp-reference, got %v", parsed["server_name"])
	}
	if parsed["transport"] != "stdio" {
		t.Errorf("transport: want stdio, got %v", parsed["transport"])
	}
	if int(parsed["duration_ms"].(float64)) != 42 {
		t.Errorf("duration_ms: want 42, got %v", parsed["duration_ms"])
	}
	args, ok := parsed["arguments"].(map[string]interface{})
	if !ok {
		t.Fatalf("arguments must be a map, got %T", parsed["arguments"])
	}
	if args["text"] != "fixture" {
		t.Errorf("arguments.text: want fixture, got %v", args["text"])
	}
	res, ok := parsed["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("result must be a map, got %T", parsed["result"])
	}
	if res["isError"] != false {
		t.Errorf("result.isError: want false, got %v", res["isError"])
	}
}

func TestBuildEventExtra_MCPToolList_CountOnly(t *testing.T) {
	count := 3
	durationMs := int64(11)
	e := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_tool_list",
		ServerName: "demo",
		Transport:  "stdio",
		Count:      &count,
		DurationMs: &durationMs,
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	if int(parsed["count"].(float64)) != 3 {
		t.Errorf("count: want 3, got %v", parsed["count"])
	}
	// List events do not carry tool/argument/result; structural floor.
	for _, banned := range []string{"arguments", "result", "rendered", "resource_uri"} {
		if _, present := parsed[banned]; present {
			t.Errorf("mcp_tool_list must not carry %q in extras (lean shape)", banned)
		}
	}
}

func TestBuildEventExtra_MCPResourceRead_ContentInline(t *testing.T) {
	// Lean MCP payload: HasContent=false, but Content is populated with
	// the captured ReadResourceResult JSON. BuildEventExtra projects it
	// inline into events.payload (rather than the LLM event_content
	// table) for MCP_RESOURCE_READ. See the dashboard-contract README.
	bytes := int64(46)
	durationMs := int64(7)
	e := consumer.EventPayload{
		SessionID:    "x",
		EventType:    "mcp_resource_read",
		ServerName:   "demo",
		Transport:    "stdio",
		ResourceURI:  "mem://demo",
		ContentBytes: &bytes,
		MimeType:     "text/plain",
		DurationMs:   &durationMs,
		HasContent:   false,
		Content: json.RawMessage(
			`{"contents":[{"text":"hello","mimeType":"text/plain"}]}`,
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
	if parsed["resource_uri"] != "mem://demo" {
		t.Errorf("resource_uri: want mem://demo, got %v", parsed["resource_uri"])
	}
	if int(parsed["content_bytes"].(float64)) != 46 {
		t.Errorf("content_bytes: want 46, got %v", parsed["content_bytes"])
	}
	if parsed["mime_type"] != "text/plain" {
		t.Errorf("mime_type: want text/plain, got %v", parsed["mime_type"])
	}
	content, ok := parsed["content"].(map[string]interface{})
	if !ok {
		t.Fatalf("content must be inline map, got %T", parsed["content"])
	}
	contents, ok := content["contents"].([]interface{})
	if !ok || len(contents) == 0 {
		t.Fatalf("content.contents must be a non-empty array, got %v", content["contents"])
	}
}

func TestBuildEventExtra_MCPResourceRead_DoesNotInlineWhenHasContentTrue(t *testing.T) {
	// Defensive guard: if a future change ever sets HasContent=true on
	// an MCP event (it should not), the inline-content projection must
	// NOT fire. Same Content rawmessage routes via the LLM
	// event_content path instead, matching the established convention
	// for has_content=true.
	e := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_resource_read",
		ServerName: "demo",
		Transport:  "stdio",
		HasContent: true,
		Content: json.RawMessage(
			`{"contents":[{"text":"hello"}]}`,
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
	if _, present := parsed["content"]; present {
		t.Errorf("HasContent=true must route Content via event_content, not extras")
	}
}

func TestBuildEventExtra_MCPPromptGet_RenderedMessages(t *testing.T) {
	durationMs := int64(3)
	e := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_prompt_get",
		ServerName: "demo",
		Transport:  "stdio",
		PromptName: "greet",
		Arguments:  json.RawMessage(`{"name":"Ada"}`),
		Rendered: json.RawMessage(
			`[{"role":"user","content":"hi"},{"role":"assistant","content":"hello Ada"}]`,
		),
		DurationMs: &durationMs,
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	if parsed["prompt_name"] != "greet" {
		t.Errorf("prompt_name: want greet, got %v", parsed["prompt_name"])
	}
	rendered, ok := parsed["rendered"].([]interface{})
	if !ok || len(rendered) != 2 {
		t.Fatalf("rendered must be a 2-message array, got %v", parsed["rendered"])
	}
}

func TestBuildEventExtra_MCPError_StructuredErrorTaxonomy(t *testing.T) {
	// Failure path on any MCP op surfaces via the existing Error
	// json.RawMessage projection. The sensor's MCP interceptor
	// (sensor/flightdeck_sensor/interceptor/mcp.py::_classify_mcp_error)
	// produces the structured taxonomy {error_type, error_class,
	// message, code, data}. Worker-side projection is unchanged from
	// the llm_error path.
	e := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_tool_call",
		ServerName: "demo",
		Transport:  "stdio",
		Error: json.RawMessage(
			`{"error_type":"invalid_params","code":-32602,"message":"bad arg","error_class":"McpError"}`,
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
	inner, ok := parsed["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("error must be inline map, got %T", parsed["error"])
	}
	if inner["error_type"] != "invalid_params" {
		t.Errorf("error.error_type: want invalid_params, got %v", inner["error_type"])
	}
	if int(inner["code"].(float64)) != -32602 {
		t.Errorf("error.code: want -32602, got %v", inner["code"])
	}
}

func TestBuildEventExtra_NonMCPEvent_DoesNotProjectMCPFields(t *testing.T) {
	// Defensive guard: a non-MCP event payload (post_call) that
	// happens to share zero values must not gain MCP-shape fields.
	// The projection guards in BuildEventExtra are based on field
	// presence, not event_type — this test ensures the absence of
	// MCP fields is preserved.
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "post_call",
		Model:     "claude-opus-4-7",
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if len(out) != 0 {
		// post_call with no taxonomy fields populated produces empty extras.
		t.Errorf("expected no extras for bare post_call, got %s", string(out))
	}
}
