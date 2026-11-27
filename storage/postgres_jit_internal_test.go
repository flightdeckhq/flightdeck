package storage

import "testing"

func TestWithJITOff_AddsTheParameterUnlessTheOperatorSetIt(t *testing.T) {
	t.Setenv("PGOPTIONS", "")
	for _, c := range []struct{ in, want string }{
		{"postgres://u:p@h:5432/db", "postgres://u:p@h:5432/db?jit=off"},
		{"postgres://u:p@h:5432/db?sslmode=disable", "postgres://u:p@h:5432/db?sslmode=disable&jit=off"},
		// The operator's own setting wins, in the URL or in its options.
		{"postgres://u:p@h:5432/db?sslmode=disable&jit=on", "postgres://u:p@h:5432/db?sslmode=disable&jit=on"},
		{"postgres://u:p@h:5432/db?options=-c%20jit%3Don", "postgres://u:p@h:5432/db?options=-c%20jit%3Don"},
		{"postgres://u:p@h:5432/db?options=--jit%3Don", "postgres://u:p@h:5432/db?options=--jit%3Don"},
		// Another option that merely contains the word is not a jit setting.
		{"postgres://u:p@h:5432/db?options=-c%20search_path%3Djitter", "postgres://u:p@h:5432/db?options=-c%20search_path%3Djitter&jit=off"},
	} {
		if got := withJITOff(c.in); got != c.want {
			t.Errorf("withJITOff(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestWithJITOff_LeavesAJITSettingInPGOPTIONS(t *testing.T) {
	t.Setenv("PGOPTIONS", "-c jit=on")
	const in = "postgres://u:p@h:5432/db?sslmode=disable"
	if got := withJITOff(in); got != in {
		t.Errorf("withJITOff(%q) with PGOPTIONS setting jit = %q, want it unchanged", in, got)
	}
}
