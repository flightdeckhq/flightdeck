package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The llm_error taxonomy has three first-party emitters. Ingestion stores
// an error_type outside validLLMErrorTypes as "other", so every value
// each emitter sends must be in it; these tests read the emitters' own
// tables so a value added to one fails here, not in production.

// repoFile reads a file of another component. It fails, not skips, when
// the file is missing: the vocabulary must stay pinned to it.
func repoFile(t *testing.T, parts ...string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(append([]string{"..", "..", ".."}, parts...)...))
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Join(parts...), err)
	}
	return string(raw)
}

// block returns src from the first line containing start up to the first
// occurrence of end after it.
func block(t *testing.T, src, start, end string) string {
	t.Helper()
	i := strings.Index(src, start)
	if i < 0 {
		t.Fatalf("%q not found", start)
	}
	j := strings.Index(src[i:], end)
	if j < 0 {
		t.Fatalf("no %q after %q", end, start)
	}
	return src[i : i+j]
}

var quotedWord = regexp.MustCompile(`"([a-z_]+)"`)

func quotedWords(src string) []string {
	var out []string
	for _, m := range quotedWord.FindAllStringSubmatch(src, -1) {
		out = append(out, m[1])
	}
	return out
}

func taxonomy() []string {
	out := make([]string, 0, len(validLLMErrorTypes))
	for v := range validLLMErrorTypes {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// The sensor's ErrorType enum is the taxonomy: the two sets are equal.
func TestLLMErrorTypes_MatchTheSensorClassifier(t *testing.T) {
	src := repoFile(t, "sensor", "flightdeck_sensor", "core", "errors.py")
	enum := block(t, src, "class ErrorType(", "\n\n\n")
	values := regexp.MustCompile(`(?m)^\s+[A-Z_]+ = "([a-z_]+)"$`).FindAllStringSubmatch(enum, -1)
	got := make([]string, 0, len(values))
	for _, m := range values {
		got = append(got, m[1])
	}
	sort.Strings(got)
	want := taxonomy()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("sensor ErrorType = %v, validLLMErrorTypes = %v", got, want)
	}
}

// Every type the Claude Code plugin's StopFailure mapping can produce is
// in the taxonomy.
func TestLLMErrorTypes_CoverThePluginStopFailureMapping(t *testing.T) {
	src := repoFile(t, "plugin", "hooks", "scripts", "claude_code", "stop_failure.mjs")
	tables := map[string]string{
		"STOP_FAILURE_ERROR_TYPES": block(t, src, "STOP_FAILURE_ERROR_TYPES = ", "});"),
		"API_ERROR_KIND_TYPES":     block(t, src, "API_ERROR_KIND_TYPES = ", "});"),
		"MESSAGE_PREFIX_TYPES":     block(t, src, "MESSAGE_PREFIX_TYPES = ", "];"),
		"errorTypeOf fallback":     block(t, src, "STOP_FAILURE_ERROR_TYPES[code] : ", ";"),
	}
	for name, table := range tables {
		values := quotedWords(table)
		if len(values) == 0 {
			t.Fatalf("%s: no types found; the table's shape changed", name)
		}
		for _, v := range values {
			if !validLLMErrorTypes[v] {
				t.Errorf("%s sends %q, which ingestion would store as other", name, v)
			}
		}
	}
}

// Every type the OTLP dialect's api_error mapping can produce is in the
// taxonomy.
func TestLLMErrorTypes_CoverTheOTLPAPIErrorMapping(t *testing.T) {
	texts := []string{"", "spend limit reached", "prompt is too long", "request timed out"}
	for status := int64(0); status < 600; status++ {
		for _, text := range texts {
			if got := classifyClaudeCodeAPIError(status, text); !validLLMErrorTypes[got] {
				t.Errorf("classifyClaudeCodeAPIError(%d, %q) = %q, which ingestion would store as other", status, text, got)
			}
		}
	}
}
