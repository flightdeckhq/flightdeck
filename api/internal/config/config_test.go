package config

import "testing"

// The metrics port defaults to 9104, takes any port or 0 (listener
// off), and is refused outside 0..65535.
func TestMetricsPort(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://unused")
	if DefaultMetricsPort != 9104 {
		t.Errorf("DefaultMetricsPort = %d, want 9104 (the documented default)", DefaultMetricsPort)
	}
	for _, tc := range []struct {
		raw    string
		want   int
		panics bool
	}{
		{"", DefaultMetricsPort, false},
		{"0", 0, false},
		{"9200", 9200, false},
		{"65535", 65535, false},
		{"65536", 0, true},
		{"-1", 0, true},
		{"x", 0, true},
	} {
		t.Run("port="+tc.raw, func(t *testing.T) {
			t.Setenv("FLIGHTDECK_METRICS_PORT", tc.raw)
			defer func() {
				if r := recover(); (r != nil) != tc.panics {
					t.Fatalf("panic = %v, want panic %v", r, tc.panics)
				}
			}()
			if got := Load().MetricsPort; got != tc.want {
				t.Errorf("MetricsPort = %d, want %d", got, tc.want)
			}
		})
	}
}
