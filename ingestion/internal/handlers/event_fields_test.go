package handlers

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// workerStructs parses the worker's consumer package and returns, for
// EventPayload and each struct of the package reachable from it, the
// struct's JSON field names and its fields whose type is (a pointer to)
// another struct of the package, with that struct's name. It fails on an
// exported field with no json tag: the decoder would match it by its Go
// name.
func workerStructs(t *testing.T) (map[string][]string, map[string]map[string]string) {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "workers", "internal", "consumer")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	fset := token.NewFileSet()
	types := map[string]*ast.StructType{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(dir, e.Name()), nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", e.Name(), err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if spec, ok := n.(*ast.TypeSpec); ok {
				if st, ok := spec.Type.(*ast.StructType); ok {
					types[spec.Name.Name] = st
				}
			}
			return true
		})
	}
	names := map[string][]string{}
	nested := map[string]map[string]string{}
	for pending := []string{"EventPayload"}; len(pending) > 0; pending = pending[1:] {
		typeName := pending[0]
		if _, done := nested[typeName]; done {
			continue
		}
		st, ok := types[typeName]
		if !ok {
			t.Fatalf("no struct %s in %s", typeName, dir)
		}
		nested[typeName] = map[string]string{}
		for _, field := range st.Fields.List {
			if len(field.Names) == 0 || !field.Names[0].IsExported() {
				continue
			}
			name := jsonName(t, typeName, field)
			if name == "-" {
				continue
			}
			names[typeName] = append(names[typeName], name)
			expr := field.Type
			if star, ok := expr.(*ast.StarExpr); ok {
				expr = star.X
			}
			if ident, ok := expr.(*ast.Ident); ok {
				if _, isStruct := types[ident.Name]; isStruct {
					nested[typeName][name] = ident.Name
					pending = append(pending, ident.Name)
				}
			}
		}
		sort.Strings(names[typeName])
	}
	return names, nested
}

func jsonName(t *testing.T, typeName string, field *ast.Field) string {
	t.Helper()
	if field.Tag == nil {
		t.Fatalf("%s.%s has no json tag", typeName, field.Names[0].Name)
	}
	tag, err := strconv.Unquote(field.Tag.Value)
	if err != nil {
		t.Fatalf("%s.%s tag: %v", typeName, field.Names[0].Name, err)
	}
	name, ok := reflect.StructTag(tag).Lookup("json")
	if !ok {
		t.Fatalf("%s.%s has no json tag", typeName, field.Names[0].Name)
	}
	name, _, _ = strings.Cut(name, ",")
	if name == "" {
		t.Fatalf("%s.%s's json tag names no field", typeName, field.Names[0].Name)
	}
	return name
}

func sortedNames(names []string) []string {
	out := append([]string(nil), names...)
	sort.Strings(out)
	return out
}

func namesOf(f *fieldNames) []string {
	out := make([]string, 0, len(f.exact))
	for name := range f.exact {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// The top-level field names are the worker EventPayload's, and every
// field of it that the worker decodes into a struct of its own has a
// nested level here with that struct's names.
func TestEventFieldNames_MatchTheWorkerEventPayload(t *testing.T) {
	names, nested := workerStructs(t)
	if got, want := sortedNames(eventFieldNames), names["EventPayload"]; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("eventFieldNames differ from the worker's EventPayload:\ningestion %v\nworker    %v", got, want)
	}
	if len(nested["EventPayload"]) == 0 {
		t.Fatal("EventPayload has no struct-typed field; the parser no longer finds SubagentMessage")
	}
	for field, structName := range nested["EventPayload"] {
		level := eventFields.nested[field]
		if level == nil {
			t.Errorf("the worker decodes %s into %s, and ingestion has no level for it", field, structName)
			continue
		}
		if got, want := namesOf(level), names[structName]; strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: ingestion %v, worker %s %v", field, got, structName, want)
		}
		if len(nested[structName]) != 0 {
			t.Errorf("%s nests structs %v; check them a level deeper too", structName, nested[structName])
		}
	}
}

var dictKey = regexp.MustCompile(`"([a-z][a-z0-9_]*)":`)

func dictKeys(src string) []string {
	var out []string
	for _, m := range dictKey.FindAllStringSubmatch(src, -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

// The streaming block and the llm_error error object have no struct in
// the worker; their names are the ones the sensor builds them with.
func TestEventFieldNames_StreamAndErrorMatchTheSensor(t *testing.T) {
	base := repoFile(t, "sensor", "flightdeck_sensor", "interceptor", "base.py")
	errorsPy := repoFile(t, "sensor", "flightdeck_sensor", "core", "errors.py")

	streaming := dictKeys(block(t, base, `"ttft_ms": ttft_ms,`, "\n    }"))
	if got, want := sortedNames(streamingFieldNames), streaming; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("streaming: ingestion %v, sensor %v", got, want)
	}
	gaps := dictKeys(block(t, base, "inter_chunk = {", "}"))
	if got, want := sortedNames(streamTimingKeys), gaps; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("inter_chunk_ms: ingestion %v, sensor %v", got, want)
	}

	errKeys := dictKeys(block(t, errorsPy, "Shape emitted on the wire under the event's ``error`` key.", "}"))
	errKeys = append(errKeys, quotedWords(block(t, base, "_KEY_ABORT_REASON = ", "\n\n"))...)
	sort.Strings(errKeys)
	if got := sortedNames(llmErrorFieldNames); strings.Join(got, ",") != strings.Join(errKeys, ",") {
		t.Errorf("llm_error error: ingestion %v, sensor %v", got, errKeys)
	}
}

// Go's decoder fills a struct field from a key that matches its name only
// under Unicode case folding, the Kelvin sign and the long s included;
// checkFieldNameCase refuses each such key and leaves alone a key that
// does not fold to the name.
func TestCheckFieldNameCase_RefusesWhatTheDecoderFolds(t *testing.T) {
	var target struct {
		TokensInput *int `json:"tokens_input"`
	}
	for key, folds := range map[string]bool{
		"TOKENS_INPUT":      true,
		"Tokens_Input":      true,
		"to\u212Aens_input": true, // Kelvin sign
		"token\u017F_input": true, // long s
		"tokens-input":      false,
		"tokensinput":       false,
		"tokens_input_":     false,
	} {
		target.TokensInput = nil
		if err := json.Unmarshal([]byte(`{"`+key+`":-5}`), &target); err != nil {
			t.Fatalf("decode %q: %v", key, err)
		}
		if decoded := target.TokensInput != nil; decoded != folds {
			t.Errorf("the decoder filled tokens_input from %q: %v, want %v", key, decoded, folds)
		}
		msg := checkFieldNameCase(map[string]any{key: -5.0}, "post_call")
		if refused := msg != ""; refused != folds {
			t.Errorf("%q refused: %v (%q), want %v", key, refused, msg, folds)
		}
	}
	if !strings.EqualFold("to\u212Aens_input", "tokens_input") || foldName("to\u212Aens_input") != foldName("tokens_input") {
		t.Error("foldName disagrees with strings.EqualFold on the Kelvin sign")
	}
}

// Each level: a case variant of one of its field names is refused with a
// message naming the key and the field; the exact name and an unknown key
// that folds to no field are accepted.
func TestCheckFieldNameCase_Levels(t *testing.T) {
	cases := []struct {
		name      string
		eventType string
		payload   map[string]any
		want      string
	}{
		{"top level", "post_call", map[string]any{"Streaming": "garbage"},
			`"Streaming" is not a field name; field names are case-sensitive, and the field is "streaming"`},
		{"streaming", "post_call", map[string]any{"streaming": map[string]any{"Final_Outcome": "x"}},
			`"streaming.Final_Outcome" is not a field name; field names are case-sensitive, and the field is "streaming.final_outcome"`},
		{"inter_chunk_ms", "post_call", map[string]any{"streaming": map[string]any{"inter_chunk_ms": map[string]any{"P95": -1.0}}},
			`"streaming.inter_chunk_ms.P95" is not a field name; field names are case-sensitive, and the field is "streaming.inter_chunk_ms.p95"`},
		{"incoming_message", "session_start", map[string]any{"incoming_message": map[string]any{"Body": "hi"}},
			`"incoming_message.Body" is not a field name; field names are case-sensitive, and the field is "incoming_message.body"`},
		{"outgoing_message", "session_end", map[string]any{"outgoing_message": map[string]any{"Content_Bytes": 1.0}},
			`"outgoing_message.Content_Bytes" is not a field name; field names are case-sensitive, and the field is "outgoing_message.content_bytes"`},
		{"llm_error error", "llm_error", map[string]any{"error": map[string]any{"Partial_Tokens_Input": -1.0}},
			`"error.Partial_Tokens_Input" is not a field name; field names are case-sensitive, and the field is "error.partial_tokens_input"`},
		{"two variants: the first in order", "post_call", map[string]any{"TOKENS_OUTPUT": 1.0, "Model": "m"},
			`"Model" is not a field name; field names are case-sensitive, and the field is "model"`},
		{"an MCP event's error is its own", "mcp_tool_call", map[string]any{"error": map[string]any{"Error_Type": "x"}}, ""},
		{"a directive_result error is a string", "directive_result", map[string]any{"error": "Boom"}, ""},
		{"exact names", "llm_error", map[string]any{
			"tokens_input": 1.0, "streaming": map[string]any{"final_outcome": "x", "inter_chunk_ms": map[string]any{"p50": 1.0}},
			"error": map[string]any{"error_type": "x"}, "incoming_message": map[string]any{"body": "b"},
		}, ""},
		{"unknown keys that fold to no field", "post_call", map[string]any{
			"tool_input": "x", "Os": "linux", "streaming": map[string]any{"Chunks": 1.0},
			"context": map[string]any{"Session_ID": "a map, not a struct"},
		}, ""},
		{"a non-object level is left to the type checks", "post_call", map[string]any{"streaming": "completed", "incoming_message": 3.0}, ""},
	}
	for _, tc := range cases {
		if got := checkFieldNameCase(tc.payload, tc.eventType); got != tc.want {
			t.Errorf("%s:\n got %q\nwant %q", tc.name, got, tc.want)
		}
	}
}
