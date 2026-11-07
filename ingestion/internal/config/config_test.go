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

// Unset, the stream settings take their defaults.
func TestStreamSettingsDefaults(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://unused")
	for _, key := range []string{
		"FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS",
		"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB",
		"FLIGHTDECK_NATS_STREAM_REPLICAS",
	} {
		t.Setenv(key, "")
	}
	cfg := Load()
	if want := DefaultStreamMaxAgeHours * time.Hour; cfg.StreamMaxAge != want {
		t.Errorf("StreamMaxAge = %v, want %v", cfg.StreamMaxAge, want)
	}
	if want := int64(DefaultStreamMaxSizeMiB) << 20; cfg.StreamMaxBytes != want {
		t.Errorf("StreamMaxBytes = %d, want %d", cfg.StreamMaxBytes, want)
	}
	if cfg.StreamReplicas != 1 {
		t.Errorf("StreamReplicas = %d, want 1", cfg.StreamReplicas)
	}
}

// Each stream setting is converted to its unit when in bounds and
// refused at startup when out of them or not an integer.
func TestStreamSettingsBounds(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://unused")
	for _, tc := range []struct {
		key    string
		raw    string
		check  func(Config) bool
		panics bool
	}{
		{"FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS", "1", func(c Config) bool { return c.StreamMaxAge == time.Hour }, false},
		{"FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS", "168", func(c Config) bool { return c.StreamMaxAge == 168*time.Hour }, false},
		{"FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS", "0", nil, true},
		{"FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS", "-3", nil, true},
		{"FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS", "72h", nil, true},
		{"FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS", "9999999999", nil, true},
		{"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", "64", func(c Config) bool { return c.StreamMaxBytes == 64<<20 }, false},
		{"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", "30720", func(c Config) bool { return c.StreamMaxBytes == 30720<<20 }, false},
		{"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", "63", nil, true},
		{"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", "0", nil, true},
		{"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", "5GiB", nil, true},
		{"FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB", "9223372036854775807", nil, true},
		{"FLIGHTDECK_NATS_STREAM_REPLICAS", "3", func(c Config) bool { return c.StreamReplicas == 3 }, false},
		{"FLIGHTDECK_NATS_STREAM_REPLICAS", "5", func(c Config) bool { return c.StreamReplicas == 5 }, false},
		{"FLIGHTDECK_NATS_STREAM_REPLICAS", "0", nil, true},
		{"FLIGHTDECK_NATS_STREAM_REPLICAS", "6", nil, true},
	} {
		t.Run(tc.key+"="+tc.raw, func(t *testing.T) {
			t.Setenv(tc.key, tc.raw)
			defer func() {
				if r := recover(); (r != nil) != tc.panics {
					t.Fatalf("panic = %v, want panic %v", r, tc.panics)
				}
			}()
			if cfg := Load(); !tc.check(cfg) {
				t.Errorf("unexpected config for %s=%s: age %v, bytes %d, replicas %d",
					tc.key, tc.raw, cfg.StreamMaxAge, cfg.StreamMaxBytes, cfg.StreamReplicas)
			}
		})
	}
}
