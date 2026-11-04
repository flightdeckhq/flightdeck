package config

import (
	"testing"
	"time"
)

// The claim interval is the default when unset, taken as given at or
// above the floor, and refused below it or negative.
func TestGenAIClaimInterval(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://unused")
	for _, tc := range []struct {
		raw    string
		want   time.Duration
		panics bool
	}{
		{"", 0, false},
		{"0", 0, false},
		{"50", MinGenAIClaimInterval, false},
		{"250", 250 * time.Millisecond, false},
		{"49", 0, true},
		{"1", 0, true},
		{"-5", 0, true},
	} {
		t.Run("ms="+tc.raw, func(t *testing.T) {
			t.Setenv("FLIGHTDECK_GENAI_CLAIM_INTERVAL_MS", tc.raw)
			defer func() {
				if r := recover(); (r != nil) != tc.panics {
					t.Fatalf("panic = %v, want panic %v", r, tc.panics)
				}
			}()
			if got := Load().GenAIClaimInterval; got != tc.want {
				t.Errorf("GenAIClaimInterval = %v, want %v", got, tc.want)
			}
		})
	}
}
