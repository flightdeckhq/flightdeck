package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
)

// streamedPostCall is a post_call for a stream the caller left early, as
// the sensor's stream guard reports it.
func streamedPostCall() map[string]any {
	return map[string]any{
		"session_id":    "22222222-2222-4222-8222-222222222222",
		"agent_id":      "11111111-1111-4111-8111-111111111111",
		"agent_type":    "production",
		"client_type":   "flightdeck_sensor",
		"event_type":    "post_call",
		"model":         "claude-sonnet-4-5",
		"tokens_input":  1200,
		"tokens_output": 90,
		"tokens_total":  1290,
		"streaming": map[string]any{
			"ttft_ms":        142,
			"chunk_count":    38,
			"inter_chunk_ms": map[string]any{"p50": 12, "p95": 47, "max": 109},
			"final_outcome":  "aborted",
			"abort_reason":   "client_aborted",
		},
	}
}

// failedStreamError is an llm_error for a stream that failed after the
// provider had delivered usage, as the sensor's stream guard reports it.
func failedStreamError() map[string]any {
	return map[string]any{
		"session_id":    "22222222-2222-4222-8222-222222222222",
		"agent_id":      "11111111-1111-4111-8111-111111111111",
		"agent_type":    "production",
		"client_type":   "flightdeck_sensor",
		"event_type":    "llm_error",
		"model":         "claude-sonnet-4-5",
		"tokens_input":  nil,
		"tokens_output": nil,
		"tokens_total":  nil,
		"retry_attempt": 1,
		"terminal":      false,
		"error": map[string]any{
			"error_type":            "stream_error",
			"provider":              "anthropic",
			"http_status":           nil,
			"provider_error_code":   nil,
			"error_message":         "APIError",
			"request_id":            nil,
			"retry_after":           nil,
			"is_retryable":          true,
			"abort_reason":          "error_mid_stream",
			"partial_chunks":        12,
			"partial_tokens_input":  1500,
			"partial_tokens_output": 240,
		},
	}
}

// postCapturing posts body through the events handler and returns the
// status, the response body and what reached the bus (nil when nothing
// was published).
func postCapturing(t *testing.T, body []byte) (int, string, []byte) {
	t.Helper()
	pub := &mockPublisher{}
	handler := handlers.EventsHandler(
		&mockValidator{valid: true, id: "tok-id", name: "tok-name"},
		pub,
		&mockDirStore{},
		nil,
		nil,
	)
	req := httptest.NewRequest("POST", "/v1/events", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer t")
	w := httptest.NewRecorder()
	handler(w, req)
	if len(pub.published) == 0 {
		return w.Code, w.Body.String(), nil
	}
	return w.Code, w.Body.String(), pub.published[0]
}

// streamField is one field the stream validation covers: the event it
// sits on and the path to it in the payload.
type streamField struct {
	base func() map[string]any
	path []string
}

// objectAt walks path's parents in payload and returns the innermost
// object and the field's key.
func objectAt(t *testing.T, payload map[string]any, path []string) (map[string]any, string) {
	t.Helper()
	obj := payload
	for _, key := range path[:len(path)-1] {
		next, ok := obj[key].(map[string]any)
		if !ok {
			t.Fatalf("payload has no object at %q", key)
		}
		obj = next
	}
	return obj, path[len(path)-1]
}

// valueAt is the field's value in a published payload and whether it is
// there.
func valueAt(t *testing.T, published []byte, path []string) (any, bool) {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(published, &decoded); err != nil {
		t.Fatalf("published payload is not JSON: %v", err)
	}
	obj, key := objectAt(t, decoded, path)
	v, ok := obj[key]
	return v, ok
}

type streamCase struct {
	name string
	// value is set at the field's path; absent removes the field.
	value  any
	absent bool
	// wantStatus is the response status. For 200, wantStored is what
	// the published payload holds at the path (nil with wantGone means
	// the key is absent); for 400, wantError is in the error body.
	wantStatus int
	wantStored any
	wantGone   bool
	wantError  string
}

func runStreamCases(t *testing.T, field streamField, cases []streamCase) {
	t.Helper()
	label := strings.Join(field.path, ".")
	for _, tc := range cases {
		t.Run(label+"/"+tc.name, func(t *testing.T) {
			payload := field.base()
			obj, key := objectAt(t, payload, field.path)
			if tc.absent {
				delete(obj, key)
			} else {
				obj[key] = tc.value
			}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			code, resp, published := postCapturing(t, body)
			if code != tc.wantStatus {
				t.Fatalf("status %d, want %d (body %s)", code, tc.wantStatus, resp)
			}
			if tc.wantStatus != http.StatusOK {
				if published != nil {
					t.Errorf("a refused event reached the bus: %s", published)
				}
				if !strings.Contains(resp, tc.wantError) {
					t.Errorf("error body %s does not name %q", resp, tc.wantError)
				}
				return
			}
			stored, present := valueAt(t, published, field.path)
			if tc.wantGone {
				if present {
					t.Errorf("%s published as %v, want it absent", label, stored)
				}
				return
			}
			want, _ := json.Marshal(tc.wantStored)
			got, _ := json.Marshal(stored)
			if !bytes.Equal(want, got) {
				t.Errorf("%s published as %s, want %s", label, got, want)
			}
		})
	}
}

// enumCases covers a stream outcome or abort reason: each vocabulary
// value is kept, an unknown one is stored as other, a value that is not
// a string is refused, and null or absent passes through.
func enumCases(valid []string, unknown string, wantError string) []streamCase {
	cases := make([]streamCase, 0, len(valid)+6)
	for _, v := range valid {
		cases = append(cases, streamCase{name: "valid " + v, value: v, wantStatus: http.StatusOK, wantStored: v})
	}
	return append(cases,
		streamCase{name: "catch-all kept", value: "other", wantStatus: http.StatusOK, wantStored: "other"},
		streamCase{name: "unknown stored as other", value: unknown, wantStatus: http.StatusOK, wantStored: "other"},
		streamCase{name: "empty stored as other", value: "", wantStatus: http.StatusOK, wantStored: "other"},
		streamCase{name: "number refused", value: -1, wantStatus: http.StatusBadRequest, wantError: wantError},
		streamCase{name: "object refused", value: map[string]any{"v": "aborted"}, wantStatus: http.StatusBadRequest, wantError: wantError},
		streamCase{name: "null passes", value: nil, wantStatus: http.StatusOK, wantStored: nil},
		streamCase{name: "absent passes", absent: true, wantStatus: http.StatusOK, wantGone: true},
	)
}

// countCases covers a count: a non-negative integer up to 2^53 is kept,
// a negative, fractional, oversized or non-numeric value is refused, and
// null or absent passes through.
func countCases(valid float64, wantError string) []streamCase {
	return []streamCase{
		{name: "valid", value: valid, wantStatus: http.StatusOK, wantStored: valid},
		{name: "zero", value: 0, wantStatus: http.StatusOK, wantStored: 0},
		{name: "2^53 kept", value: float64(1 << 53), wantStatus: http.StatusOK, wantStored: float64(1 << 53)},
		{name: "negative refused", value: -1, wantStatus: http.StatusBadRequest, wantError: wantError},
		{name: "fractional refused", value: 1.5, wantStatus: http.StatusBadRequest, wantError: wantError},
		{name: "above 2^53 refused", value: 1e17, wantStatus: http.StatusBadRequest, wantError: wantError},
		{name: "string refused", value: "12", wantStatus: http.StatusBadRequest, wantError: wantError},
		{name: "null passes", value: nil, wantStatus: http.StatusOK, wantStored: nil},
		{name: "absent passes", absent: true, wantStatus: http.StatusOK, wantGone: true},
	}
}

// timingCases covers a timing in milliseconds: a non-negative number,
// fractional or not, is kept; a negative or non-numeric value is
// refused; null or absent passes through.
func timingCases(wantError string) []streamCase {
	return []streamCase{
		{name: "valid", value: 47, wantStatus: http.StatusOK, wantStored: 47},
		{name: "fractional", value: 12.5, wantStatus: http.StatusOK, wantStored: 12.5},
		{name: "zero", value: 0, wantStatus: http.StatusOK, wantStored: 0},
		{name: "negative refused", value: -3, wantStatus: http.StatusBadRequest, wantError: wantError},
		{name: "string refused", value: "47", wantStatus: http.StatusBadRequest, wantError: wantError},
		{name: "null passes", value: nil, wantStatus: http.StatusOK, wantStored: nil},
		{name: "absent passes", absent: true, wantStatus: http.StatusOK, wantGone: true},
	}
}

func TestStreamingFields_FinalOutcome(t *testing.T) {
	runStreamCases(t,
		streamField{base: streamedPostCall, path: []string{"streaming", "final_outcome"}},
		enumCases([]string{"completed", "aborted"}, "truncated", "streaming.final_outcome must be a string"),
	)
}

func TestStreamingFields_PostCallAbortReason(t *testing.T) {
	runStreamCases(t,
		streamField{base: streamedPostCall, path: []string{"streaming", "abort_reason"}},
		enumCases(
			[]string{"client_aborted", "error_before_stream", "error_mid_stream", "timeout"},
			"user_cancelled", "streaming.abort_reason must be a string",
		),
	)
}

func TestStreamingFields_LLMErrorAbortReason(t *testing.T) {
	runStreamCases(t,
		streamField{base: failedStreamError, path: []string{"error", "abort_reason"}},
		enumCases(
			[]string{"error_before_stream", "error_mid_stream", "timeout", "client_aborted"},
			"connection_reset", "error.abort_reason must be a string",
		),
	)
}

// llmErrorTaxonomy is the 14-entry llm_error error_type vocabulary
// (ARCHITECTURE.md, llm_error).
var llmErrorTaxonomy = []string{
	"rate_limit", "quota_exceeded", "context_overflow", "content_filter",
	"invalid_request", "authentication", "permission", "not_found",
	"request_too_large", "api_error", "overloaded", "timeout",
	"stream_error",
}

func TestStreamingFields_LLMErrorType(t *testing.T) {
	runStreamCases(t,
		streamField{base: failedStreamError, path: []string{"error", "error_type"}},
		enumCases(llmErrorTaxonomy, "billing_hold", "error.error_type must be a string"),
	)
}

// An MCP event's error_type is the MCP taxonomy and a tool failure's is
// its own: neither is read as an llm_error type.
func TestStreamingFields_OtherErrorTaxonomiesPublishedAsSent(t *testing.T) {
	for _, eventType := range []string{"mcp_tool_call", "tool_call"} {
		payload := failedStreamError()
		payload["event_type"] = eventType
		payload["error"] = map[string]any{"error_type": "invalid_params", "error_class": "McpError"}
		body, _ := json.Marshal(payload)
		code, resp, published := postCapturing(t, body)
		if code != http.StatusOK {
			t.Fatalf("%s: status %d, want 200 (body %s)", eventType, code, resp)
		}
		if !bytes.Equal(published, body) {
			t.Errorf("%s was changed on the way to the bus:\n got %s\nwant %s", eventType, published, body)
		}
	}
}

func TestStreamingFields_PartialCounts(t *testing.T) {
	for _, key := range []string{"partial_chunks", "partial_tokens_input", "partial_tokens_output"} {
		runStreamCases(t,
			streamField{base: failedStreamError, path: []string{"error", key}},
			countCases(240, "error."+key+" must be a non-negative integer"),
		)
	}
}

func TestStreamingFields_ChunkCount(t *testing.T) {
	runStreamCases(t,
		streamField{base: streamedPostCall, path: []string{"streaming", "chunk_count"}},
		countCases(38, "streaming.chunk_count must be a non-negative integer"),
	)
}

func TestStreamingFields_Timings(t *testing.T) {
	runStreamCases(t,
		streamField{base: streamedPostCall, path: []string{"streaming", "ttft_ms"}},
		timingCases("streaming.ttft_ms must be a non-negative number"),
	)
	for _, key := range []string{"p50", "p95", "max"} {
		runStreamCases(t,
			streamField{base: streamedPostCall, path: []string{"streaming", "inter_chunk_ms", key}},
			timingCases("streaming.inter_chunk_ms."+key+" must be a non-negative number"),
		)
	}
}

func TestStreamingFields_Containers(t *testing.T) {
	runStreamCases(t,
		streamField{base: streamedPostCall, path: []string{"streaming"}},
		[]streamCase{
			{name: "string refused", value: "completed", wantStatus: http.StatusBadRequest, wantError: "streaming must be an object"},
			{name: "array refused", value: []any{"completed"}, wantStatus: http.StatusBadRequest, wantError: "streaming must be an object"},
			{name: "null passes", value: nil, wantStatus: http.StatusOK, wantStored: nil},
			{name: "absent passes", absent: true, wantStatus: http.StatusOK, wantGone: true},
		},
	)
	runStreamCases(t,
		streamField{base: streamedPostCall, path: []string{"streaming", "inter_chunk_ms"}},
		[]streamCase{
			{name: "number refused", value: 12, wantStatus: http.StatusBadRequest, wantError: "streaming.inter_chunk_ms must be an object"},
			{name: "null passes", value: nil, wantStatus: http.StatusOK, wantStored: nil},
		},
	)
	runStreamCases(t,
		streamField{base: failedStreamError, path: []string{"error"}},
		[]streamCase{
			{name: "string refused", value: "boom", wantStatus: http.StatusBadRequest, wantError: "error must be an object on llm_error"},
			{name: "null passes", value: nil, wantStatus: http.StatusOK, wantStored: nil},
			{name: "absent passes", absent: true, wantStatus: http.StatusOK, wantGone: true},
		},
	)
}

// The error object's stream fields are an llm_error's; the same keys
// elsewhere, and the directive_result's plain-string error, are not
// read.
func TestStreamingFields_ErrorFieldsCheckedOnLLMErrorOnly(t *testing.T) {
	directive := failedStreamError()
	directive["event_type"] = "directive_result"
	directive["error"] = "handler raised"
	toolCall := failedStreamError()
	toolCall["event_type"] = "tool_call"
	toolCall["error"] = map[string]any{"error_type": "other", "partial_tokens_input": -1, "abort_reason": 5}
	for name, payload := range map[string]map[string]any{"directive_result": directive, "tool_call": toolCall} {
		body, _ := json.Marshal(payload)
		if code, resp, _ := postCapturing(t, body); code != http.StatusOK {
			t.Errorf("%s: status %d, want 200 (body %s)", name, code, resp)
		}
	}
}

// A replaced value leaves the rest of the event as it was: the tokens
// still reach the bus.
func TestStreamingFields_ReplacementKeepsTheRestOfTheEvent(t *testing.T) {
	payload := failedStreamError()
	payload["error"].(map[string]any)["abort_reason"] = "connection_reset"
	body, _ := json.Marshal(payload)
	code, resp, published := postCapturing(t, body)
	if code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", code, resp)
	}
	var got map[string]any
	if err := json.Unmarshal(published, &got); err != nil {
		t.Fatalf("published payload is not JSON: %v", err)
	}
	errObj := got["error"].(map[string]any)
	if errObj["abort_reason"] != "other" {
		t.Errorf("abort_reason published as %v, want other", errObj["abort_reason"])
	}
	for key, want := range map[string]float64{"partial_chunks": 12, "partial_tokens_input": 1500, "partial_tokens_output": 240} {
		if errObj[key] != want {
			t.Errorf("error.%s published as %v, want %v", key, errObj[key], want)
		}
	}
	if errObj["error_type"] != "stream_error" || got["session_id"] != payload["session_id"] {
		t.Errorf("published payload lost fields: %s", published)
	}
}

// An event with every value in its vocabulary is published exactly as it
// arrived: no re-encoding on the hot path.
func TestStreamingFields_KnownValuesPublishedVerbatim(t *testing.T) {
	for name, payload := range map[string]map[string]any{
		"post_call": streamedPostCall(),
		"llm_error": failedStreamError(),
	} {
		body, _ := json.Marshal(payload)
		// Indent so a re-encoding would show as a byte difference.
		var indented bytes.Buffer
		if err := json.Indent(&indented, body, "", "  "); err != nil {
			t.Fatalf("indent: %v", err)
		}
		code, resp, published := postCapturing(t, indented.Bytes())
		if code != http.StatusOK {
			t.Fatalf("%s: status %d, want 200 (body %s)", name, code, resp)
		}
		if !bytes.Equal(published, indented.Bytes()) {
			t.Errorf("%s was re-encoded:\n got %s\nwant %s", name, published, indented.Bytes())
		}
	}
}
