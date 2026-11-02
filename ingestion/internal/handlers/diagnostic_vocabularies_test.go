package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Ingestion stores a diagnostic value outside its vocabulary as "other",
// so every value a first-party emitter sends must be in it. The llm_error
// taxonomy has three emitters (the sensor, the Claude Code plugin, the
// OTLP dialect); the stream outcome and abort reasons have one (the
// sensor). These tests read the emitters' own tables, so a value added to
// one fails here, not in production.

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

// sortedValues is a vocabulary's values in order, leaving out except.
func sortedValues(valid map[string]bool, except string) []string {
	out := make([]string, 0, len(valid))
	for v := range valid {
		if v != except {
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

var enumMember = regexp.MustCompile(`(?m)^\s+[A-Z_]+ = "([a-z_]+)"$`)

// sensorEnum is the sorted values of a StrEnum class in the sensor's
// core/errors.py.
func sensorEnum(t *testing.T, class string) []string {
	t.Helper()
	src := repoFile(t, "sensor", "flightdeck_sensor", "core", "errors.py")
	values := enumMember.FindAllStringSubmatch(block(t, src, "class "+class+"(", "\n\n\n"), -1)
	got := make([]string, 0, len(values))
	for _, m := range values {
		got = append(got, m[1])
	}
	if len(got) == 0 {
		t.Fatalf("no members found in %s; the class's shape changed", class)
	}
	sort.Strings(got)
	return got
}

// The sensor's ErrorType enum is the taxonomy, the catch-all included:
// the two sets are equal.
func TestLLMErrorTypes_MatchTheSensorClassifier(t *testing.T) {
	got, want := sensorEnum(t, "ErrorType"), sortedValues(validLLMErrorTypes, "")
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("sensor ErrorType = %v, validLLMErrorTypes = %v", got, want)
	}
}

// The sensor's StreamOutcome and AbortReason enums are the stream
// vocabularies apart from the catch-all, which only ingestion stores.
func TestStreamVocabularies_MatchTheSensor(t *testing.T) {
	for _, tc := range []struct {
		class string
		valid map[string]bool
	}{
		{"StreamOutcome", validFinalOutcomes},
		{"AbortReason", validAbortReasons},
	} {
		got, want := sensorEnum(t, tc.class), sortedValues(tc.valid, unrecognisedValue)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("sensor %s = %v, ingestion's vocabulary = %v", tc.class, got, want)
		}
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
