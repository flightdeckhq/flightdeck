package handlers

import (
	"testing"

	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
)

// A content attribute carries content only when it is a non-empty
// string other than a redaction placeholder: Claude Code's <REDACTED>
// and the [REDACTED] Strands sends count as none, with or without
// surrounding whitespace; text that only contains a placeholder is kept.
func TestOTLPAttrContentPlaceholders(t *testing.T) {
	a := otlpAttrs{
		"angle":     strVal("<REDACTED>"),
		"bracket":   strVal("[REDACTED]"),
		"padded":    strVal("  [REDACTED]\n"),
		"empty":     strVal(""),
		"number":    {Value: &commonpb.AnyValue_IntValue{IntValue: 3}},
		"text":      strVal("ls -la"),
		"mentions":  strVal("the log said [REDACTED] here"),
		"lowercase": strVal("[redacted]"),
	}
	for _, key := range []string{"angle", "bracket", "padded", "empty", "number", "missing"} {
		if v, ok := a.content(key); ok {
			t.Errorf("content(%s) = %q, want none", key, v)
		}
	}
	for key, want := range map[string]string{
		"text":      "ls -la",
		"mentions":  "the log said [REDACTED] here",
		"lowercase": "[redacted]",
	} {
		if v, ok := a.content(key); !ok || v != want {
			t.Errorf("content(%s) = %q %v, want %q", key, v, ok, want)
		}
	}
}
