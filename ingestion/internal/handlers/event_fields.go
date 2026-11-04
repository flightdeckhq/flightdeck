package handlers

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// Field names are case-sensitive. The worker decodes an event into typed
// structs, its EventPayload and, under incoming_message and
// outgoing_message, its SubagentMessage (workers/internal/consumer), and
// Go's JSON decoder matches an object key to a struct field ignoring
// case. Ingestion checks each field under its exact name, so without
// checkFieldNameCase a key such as "TOKENS_INPUT" or "Streaming" would
// pass every check here and still reach the worker as tokens_input or
// streaming. The names below are the event schema those checks read; a
// parity test pins the top level and the sub-agent messages to the
// worker's struct tags, and the streaming block and the llm_error error
// object to the sensor, which builds them.

// eventFieldNames are the top-level fields of an event: the JSON names of
// the worker's EventPayload.
var eventFieldNames = []string{
	"id", "session_id", "flavor", "agent_type", "agent_id", "agent_name",
	"client_type", "user", "hostname", "event_type", "host", "framework",
	"model", "tokens_input", "tokens_output", "tokens_total",
	"tokens_cache_read", "tokens_cache_creation", "tokens_reasoning",
	"model_requested", "model_served", "provider", "billing_mode",
	"cost_reported", "cost_source", "tokens_cache_creation_1h",
	"service_tier", "speed", "inference_geo", "inference_scope",
	"server_tool_use", "stop_reason", "effort", "tokens_used_session",
	"token_limit_session", "latency_ms", "tool_name", "tool_use_id",
	"has_content", "content", "capture_prompts", "timestamp",
	"directive_name", "directive_action", "directive_status", "result",
	"error", "duration_ms", "streaming", "source", "threshold_pct",
	"tokens_used", "token_limit", "from_model", "to_model",
	"intended_model", "context", "token_id", "token_name", "server_name",
	"transport", "count", "arguments", "resource_uri", "content_bytes",
	"mime_type", "prompt_name", "rendered", "mcp_server",
	"parent_session_id", "agent_role", "incoming_message",
	"outgoing_message", "state", "server_url", "fingerprint", "policy_id",
	"scope", "decision_path", "block_on_uncertainty",
	"server_url_canonical", "fingerprint_old", "fingerprint_new",
	"name_old", "name_new", "decided_at", "permission_mode", "signal",
	"signal_data", "protocol_version", "version", "capabilities",
	"instructions", "attached_at", "policy_decision",
	"originating_event_id", "originating_call_context", "item_names",
	"truncated", "sensor_version", "interceptor_versions",
	"policy_snapshot", "close_reason", "end_reason",
	"policy_actions_summary", "last_event_id", "policy_decision_at_attach",
	"policy_entries_orphaned", "estimated_via", "provider_metadata",
	"policy_decision_pre", "policy_decision_post", "output_dimensions",
	"retry_attempt", "terminal",
}

// subagentMessageFieldNames are the fields of an incoming_message or an
// outgoing_message: the JSON names of the worker's SubagentMessage.
var subagentMessageFieldNames = []string{"body", "captured_at", "has_content", "content_bytes"}

// streamingFieldNames are the fields of a streaming block; its
// inter_chunk_ms object holds streamTimingKeys.
var streamingFieldNames = []string{"ttft_ms", "chunk_count", "inter_chunk_ms", "final_outcome", "abort_reason"}

// llmErrorFieldNames are the fields of an llm_error's error object: the
// classification every emitter sends, then a failed stream's fields.
var llmErrorFieldNames = append([]string{
	"error_type", "provider", "http_status", "provider_error_code",
	"error_message", "request_id", "retry_after", "is_retryable",
	"abort_reason",
}, streamPartialCountKeys...)

// fieldNames is one object level of the event schema: its field names,
// the same names in folded form, and the levels nested under its fields.
type fieldNames struct {
	exact  map[string]bool
	byFold map[string]string
	nested map[string]*fieldNames
}

func newFieldNames(names []string, nested map[string]*fieldNames) *fieldNames {
	f := &fieldNames{
		exact:  make(map[string]bool, len(names)),
		byFold: make(map[string]string, len(names)),
		nested: nested,
	}
	for _, name := range names {
		f.exact[name] = true
		f.byFold[foldName(name)] = name
	}
	return f
}

var (
	subagentMessageFields = newFieldNames(subagentMessageFieldNames, nil)
	// eventFields is the top level with the objects nested under it whose
	// fields the worker decodes into a struct or ingestion checks.
	eventFields = newFieldNames(eventFieldNames, map[string]*fieldNames{
		"streaming": newFieldNames(streamingFieldNames, map[string]*fieldNames{
			"inter_chunk_ms": newFieldNames(streamTimingKeys, nil),
		}),
		"incoming_message": subagentMessageFields,
		"outgoing_message": subagentMessageFields,
	})
	// llmErrorFields is an llm_error's error object, which ingestion
	// checks on that event type only; an MCP event's and a tool
	// failure's error carry fields of their own.
	llmErrorFields = newFieldNames(llmErrorFieldNames, nil)
)

// checkFieldNameCase refuses a key that is not a field name but matches
// one under the case folding Go's JSON decoder applies, at the top level,
// in the objects nested under it that eventFields lists and, on an
// llm_error, in its error object. Any other key is left as it is. It
// returns an error message naming the key and the field, or "" when
// every key is exact; when several keys are variants, the message names
// the first in sorted order.
func checkFieldNameCase(payload map[string]any, eventType string) string {
	variants := eventFields.variants(payload, "", nil)
	if eventType == "llm_error" {
		if errObj, ok := payload["error"].(map[string]any); ok {
			variants = llmErrorFields.variants(errObj, "error.", variants)
		}
	}
	if len(variants) == 0 {
		return ""
	}
	sort.Strings(variants)
	return variants[0]
}

// variants appends a message for each key of obj that folds to one of
// f's field names without being it, and descends into the nested levels
// of the fields obj holds as objects.
func (f *fieldNames) variants(obj map[string]any, prefix string, out []string) []string {
	for key, value := range obj {
		if f.exact[key] {
			if sub := f.nested[key]; sub != nil {
				if inner, isObj := value.(map[string]any); isObj {
					out = sub.variants(inner, prefix+key+".", out)
				}
			}
			continue
		}
		if name, ok := f.byFold[foldName(key)]; ok {
			out = append(out, fmt.Sprintf(
				"%q is not a field name; field names are case-sensitive, and the field is %q",
				prefix+key, prefix+name,
			))
		}
	}
	return out
}

// foldName is name in the form Go's JSON decoder compares when it
// matches a key to a struct field: each rune becomes the smallest rune of
// its Unicode simple-fold orbit, so two names fold alike exactly when
// strings.EqualFold reports them equal. That covers more than ASCII case:
// the Kelvin sign folds with k and the long s with s.
func foldName(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		b.WriteRune(foldRune(r))
	}
	return b.String()
}

func foldRune(r rune) rune {
	for {
		next := unicode.SimpleFold(r)
		if next <= r {
			return next
		}
		r = next
	}
}
