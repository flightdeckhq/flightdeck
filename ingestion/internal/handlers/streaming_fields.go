package handlers

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// unrecognisedStreamValue is what ingestion stores in place of a stream
// outcome or abort reason outside its vocabulary. The values are
// diagnostics, and a sensor newer than the server may send one added
// after it was built; refusing the event would also drop the tokens it
// carries, so the value is kept as this catch-all, the fallback the
// llm_error taxonomy's error_type uses for an error it cannot name.
const unrecognisedStreamValue = "other"

// Vocabularies of the stream diagnostics (ARCHITECTURE.md, post_call and
// llm_error). final_outcome is on a post_call's streaming block;
// abort_reason is there too (client_aborted) and on a failed stream's
// llm_error error object (the other three). Each includes the catch-all,
// so a stored value read back and posted again is accepted as it is.
var (
	validFinalOutcomes = map[string]bool{
		"completed":             true,
		"aborted":               true,
		unrecognisedStreamValue: true,
	}
	validAbortReasons = map[string]bool{
		"client_aborted":        true,
		"error_before_stream":   true,
		"error_mid_stream":      true,
		"timeout":               true,
		unrecognisedStreamValue: true,
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
// the stream-failure fields of an llm_error's error object. Null counts as
// absent throughout. The block must be an object, the outcome and abort
// reasons strings, the counts non-negative integers and the timings
// non-negative numbers. A string outside its vocabulary passes here;
// normalizeStreamingValues replaces it once the event is accepted. It
// returns an error message, or "" when the fields are valid.
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
	if msg := checkStringField(errObj, "error.", "abort_reason"); msg != "" {
		return msg
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

// normalizeStreamingValues replaces each stream outcome or abort reason
// outside its vocabulary with unrecognisedStreamValue, and counts and
// logs the replacement. It runs on a payload validateEventPayload
// accepted, so every value it meets is a string or absent. It reports
// whether it changed the payload, which the caller then re-encodes. The
// OTLP receiver builds its streaming blocks from the vocabulary itself,
// so only a posted event can need it.
func normalizeStreamingValues(payload map[string]any) bool {
	changed := false
	if block, ok := payload["streaming"].(map[string]any); ok {
		if normalizeStreamValue(block, "streaming.final_outcome", "final_outcome", validFinalOutcomes) {
			changed = true
		}
		if normalizeStreamValue(block, "streaming.abort_reason", "abort_reason", validAbortReasons) {
			changed = true
		}
	}
	if payload["event_type"] == "llm_error" {
		if errObj, ok := payload["error"].(map[string]any); ok {
			if normalizeStreamValue(errObj, "error.abort_reason", "abort_reason", validAbortReasons) {
				changed = true
			}
		}
	}
	return changed
}

func normalizeStreamValue(obj map[string]any, field, key string, valid map[string]bool) bool {
	s, ok := obj[key].(string)
	if !ok || valid[s] {
		return false
	}
	obj[key] = unrecognisedStreamValue
	streamValueReplacements.note(field, s)
	return true
}

// streamValueReplacements counts the values normalizeStreamingValues
// replaced in this process and rate-limits the warning about them. The
// ingestion API serves no metrics endpoint, so the warning carries the
// running count, as the publisher's lost-event error does. A sensor
// ahead of the server can send an unknown value on every streamed call,
// and one line per event would let it drive log volume.
var streamValueReplacements = newReplacementLog(time.Now)

// replacementLogInterval bounds the replacement warning to one line per
// interval per process; a second reports a new value promptly and keeps
// a client that sends one on every call to sixty lines a minute.
const replacementLogInterval = time.Second

type replacementLog struct {
	now        func() time.Time
	mu         sync.Mutex
	lastLogged time.Time
	total      int64
	suppressed int64
}

func newReplacementLog(now func() time.Time) *replacementLog {
	return &replacementLog{now: now}
}

// note counts one replacement and logs it unless a line went out less
// than replacementLogInterval ago; the next line reports how many were
// not logged in between.
func (r *replacementLog) note(field, value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.total++
	now := r.now()
	if now.Sub(r.lastLogged) < replacementLogInterval {
		r.suppressed++
		return
	}
	suppressed := r.suppressed
	r.suppressed = 0
	r.lastLogged = now
	slog.Warn("unrecognised stream value stored as "+unrecognisedStreamValue,
		"field", field,
		"value", loggableStreamValue(value),
		"replaced_total", r.total,
		"suppressed_since_last", suppressed,
	)
}

// replacedTotal is the number of values replaced in this process.
func (r *replacementLog) replacedTotal() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.total
}

// loggableStreamValue is the value as logged: a lowercase identifier of
// at most 64 characters, the form a new vocabulary word takes, is logged
// as it is; anything else is described by its length, so a client cannot
// put arbitrary text into the log through this field.
func loggableStreamValue(value string) string {
	if signalNameRegex.MatchString(value) {
		return value
	}
	return fmt.Sprintf("<%d bytes, not an identifier>", len(value))
}
