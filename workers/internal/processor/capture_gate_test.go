package processor

import "testing"

// stripExtraContent is the capture-posture guard for the inline content
// sink (MCP content projected into events.payload). These tests pin its
// behaviour: content is removed when capture is off, unrelated payload
// keys survive, and an all-content blob collapses to a NULL payload.
func TestStripExtraContent(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string // "" means nil expected
	}{
		{"removes content, keeps others", `{"content":{"secret":"x"},"streaming":{"ttft":5}}`, `{"streaming":{"ttft":5}}`},
		{"content-only collapses to nil", `{"content":{"secret":"x"}}`, ""},
		{"no content key unchanged", `{"streaming":{"ttft":5}}`, `{"streaming":{"ttft":5}}`},
		{"empty input unchanged", ``, ""},
		{"invalid json returned as-is", `{not json`, `{not json`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripExtraContent([]byte(tt.in))
			if tt.want == "" {
				if got != nil && string(got) != "" {
					t.Fatalf("want nil/empty, got %q", string(got))
				}
				return
			}
			if string(got) != tt.want {
				t.Fatalf("want %q, got %q", tt.want, string(got))
			}
		})
	}
}
