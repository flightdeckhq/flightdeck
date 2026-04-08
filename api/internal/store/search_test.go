package store

import "testing"

func TestSanitizeQueryEscapesWildcards(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"research_agent", "%research\\_agent%"},
		{"100%", "%100\\%%"},
		{"normal", "%normal%"},
		{"back\\slash", "%back\\\\slash%"},
		{"all_%\\chars", "%all\\_\\%\\\\chars%"},
	}
	for _, tc := range tests {
		got := sanitizeQuery(tc.input)
		if got != tc.expected {
			t.Errorf("sanitizeQuery(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}
