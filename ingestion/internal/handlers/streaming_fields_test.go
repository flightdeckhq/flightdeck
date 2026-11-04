package handlers

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// captureStreamLogs routes the default logger into a buffer for the test.
func captureStreamLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

// manualTimer records the flush a replacementLog schedules instead of
// starting a timer, so a test fires it when it chooses.
type manualTimer struct {
	delays []time.Duration
	fire   func()
}

func (m *manualTimer) after(d time.Duration, f func()) {
	m.delays = append(m.delays, d)
	m.fire = f
}

const replacementLogText = "unrecognised diagnostic value stored as other"

func TestReplacementLogCountsEveryReplacementAndLogsOncePerInterval(t *testing.T) {
	logs := captureStreamLogs(t)
	clock := time.Date(2026, time.November, 2, 12, 0, 0, 0, time.UTC)
	timer := &manualTimer{}
	log := newReplacementLog(func() time.Time { return clock }, timer.after)

	log.note("streaming.final_outcome", "truncated")
	log.note("error.abort_reason", "connection_reset")
	log.note("streaming.abort_reason", "user_cancelled")
	if got := log.replacedTotal(); got != 3 {
		t.Fatalf("replaced total %d, want 3", got)
	}
	if n := strings.Count(logs.String(), replacementLogText); n != 1 {
		t.Fatalf("%d lines within one interval, want 1: %q", n, logs.String())
	}
	for _, want := range []string{"field=streaming.final_outcome", "value=truncated", "replaced_total=1", "suppressed_since_last=0"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("first line lacks %q: %q", want, logs.String())
		}
	}
	if len(timer.delays) != 1 || timer.delays[0] != replacementLogInterval {
		t.Fatalf("scheduled flushes %v, want one at the interval's end", timer.delays)
	}

	// A replacement after the interval logs at once and reports the two
	// held ones; the scheduled flush then finds nothing to log.
	clock = clock.Add(replacementLogInterval)
	log.note("error.abort_reason", "socket_closed")
	if n := strings.Count(logs.String(), replacementLogText); n != 2 {
		t.Fatalf("%d lines after the interval, want 2: %q", n, logs.String())
	}
	for _, want := range []string{"value=socket_closed", "replaced_total=4", "suppressed_since_last=2"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("second line lacks %q: %q", want, logs.String())
		}
	}
	timer.fire()
	if n := strings.Count(logs.String(), replacementLogText); n != 2 {
		t.Fatalf("an empty flush logged a line: %q", logs.String())
	}

	// The empty flush is no longer pending: the next held replacement
	// schedules one of its own.
	clock = clock.Add(100 * time.Millisecond)
	log.note("error.error_type", "after_empty_flush")
	if len(timer.delays) != 2 || timer.delays[1] != replacementLogInterval-100*time.Millisecond {
		t.Fatalf("scheduled flushes %v, want a second one 900ms out", timer.delays)
	}
}

// A burst followed by silence still reaches the log: the flush scheduled
// at the interval's end names the latest held replacement and counts the
// others.
func TestReplacementLogFlushesTheTailOfABurst(t *testing.T) {
	logs := captureStreamLogs(t)
	clock := time.Date(2026, time.November, 2, 12, 0, 0, 0, time.UTC)
	timer := &manualTimer{}
	log := newReplacementLog(func() time.Time { return clock }, timer.after)

	log.note("streaming.final_outcome", "truncated")
	clock = clock.Add(300 * time.Millisecond)
	log.note("error.error_type", "billing_hold")
	log.note("error.abort_reason", "connection_reset")
	log.note("error.error_type", "quota_hold")
	if len(timer.delays) != 1 || timer.delays[0] != replacementLogInterval-300*time.Millisecond {
		t.Fatalf("scheduled flushes %v, want one, 700ms out", timer.delays)
	}

	clock = clock.Add(700 * time.Millisecond)
	timer.fire()
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("%d lines, want 2: %q", len(lines), logs.String())
	}
	for _, want := range []string{"field=error.error_type", "value=quota_hold", "replaced_total=4", "suppressed_since_last=2"} {
		if !strings.Contains(lines[1], want) {
			t.Fatalf("flush line lacks %q: %q", want, lines[1])
		}
	}

	// The flush restarted the interval: the next replacement is held and
	// schedules a new flush.
	clock = clock.Add(100 * time.Millisecond)
	log.note("error.error_type", "later")
	if len(timer.delays) != 2 {
		t.Fatalf("scheduled flushes %v, want a second one", timer.delays)
	}
	if n := strings.Count(logs.String(), replacementLogText); n != 2 {
		t.Fatalf("a replacement inside the interval logged at once: %q", logs.String())
	}
}

// A pending flush that fires after a replacement logged at once has
// restarted the interval does not write a second line right behind it:
// it moves to the end of the new interval, where it reports what was
// held since.
func TestReplacementLogFlushAfterADirectLineWaitsForItsInterval(t *testing.T) {
	logs := captureStreamLogs(t)
	start := time.Date(2026, time.November, 2, 12, 0, 0, 0, time.UTC)
	clock := start
	timer := &manualTimer{}
	log := newReplacementLog(func() time.Time { return clock }, timer.after)

	log.note("streaming.final_outcome", "first")
	clock = start.Add(500 * time.Millisecond)
	log.note("error.error_type", "held_early")
	if len(timer.delays) != 1 || timer.delays[0] != 500*time.Millisecond {
		t.Fatalf("scheduled flushes %v, want one, 500ms out", timer.delays)
	}
	staleFlush := timer.fire

	// The interval ends; a replacement logs at once and reports the held
	// one before the pending flush gets the lock, and a second
	// replacement in the same instant is held.
	clock = start.Add(replacementLogInterval)
	log.note("error.abort_reason", "direct_again")
	log.note("error.error_type", "held_late")
	if n := strings.Count(logs.String(), replacementLogText); n != 2 {
		t.Fatalf("%d lines, want 2: %q", n, logs.String())
	}
	if len(timer.delays) != 1 {
		t.Fatalf("a held replacement scheduled a flush while one was pending: %v", timer.delays)
	}

	// The pending flush gets the lock a little after the direct line.
	clock = start.Add(replacementLogInterval + 200*time.Millisecond)
	staleFlush()
	if n := strings.Count(logs.String(), replacementLogText); n != 2 {
		t.Fatalf("the pending flush logged right after the direct line: %q", logs.String())
	}
	if len(timer.delays) != 2 || timer.delays[1] != 800*time.Millisecond {
		t.Fatalf("scheduled flushes %v, want the flush re-armed for the direct line's interval end, 800ms out", timer.delays)
	}
	log.mu.Lock()
	pending := log.flushPending
	log.mu.Unlock()
	if !pending {
		t.Fatal("the re-armed flush is not marked pending")
	}

	clock = start.Add(2 * replacementLogInterval)
	timer.fire()
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("%d lines, want 3: %q", len(lines), logs.String())
	}
	for _, want := range []string{"value=held_late", "replaced_total=4", "suppressed_since_last=0"} {
		if !strings.Contains(lines[2], want) {
			t.Fatalf("flush line lacks %q: %q", want, lines[2])
		}
	}
	for _, want := range []string{"value=direct_again", "replaced_total=3", "suppressed_since_last=1"} {
		if !strings.Contains(lines[1], want) {
			t.Fatalf("direct line lacks %q: %q", want, lines[1])
		}
	}
}

func TestLoggableValueKeepsOnlyIdentifiers(t *testing.T) {
	cases := map[string]string{
		"error_after_stream":       "error_after_stream",
		"Truncated":                "<9 bytes, not an identifier>",
		"ignore previous; rm -rf":  "<23 bytes, not an identifier>",
		strings.Repeat("a", 65):    "<65 bytes, not an identifier>",
		"":                         "<0 bytes, not an identifier>",
		"timeout\nlevel=ERROR msg": "<23 bytes, not an identifier>",
	}
	for value, want := range cases {
		if got := loggableValue(value); got != want {
			t.Errorf("loggableValue(%q) = %q, want %q", value, got, want)
		}
	}
}

// normalizeDiagnosticValues counts each value it replaces in the process
// counter, returns an edit per replacement, and keeps known values.
func TestNormalizeDiagnosticValuesCountsReplacements(t *testing.T) {
	captureStreamLogs(t)
	before := diagnosticReplacements.replacedTotal()
	payload := map[string]any{
		"event_type": "llm_error",
		"streaming":  map[string]any{"final_outcome": "truncated", "abort_reason": "client_aborted"},
		"error":      map[string]any{"abort_reason": "connection_reset", "error_type": "billing_hold"},
	}
	edits := normalizeDiagnosticValues(payload)
	var paths []string
	for _, e := range edits {
		if e.value != unrecognisedValue {
			t.Errorf("edit %v sets %v, want %q", e.path, e.value, unrecognisedValue)
		}
		paths = append(paths, strings.Join(e.path, "."))
	}
	if got := strings.Join(paths, ","); got != "streaming.final_outcome,error.error_type,error.abort_reason" {
		t.Errorf("edits %s, want the three replaced fields", got)
	}
	if got := diagnosticReplacements.replacedTotal() - before; got != 3 {
		t.Errorf("counted %d replacements, want 3", got)
	}
	stream := payload["streaming"].(map[string]any)
	if stream["final_outcome"] != "other" || stream["abort_reason"] != "client_aborted" {
		t.Errorf("streaming block %v, want final_outcome other and abort_reason kept", stream)
	}

	before = diagnosticReplacements.replacedTotal()
	if again := normalizeDiagnosticValues(payload); len(again) != 0 {
		t.Errorf("a payload already normalised was changed again: %v", again)
	}
	if got := diagnosticReplacements.replacedTotal() - before; got != 0 {
		t.Errorf("counted %d replacements of known values, want 0", got)
	}
}

// Only an llm_error's error object is read: an MCP event's error_type is
// the MCP taxonomy (invalid_params, connection_closed, ...), and a tool
// failure's is its own.
func TestNormalizeDiagnosticValuesLeavesOtherErrorObjects(t *testing.T) {
	for _, eventType := range []string{"tool_call", "mcp_tool_call", "mcp_resource_read"} {
		payload := map[string]any{
			"event_type": eventType,
			"error":      map[string]any{"abort_reason": "whatever", "error_type": "invalid_params"},
		}
		if edits := normalizeDiagnosticValues(payload); len(edits) != 0 {
			t.Fatalf("a %s error object was normalised: %v", eventType, edits)
		}
		errObj := payload["error"].(map[string]any)
		if errObj["abort_reason"] != "whatever" || errObj["error_type"] != "invalid_params" {
			t.Errorf("%s error changed: %v", eventType, errObj)
		}
	}
}

// patchJSON rewrites only the edited fields: every other value is kept,
// numbers that float64 cannot hold included.
func TestPatchJSONKeepsEveryOtherValueAndNumberLiteral(t *testing.T) {
	body := []byte(`{"event_type":"post_call","tokens_total":5.0,` +
		`"streaming":{"final_outcome":"truncated","ttft_ms":12.500000000000000001,"chunk_count":38},` +
		`"content":{"channel_id":1234567890123456789,"ratio":0.30000000000000001665,"text":"a<b>&c"}}`)
	out, err := patchJSON(body, []rawEdit{
		{path: []string{"streaming", "final_outcome"}, value: "other"},
		{path: []string{"token_id"}, value: "tok-1"},
	})
	if err != nil {
		t.Fatalf("patchJSON: %v", err)
	}
	for _, literal := range []string{
		`1234567890123456789`, `0.30000000000000001665`, `"tokens_total":5.0`,
		`12.500000000000000001`, `"chunk_count":38`, `"final_outcome":"other"`, `"token_id":"tok-1"`,
	} {
		if !bytes.Contains(out, []byte(literal)) {
			t.Errorf("patched body lacks %s: %s", literal, out)
		}
	}
	var before, after map[string]any
	if err := json.Unmarshal(body, &before); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if err := json.Unmarshal(out, &after); err != nil {
		t.Fatalf("decode patched body: %v", err)
	}
	if after["content"].(map[string]any)["text"] != "a<b>&c" {
		t.Errorf("content text changed: %v", after["content"])
	}
	if len(after) != len(before)+1 {
		t.Errorf("patched body has %d fields, want %d", len(after), len(before)+1)
	}
}

// The bytes that change without changing a value are exactly the ones
// patchJSON's comment and ARCHITECTURE.md name: the five characters Go's
// encoder escapes in a string, insignificant whitespace, and the order of
// the keys of the top level and the edited object. An object nobody
// edited keeps its key order.
func TestPatchJSONChangesOnlyTheDocumentedSpelling(t *testing.T) {
	body := []byte("{ \"z\" : \"a<b>&c\u2028d\u2029e \\u00e9\" , " +
		"\"streaming\" : { \"ttft_ms\" : 1.50 , \"final_outcome\" : \"truncated\" } , " +
		"\"content\" : { \"y\" : 1 , \"b\" : [ 1 , 2 ] } }")
	out, err := patchJSON(body, []rawEdit{{path: []string{"streaming", "final_outcome"}, value: "other"}})
	if err != nil {
		t.Fatalf("patchJSON: %v", err)
	}
	want := `{"content":{"y":1,"b":[1,2]},` +
		`"streaming":{"final_outcome":"other","ttft_ms":1.50},` +
		`"z":"a\u003cb\u003e\u0026c\u2028d\u2029e \u00e9"}`
	if string(out) != want {
		t.Fatalf("patched body\n got %s\nwant %s", out, want)
	}
}

func TestPatchJSONRefusesAPathItCannotEdit(t *testing.T) {
	body := []byte(`{"streaming":null,"error":"boom"}`)
	for _, path := range [][]string{{"streaming", "final_outcome"}, {"error", "abort_reason"}, {"a", "b", "c"}} {
		if _, err := patchJSON(body, []rawEdit{{path: path, value: "other"}}); err == nil {
			t.Errorf("patchJSON edited %v in %s", path, body)
		}
	}
}
