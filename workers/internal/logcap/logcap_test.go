package logcap

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCapKeepsAValueWithinTheLimitWhole(t *testing.T) {
	for _, s := range []string{"", "post_call", strings.Repeat("a", 64)} {
		if got := Cap(s, 64); got != s {
			t.Errorf("Cap(%q, 64) = %q, want it unchanged", s, got)
		}
	}
}

func TestCapTruncatesAndStatesTheFullLength(t *testing.T) {
	s := strings.Repeat("x", 10_000)
	got := Cap(s, 64)
	want := strings.Repeat("x", 64) + "…(10000 bytes)"
	if got != want {
		t.Fatalf("Cap(10000 x, 64) = %q, want %q", got, want)
	}
}

func TestCapCutsOnAUTF8Boundary(t *testing.T) {
	// "é" is two bytes, so a 4-byte cut of "aéééé" falls inside the
	// second é and must back off to the end of the first.
	got := Cap("aéééé", 4)
	if !utf8.ValidString(got) {
		t.Fatalf("Cap produced invalid UTF-8: %q", got)
	}
	if want := "aé…(9 bytes)"; got != want {
		t.Fatalf("Cap(aéééé, 4) = %q, want %q", got, want)
	}
}

func TestCapWithANonPositiveLimitKeepsOnlyTheLength(t *testing.T) {
	for _, limit := range []int{0, -1} {
		if got, want := Cap("abc", limit), "…(3 bytes)"; got != want {
			t.Errorf("Cap(abc, %d) = %q, want %q", limit, got, want)
		}
	}
}

func TestNamedCapsUseTheirLimits(t *testing.T) {
	cases := []struct {
		name  string
		fn    func(string) string
		limit int
	}{
		{"ID", ID, MaxID},
		{"EventType", EventType, MaxEventType},
		{"Timestamp", Timestamp, MaxTimestamp},
		{"Name", Name, MaxName},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			whole := strings.Repeat("k", tc.limit)
			if got := tc.fn(whole); got != whole {
				t.Fatalf("a value of exactly %d bytes was changed: %q", tc.limit, got)
			}
			over := whole + "k"
			want := whole + fmt.Sprintf("…(%d bytes)", tc.limit+1)
			if got := tc.fn(over); got != want {
				t.Fatalf("%s(%d bytes) = %q, want %q", tc.name, tc.limit+1, got, want)
			}
		})
	}
}

func TestErrCapsTheErrorText(t *testing.T) {
	if got := Err(nil); got != "<nil>" {
		t.Fatalf("Err(nil) = %q", got)
	}
	short := errors.New("connection refused")
	if got := Err(short); got != "connection refused" {
		t.Fatalf("Err(short) = %q", got)
	}
	// The shape that motivated the cap: Postgres quotes the bad input.
	huge := fmt.Errorf(`ERROR: invalid input syntax for type uuid: "%s" (SQLSTATE 22P02)`,
		strings.Repeat("z", 1<<20))
	got := Err(huge)
	if len(got) > MaxErr+len("…(1048627 bytes)") {
		t.Fatalf("Err of a 1 MiB error is %d bytes", len(got))
	}
	if !strings.HasPrefix(got, "ERROR: invalid input syntax for type uuid") {
		t.Fatalf("Err lost the error's leading text: %q", got[:80])
	}
	if !strings.HasSuffix(got, fmt.Sprintf("…(%d bytes)", len(huge.Error()))) {
		t.Fatalf("Err did not state the full length: %q", got[len(got)-40:])
	}
}

func TestValueCapsAPanicValue(t *testing.T) {
	got := Value(strings.Repeat("p", 5000))
	if want := strings.Repeat("p", MaxErr) + "…(5000 bytes)"; got != want {
		t.Fatalf("Value(5000 p) is %d bytes, want %d", len(got), len(want))
	}
	if got := Value(42); got != "42" {
		t.Fatalf("Value(42) = %q", got)
	}
}
