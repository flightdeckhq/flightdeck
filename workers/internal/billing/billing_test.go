package billing

import "testing"

func TestDefaultMode(t *testing.T) {
	cases := map[string]string{
		"claude_code":       Subscription,
		"cursor":            Subscription,
		"flightdeck_sensor": Metered,
		"opencode":          Metered,
		"":                  Metered,
	}
	for clientType, want := range cases {
		if got := DefaultMode(clientType); got != want {
			t.Errorf("DefaultMode(%q) = %q, want %q", clientType, got, want)
		}
	}
}

func TestApplies(t *testing.T) {
	for eventType, want := range map[string]bool{
		"post_call": true, "embeddings": true,
		"pre_call": false, "llm_error": false, "tool_call": false, "session_start": false,
	} {
		if got := Applies(eventType); got != want {
			t.Errorf("Applies(%q) = %v, want %v", eventType, got, want)
		}
	}
}
