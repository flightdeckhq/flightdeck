package handlers

import (
	"bytes"
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

func TestReplacementLogCountsEveryReplacementAndLogsOncePerInterval(t *testing.T) {
	logs := captureStreamLogs(t)
	clock := time.Date(2026, time.November, 2, 12, 0, 0, 0, time.UTC)
	log := newReplacementLog(func() time.Time { return clock })

	log.note("streaming.final_outcome", "truncated")
	log.note("error.abort_reason", "connection_reset")
	log.note("streaming.abort_reason", "user_cancelled")
	if got := log.replacedTotal(); got != 3 {
		t.Fatalf("replaced total %d, want 3", got)
	}
	if n := strings.Count(logs.String(), "unrecognised diagnostic value stored as other"); n != 1 {
		t.Fatalf("%d lines within one interval, want 1: %q", n, logs.String())
	}
	for _, want := range []string{"field=streaming.final_outcome", "value=truncated", "replaced_total=1", "suppressed_since_last=0"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("first line lacks %q: %q", want, logs.String())
		}
	}

	clock = clock.Add(replacementLogInterval)
	log.note("error.abort_reason", "socket_closed")
	if n := strings.Count(logs.String(), "unrecognised diagnostic value stored as other"); n != 2 {
		t.Fatalf("%d lines after the interval, want 2: %q", n, logs.String())
	}
	for _, want := range []string{"value=socket_closed", "replaced_total=4", "suppressed_since_last=2"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("second line lacks %q: %q", want, logs.String())
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
// counter and none it keeps.
func TestNormalizeDiagnosticValuesCountsReplacements(t *testing.T) {
	captureStreamLogs(t)
	before := diagnosticReplacements.replacedTotal()
	payload := map[string]any{
		"event_type": "llm_error",
		"streaming":  map[string]any{"final_outcome": "truncated", "abort_reason": "client_aborted"},
		"error":      map[string]any{"abort_reason": "connection_reset", "error_type": "billing_hold"},
	}
	if !normalizeDiagnosticValues(payload) {
		t.Fatal("normalizeDiagnosticValues reported no change")
	}
	if got := diagnosticReplacements.replacedTotal() - before; got != 3 {
		t.Errorf("counted %d replacements, want 3", got)
	}
	stream := payload["streaming"].(map[string]any)
	if stream["final_outcome"] != "other" || stream["abort_reason"] != "client_aborted" {
		t.Errorf("streaming block %v, want final_outcome other and abort_reason kept", stream)
	}
	if errObj := payload["error"].(map[string]any); errObj["abort_reason"] != "other" || errObj["error_type"] != "other" {
		t.Errorf("error object %v, want abort_reason and error_type other", errObj)
	}

	before = diagnosticReplacements.replacedTotal()
	if normalizeDiagnosticValues(payload) {
		t.Error("a payload already normalised was changed again")
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
		if normalizeDiagnosticValues(payload) {
			t.Fatalf("a %s error object was normalised", eventType)
		}
		errObj := payload["error"].(map[string]any)
		if errObj["abort_reason"] != "whatever" || errObj["error_type"] != "invalid_params" {
			t.Errorf("%s error changed: %v", eventType, errObj)
		}
	}
}
