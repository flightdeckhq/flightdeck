package handlers

import (
	"encoding/json"
	"fmt"
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

// structRef is a field's struct type as the decoder fills it: the name of
// a struct of the worker's package, and the container the struct sits in
// ("" for the struct itself or a pointer to it, "list" for a slice or an
// array of it, "map" for a map's values).
type structRef struct {
	name, container string
}

// externalNonStructs are the types from other packages the worker's
// event fields may hold that are not structs, so the decoder fills no
// field of theirs by name.
var externalNonStructs = map[string]bool{"json.RawMessage": true}

// workerStructShapes reads the struct declarations of files, one Go
// package, and returns, for EventPayload and each struct reachable from
// it, the struct's JSON field names and its fields that hold a struct of
// the package, directly, through a pointer or in a container. It refuses
// what it cannot follow by name: an embedded field (the decoder promotes
// its fields to the outer object), an exported field with no json tag
// (matched by its Go name), an inline struct type, a type from another
// package that is not known to be a non-struct, and a container of a
// container.
func workerStructShapes(files []*ast.File) (map[string][]string, map[string]map[string]structRef, error) {
	specs := map[string]ast.Expr{}
	for _, file := range files {
		ast.Inspect(file, func(n ast.Node) bool {
			if spec, ok := n.(*ast.TypeSpec); ok {
				specs[spec.Name.Name] = spec.Type
			}
			return true
		})
	}
	names := map[string][]string{}
	nested := map[string]map[string]structRef{}
	for pending := []string{"EventPayload"}; len(pending) > 0; pending = pending[1:] {
		typeName := pending[0]
		if _, done := nested[typeName]; done {
			continue
		}
		st, ok := specs[typeName].(*ast.StructType)
		if !ok {
			return nil, nil, fmt.Errorf("no struct %s", typeName)
		}
		nested[typeName] = map[string]structRef{}
		for _, field := range st.Fields.List {
			if len(field.Names) == 0 {
				return nil, nil, fmt.Errorf("%s embeds %s: its fields would be read as %s's own", typeName, exprString(field.Type), typeName)
			}
			if len(field.Names) > 1 {
				return nil, nil, fmt.Errorf("%s declares %d fields on one line; declare one per line", typeName, len(field.Names))
			}
			goName := field.Names[0].Name
			if !field.Names[0].IsExported() {
				continue
			}
			name, err := jsonName(field)
			if err != nil {
				return nil, nil, fmt.Errorf("%s.%s: %w", typeName, goName, err)
			}
			if name == "-" {
				continue
			}
			names[typeName] = append(names[typeName], name)
			ref, err := resolveStruct(specs, field.Type, "", map[string]bool{})
			if err != nil {
				return nil, nil, fmt.Errorf("%s.%s: %w", typeName, goName, err)
			}
			if ref != nil {
				nested[typeName][name] = *ref
				pending = append(pending, ref.name)
			}
		}
		sort.Strings(names[typeName])
	}
	return names, nested, nil
}

// resolveStruct is the struct of the package that expr holds, or nil when
// it holds none; container is the container already unwrapped.
func resolveStruct(specs map[string]ast.Expr, expr ast.Expr, container string, seen map[string]bool) (*structRef, error) {
	wrap := func(inner ast.Expr, kind string) (*structRef, error) {
		if container != "" {
			return nil, fmt.Errorf("a %s inside a %s", kind, container)
		}
		return resolveStruct(specs, inner, kind, seen)
	}
	switch e := expr.(type) {
	case *ast.StarExpr:
		return resolveStruct(specs, e.X, container, seen)
	case *ast.ArrayType:
		return wrap(e.Elt, "list")
	case *ast.MapType:
		return wrap(e.Value, "map")
	case *ast.Ident:
		spec, declared := specs[e.Name]
		if !declared {
			return nil, nil // a predeclared type
		}
		if _, isStruct := spec.(*ast.StructType); isStruct {
			return &structRef{name: e.Name, container: container}, nil
		}
		if seen[e.Name] {
			return nil, nil
		}
		seen[e.Name] = true
		return resolveStruct(specs, spec, container, seen)
	case *ast.StructType:
		return nil, fmt.Errorf("an inline struct type; declare it as a named struct so its fields can be checked")
	case *ast.SelectorExpr:
		if externalNonStructs[exprString(e)] {
			return nil, nil
		}
		return nil, fmt.Errorf("%s comes from another package, which this test cannot read; if it is not a struct, add it to externalNonStructs", exprString(e))
	case *ast.InterfaceType:
		return nil, nil
	}
	return nil, fmt.Errorf("unsupported field type %T", expr)
}

func exprString(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		return exprString(e.X) + "." + e.Sel.Name
	case *ast.StarExpr:
		return "*" + exprString(e.X)
	}
	return fmt.Sprintf("%T", expr)
}

// workerStructs is workerStructShapes over the worker's consumer package.
func workerStructs(t *testing.T) (map[string][]string, map[string]map[string]structRef) {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "workers", "internal", "consumer")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	fset := token.NewFileSet()
	var files []*ast.File
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(dir, e.Name()), nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", e.Name(), err)
		}
		files = append(files, file)
	}
	names, nested, err := workerStructShapes(files)
	if err != nil {
		t.Fatalf("the worker's event structs: %v", err)
	}
	return names, nested
}

func jsonName(field *ast.Field) (string, error) {
	if field.Tag == nil {
		return "", fmt.Errorf("no json tag")
	}
	tag, err := strconv.Unquote(field.Tag.Value)
	if err != nil {
		return "", fmt.Errorf("tag: %w", err)
	}
	name, ok := reflect.StructTag(tag).Lookup("json")
	if !ok {
		return "", fmt.Errorf("no json tag")
	}
	name, _, _ = strings.Cut(name, ",")
	if name == "" {
		return "", fmt.Errorf("the json tag names no field")
	}
	return name, nil
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
	for _, problem := range levelProblems(names, nested, eventFields) {
		t.Error(problem)
	}
}

// levelProblems compares each struct-holding field of the worker's
// EventPayload with ingestion's nested levels under top.
func levelProblems(names map[string][]string, nested map[string]map[string]structRef, top *fieldNames) []string {
	var out []string
	for field, ref := range nested["EventPayload"] {
		if ref.container != "" {
			// checkFieldNameCase descends into an object, not into a list
			// or a map of objects.
			out = append(out, fmt.Sprintf("the worker decodes %s as a %s of %s; extend checkFieldNameCase to that shape and give it a level", field, ref.container, ref.name))
			continue
		}
		level := top.nested[field]
		if level == nil {
			out = append(out, fmt.Sprintf("the worker decodes %s into %s, and ingestion has no level for it", field, ref.name))
			continue
		}
		if got, want := namesOf(level), names[ref.name]; strings.Join(got, ",") != strings.Join(want, ",") {
			out = append(out, fmt.Sprintf("%s: ingestion %v, worker %s %v", field, got, ref.name, want))
		}
		if len(nested[ref.name]) != 0 {
			out = append(out, fmt.Sprintf("%s nests structs %v; check them a level deeper too", ref.name, nested[ref.name]))
		}
	}
	sort.Strings(out)
	return out
}

// Each way the worker's struct fields and ingestion's levels can differ is
// reported, a struct in a list or a map included.
func TestLevelProblems_ReportsEveryMismatch(t *testing.T) {
	names := map[string][]string{"Msg": {"body", "captured_at"}, "Inner": {"a"}}
	top := newFieldNames([]string{"direct", "renamed", "listed", "mapped", "deep", "short"}, map[string]*fieldNames{
		"direct": newFieldNames([]string{"body", "captured_at"}, nil),
		"deep":   newFieldNames([]string{"body", "captured_at"}, nil),
		"short":  newFieldNames([]string{"body"}, nil),
	})
	nested := map[string]map[string]structRef{
		"EventPayload": {
			"direct":  {name: "Msg"},
			"renamed": {name: "Msg"},
			"listed":  {name: "Msg", container: "list"},
			"mapped":  {name: "Msg", container: "map"},
			"deep":    {name: "Outer"},
			"short":   {name: "Msg"},
		},
		"Outer": {"inner": {name: "Inner"}},
	}
	names["Outer"] = []string{"body", "captured_at"}
	got := strings.Join(levelProblems(names, nested, top), "\n")
	for _, want := range []string{
		"the worker decodes listed as a list of Msg",
		"the worker decodes mapped as a map of Msg",
		"the worker decodes renamed into Msg, and ingestion has no level for it",
		"Outer nests structs",
		"short: ingestion [body], worker Msg [body captured_at]",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("problems lack %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "direct") {
		t.Errorf("a matching level was reported:\n%s", got)
	}
}

// workerStructShapes follows every shape in which the decoder can fill a
// struct of the package, and refuses the shapes it cannot follow by name.
func TestWorkerStructShapes_FollowsOrRefusesEveryFieldShape(t *testing.T) {
	const decls = `
type SubagentMessage struct {
	Body json.RawMessage ` + "`json:\"body\"`" + `
}
type Messages []SubagentMessage
type Body = json.RawMessage
`
	tag := func(name string) string { return " `json:\"" + name + "\"`" }
	cases := []struct {
		name, field string
		want        structRef // followed field "x"; zero when none
		wantErr     string
	}{
		{"struct", "X SubagentMessage" + tag("x"), structRef{name: "SubagentMessage"}, ""},
		{"pointer", "X *SubagentMessage" + tag("x"), structRef{name: "SubagentMessage"}, ""},
		{"slice", "X []SubagentMessage" + tag("x"), structRef{name: "SubagentMessage", container: "list"}, ""},
		{"slice of pointers", "X []*SubagentMessage" + tag("x"), structRef{name: "SubagentMessage", container: "list"}, ""},
		{"array", "X [2]SubagentMessage" + tag("x"), structRef{name: "SubagentMessage", container: "list"}, ""},
		{"map", "X map[string]SubagentMessage" + tag("x"), structRef{name: "SubagentMessage", container: "map"}, ""},
		{"named slice type", "X Messages" + tag("x"), structRef{name: "SubagentMessage", container: "list"}, ""},
		{"alias of json.RawMessage", "X Body" + tag("x"), structRef{}, ""},
		{"maps of non-structs", "X map[string]interface{}" + tag("x"), structRef{}, ""},
		{"embedded struct", "SubagentMessage", structRef{}, "embeds SubagentMessage"},
		{"embedded pointer", "*SubagentMessage", structRef{}, "embeds *SubagentMessage"},
		{"inline struct", "X struct{ A int " + tag("a") + " }" + tag("x"), structRef{}, "inline struct"},
		{"slice of inline structs", "X []struct{ A int " + tag("a") + " }" + tag("x"), structRef{}, "inline struct"},
		{"struct from another package", "X time.Time" + tag("x"), structRef{}, "time.Time comes from another package"},
		{"list of maps", "X []map[string]SubagentMessage" + tag("x"), structRef{}, "a map inside a list"},
		{"untagged exported field", "X int", structRef{}, "no json tag"},
	}
	for _, tc := range cases {
		src := "package consumer\n" + decls + "type EventPayload struct {\n\tID string" + tag("id") + "\n\t" + tc.field + "\n}\n"
		file, err := parser.ParseFile(token.NewFileSet(), "nats.go", src, 0)
		if err != nil {
			t.Fatalf("%s: parse: %v", tc.name, err)
		}
		_, nested, err := workerStructShapes([]*ast.File{file})
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("%s: error %v, want one containing %q", tc.name, err, tc.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if got := nested["EventPayload"]["x"]; got != tc.want {
			t.Errorf("%s: followed %+v, want %+v", tc.name, got, tc.want)
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
