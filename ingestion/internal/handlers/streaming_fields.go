package handlers

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// unrecognisedValue is what ingestion stores in place of a stream
// outcome, an abort reason or an llm_error type outside its vocabulary.
// The values are diagnostics, and a client newer than the server may
// send one added after it was built; refusing the event would also drop
// the tokens it carries, so the value is kept as this catch-all, the
// fallback the llm_error taxonomy's error_type uses for an error it
// cannot name.
const unrecognisedValue = "other"

// Vocabularies of the diagnostics (ARCHITECTURE.md, post_call and
// llm_error). final_outcome is on a post_call's streaming block;
// abort_reason is there too (client_aborted) and on a failed stream's
// llm_error error object (the other three), beside the error_type every
// llm_error carries. Each includes the catch-all, so a stored value read
// back and posted again is accepted as it is.
var (
	validFinalOutcomes = map[string]bool{
		"completed":       true,
		"aborted":         true,
		unrecognisedValue: true,
	}
	validAbortReasons = map[string]bool{
		"client_aborted":      true,
		"error_before_stream": true,
		"error_mid_stream":    true,
		"timeout":             true,
		unrecognisedValue:     true,
	}
	// validLLMErrorTypes is the llm_error taxonomy: every value the
	// sensor's classifier, the Claude Code plugin's StopFailure mapping
	// and the OTLP dialect's api_error mapping send, which a parity test
	// pins.
	validLLMErrorTypes = map[string]bool{
		"rate_limit":        true,
		"quota_exceeded":    true,
		"context_overflow":  true,
		"content_filter":    true,
		"invalid_request":   true,
		"authentication":    true,
		"permission":        true,
		"not_found":         true,
		"request_too_large": true,
		"api_error":         true,
		"overloaded":        true,
		"timeout":           true,
		"stream_error":      true,
		unrecognisedValue:   true,
	}
)

// streamTimingKeys are the inter_chunk_ms statistics, in milliseconds.
var streamTimingKeys = []string{"p50", "p95", "max"}

// streamPartialCountKeys are the counts a failed stream's llm_error
// carries in its error object: chunks read and tokens the provider had
// delivered (and bills) before the failure.
var streamPartialCountKeys = []string{
	"partial_chunks", "partial_tokens_input", "partial_tokens_output",
}

// validateStreamingFields checks the streaming block an event carries and
// the error object of an llm_error: its type and its stream-failure
// fields. Null counts as absent throughout. The block must be an object,
// the outcome, abort reasons and error type strings, the counts
// non-negative integers and the timings non-negative numbers. A string
// outside its vocabulary passes here; normalizeDiagnosticValues replaces
// it once the event is accepted. It returns an error message, or "" when
// the fields are valid.
func validateStreamingFields(payload map[string]any, eventType string) string {
	if raw, ok := present(payload, "streaming"); ok {
		block, isObj := raw.(map[string]any)
		if !isObj {
			return "streaming must be an object"
		}
		if msg := validateStreamingBlock(block); msg != "" {
			return msg
		}
	}
	if eventType != "llm_error" {
		return ""
	}
	raw, ok := present(payload, "error")
	if !ok {
		return ""
	}
	errObj, isObj := raw.(map[string]any)
	if !isObj {
		return "error must be an object on llm_error"
	}
	for _, key := range []string{"error_type", "abort_reason"} {
		if msg := checkStringField(errObj, "error.", key); msg != "" {
			return msg
		}
	}
	for _, key := range streamPartialCountKeys {
		if msg := checkCountField(errObj, "error.", key); msg != "" {
			return msg
		}
	}
	return ""
}

func validateStreamingBlock(block map[string]any) string {
	for _, key := range []string{"final_outcome", "abort_reason"} {
		if msg := checkStringField(block, "streaming.", key); msg != "" {
			return msg
		}
	}
	if msg := checkCountField(block, "streaming.", "chunk_count"); msg != "" {
		return msg
	}
	if msg := checkTimingField(block, "streaming.", "ttft_ms"); msg != "" {
		return msg
	}
	raw, ok := present(block, "inter_chunk_ms")
	if !ok {
		return ""
	}
	gaps, isObj := raw.(map[string]any)
	if !isObj {
		return "streaming.inter_chunk_ms must be an object"
	}
	for _, key := range streamTimingKeys {
		if msg := checkTimingField(gaps, "streaming.inter_chunk_ms.", key); msg != "" {
			return msg
		}
	}
	return ""
}

// checkStringField rejects a value under key that is set and not a
// string; prefix names the object it sits in.
func checkStringField(obj map[string]any, prefix, key string) string {
	v, ok := present(obj, key)
	if !ok {
		return ""
	}
	if _, isStr := v.(string); !isStr {
		return fmt.Sprintf("%s%s must be a string", prefix, key)
	}
	return ""
}

// checkCountField rejects a value under key that is set and not a whole
// number in [0, maxTokenCount].
func checkCountField(obj map[string]any, prefix, key string) string {
	v, ok := present(obj, key)
	if !ok {
		return ""
	}
	if !isCount(v) {
		return fmt.Sprintf("%s%s must be a non-negative integer", prefix, key)
	}
	return ""
}

// checkTimingField rejects a value under key that is set and not a
// non-negative number. A timing may be fractional; JSON has no infinity.
func checkTimingField(obj map[string]any, prefix, key string) string {
	v, ok := present(obj, key)
	if !ok {
		return ""
	}
	if n, isNum := v.(float64); !isNum || n < 0 {
		return fmt.Sprintf("%s%s must be a non-negative number", prefix, key)
	}
	return ""
}

// normalizeDiagnosticValues replaces each stream outcome, abort reason
// and llm_error type outside its vocabulary with unrecognisedValue, and
// counts and logs the replacement. It runs on a payload validateEventPayload
// accepted, so every value it meets is a string or absent. It returns
// one edit per replaced value, for the caller to apply to the event's
// body with patchJSON. The OTLP receiver builds its streaming blocks and
// error types from the vocabularies itself, so only a posted event can
// need it.
func normalizeDiagnosticValues(payload map[string]any) []rawEdit {
	var edits []rawEdit
	if block, ok := payload["streaming"].(map[string]any); ok {
		edits = normalizeValue(edits, block, "streaming", "final_outcome", validFinalOutcomes)
		edits = normalizeValue(edits, block, "streaming", "abort_reason", validAbortReasons)
	}
	if payload["event_type"] == "llm_error" {
		if errObj, ok := payload["error"].(map[string]any); ok {
			edits = normalizeValue(edits, errObj, "error", "error_type", validLLMErrorTypes)
			edits = normalizeValue(edits, errObj, "error", "abort_reason", validAbortReasons)
		}
	}
	return edits
}

// normalizeValue replaces obj[key], an object found under parent, when it
// is a string outside valid, and appends the matching edit.
func normalizeValue(edits []rawEdit, obj map[string]any, parent, key string, valid map[string]bool) []rawEdit {
	s, ok := obj[key].(string)
	if !ok || valid[s] {
		return edits
	}
	obj[key] = unrecognisedValue
	diagnosticReplacements.note(parent+"."+key, s)
	return append(edits, rawEdit{path: []string{parent, key}, value: unrecognisedValue})
}

// diagnosticReplacements counts the values normalizeDiagnosticValues
// replaced in this process and rate-limits the warning about them. The
// ingestion API serves no metrics endpoint, so the warning carries the
// running count, as the publisher's lost-event error does. A sensor
// ahead of the server can send an unknown value on every streamed call,
// and one line per event would let it drive log volume.
var diagnosticReplacements = newReplacementLog(time.Now, func(d time.Duration, f func()) {
	time.AfterFunc(d, f)
})

// replacementLogInterval bounds the replacement warning to one line per
// interval per process; a second reports a new value promptly and keeps
// a client that sends one on every call to sixty lines a minute.
const replacementLogInterval = time.Second

// replacementLog counts replacements and logs at most one line per
// replacementLogInterval. A replacement inside the interval is held and
// a single flush is scheduled for the interval's end, so the tail of a
// burst is logged within the interval even if no replacement follows.
// Every replacement is either named by a line or counted in exactly one
// line's suppressed_since_last.
type replacementLog struct {
	now   func() time.Time
	after func(time.Duration, func())

	mu           sync.Mutex
	lastLogged   time.Time
	total        int64
	suppressed   int64
	flushPending bool
	// heldField and heldValue are the latest replacement not logged yet,
	// which the flush names.
	heldField, heldValue string
}

func newReplacementLog(now func() time.Time, after func(time.Duration, func())) *replacementLog {
	return &replacementLog{now: now, after: after}
}

// replacementLine is one warning, built under the lock and written
// after it is released.
type replacementLine struct {
	field, value           string
	total, suppressedSince int64
}

func (l replacementLine) write() {
	slog.Warn("unrecognised diagnostic value stored as "+unrecognisedValue,
		"field", l.field,
		"value", loggableValue(l.value),
		"replaced_total", l.total,
		"suppressed_since_last", l.suppressedSince,
	)
}

// note counts one replacement and logs it, unless a line went out less
// than replacementLogInterval ago: then the replacement is held for the
// flush scheduled at the interval's end.
func (r *replacementLog) note(field, value string) {
	r.mu.Lock()
	r.total++
	now := r.now()
	if since := now.Sub(r.lastLogged); since < replacementLogInterval {
		r.suppressed++
		r.heldField, r.heldValue = field, value
		schedule := !r.flushPending
		r.flushPending = true
		r.mu.Unlock()
		if schedule {
			r.after(replacementLogInterval-since, r.flush)
		}
		return
	}
	line := replacementLine{field: field, value: value, total: r.total, suppressedSince: r.suppressed}
	r.suppressed = 0
	r.lastLogged = now
	r.mu.Unlock()
	line.write()
}

// flush logs the latest held replacement, counting the other held ones
// in suppressed_since_last. A replacement logged after the flush was
// scheduled has already reported the held ones, leaving nothing to do.
// If that line also restarted the interval and replacements were held
// after it, the flush is moved to the end of the new interval, so two
// lines are never written less than an interval apart.
func (r *replacementLog) flush() {
	r.mu.Lock()
	if r.suppressed == 0 {
		r.flushPending = false
		r.mu.Unlock()
		return
	}
	now := r.now()
	if since := now.Sub(r.lastLogged); since < replacementLogInterval {
		r.mu.Unlock()
		r.after(replacementLogInterval-since, r.flush)
		return
	}
	r.flushPending = false
	line := replacementLine{
		field: r.heldField, value: r.heldValue,
		total: r.total, suppressedSince: r.suppressed - 1,
	}
	r.suppressed = 0
	r.lastLogged = now
	r.mu.Unlock()
	line.write()
}

// replacedTotal is the number of values replaced in this process.
func (r *replacementLog) replacedTotal() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.total
}

// loggableValue is the value as logged: a lowercase identifier of
// at most 64 characters, the form a new vocabulary word takes, is logged
// as it is; anything else is described by its length, so a client cannot
// put arbitrary text into the log through this field.
func loggableValue(value string) string {
	if signalNameRegex.MatchString(value) {
		return value
	}
	return fmt.Sprintf("<%d bytes, not an identifier>", len(value))
}
