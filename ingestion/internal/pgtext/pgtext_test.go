package pgtext

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// Every escape Postgres jsonb refuses becomes \ufffd: \u0000 in either
// case, a high surrogate without its low half, a low surrogate on its
// own. A paired surrogate, an escaped backslash before the text u0000
// and every other escape are kept; the length never changes.
func TestJSON(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"a":"x\u0000y"}`, `{"a":"x\ufffdy"}`},
		{`{"\u0000":1}`, `{"\ufffd":1}`},
		{`["\U0000"]`, `["\U0000"]`}, // not an escape JSON knows; left alone
		{`["\u0000\u0000"]`, `["\ufffd\ufffd"]`},
		{`["\ud800"]`, `["\ufffd"]`},
		{`["\uD83D\uDE00"]`, `["\uD83D\uDE00"]`},
		{`["\ud83dx"]`, `["\ufffdx"]`},
		{`["\ud83d\u0041"]`, `["\ufffd\u0041"]`},
		{`["\ude00"]`, `["\ufffd"]`},
		{`["\\u0000"]`, `["\\u0000"]`},
		{`["\\\u0000"]`, `["\\\ufffd"]`},
		{`["\n\t\"\u00e9"]`, `["\n\t\"\u00e9"]`},
		{`["\u00"]`, `["\u00"]`}, // truncated: not valid JSON, left alone
		{`plain`, `plain`},
	}
	for _, tc := range cases {
		got := string(JSON([]byte(tc.in)))
		if got != tc.want {
			t.Errorf("JSON(%s) = %s, want %s", tc.in, got, tc.want)
		}
		if len(got) != len(tc.in) {
			t.Errorf("JSON(%s) changed the length", tc.in)
		}
		if json.Valid([]byte(tc.in)) && !json.Valid([]byte(got)) {
			t.Errorf("JSON(%s) = %s is no longer valid", tc.in, got)
		}
	}
	// What encoding/json writes for a Go string with U+0000 is fixed.
	b, _ := json.Marshal(map[string]string{"r": "a\x00b"})
	if got := string(JSON(b)); got != `{"r":"a\ufffdb"}` {
		t.Errorf("a marshalled NUL became %s", got)
	}
	// A document with nothing to replace is the same slice, not a copy.
	in := []byte(`{"a":"\n"}`)
	if out := JSON(in); &out[0] != &in[0] {
		t.Error("an unchanged document was copied")
	}
	// The input is never modified.
	orig := []byte(`"\u0000"`)
	_ = JSON(orig)
	if string(orig) != `"\u0000"` {
		t.Error("the input was modified")
	}
}

func TestString(t *testing.T) {
	if got := String("a\x00b\x00"); got != "a\ufffdb\ufffd" {
		t.Errorf("String = %q", got)
	}
	if got := String("plain é"); got != "plain é" {
		t.Errorf("String = %q", got)
	}
}

// A Postgres error is described by its code and the table and
// constraint it names, after the layers that wrapped it, never by its
// message, detail or context, which quote the value it refused; any
// other error is described as it is.
func TestErrorClass(t *testing.T) {
	pgErr := &pgconn.PgError{
		Severity: "ERROR", Code: "22P05", Message: "unsupported Unicode escape sequence secret-in-message",
		Detail:    `\u0000 cannot be converted to text. secret-in-detail`,
		Where:     `JSON data, line 1: {"gen_ai.tool.call.result":"secret-in-context`,
		TableName: "otlp_span_content",
	}
	err := fmt.Errorf("stage genai records: %w", fmt.Errorf("otlpstage: insert content: %w", pgErr))
	got := ErrorClass(err)
	if strings.Contains(got, "secret") {
		t.Errorf("ErrorClass echoed the refused value: %s", got)
	}
	if got != "stage genai records: otlpstage: insert content: postgres error SQLSTATE 22P05 table otlp_span_content" {
		t.Errorf("ErrorClass = %s", got)
	}
	if got := ErrorClass(errors.New("otlpstage: begin stage: context deadline exceeded")); got != "otlpstage: begin stage: context deadline exceeded" {
		t.Errorf("ErrorClass = %s", got)
	}
	if ErrorClass(nil) != "" {
		t.Error("ErrorClass(nil) is not empty")
	}
}
