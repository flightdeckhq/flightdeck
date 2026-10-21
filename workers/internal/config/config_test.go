package config

import (
	"strings"
	"testing"
)

func TestLoad_OrphanTimeoutHours_DefaultIs24(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_ORPHAN_TIMEOUT_HOURS", "")
	cfg := Load()
	if cfg.OrphanTimeoutHours != 24 {
		t.Errorf("default: want 24, got %d", cfg.OrphanTimeoutHours)
	}
}

func TestLoad_OrphanTimeoutHours_PositiveValueAccepted(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_ORPHAN_TIMEOUT_HOURS", "1")
	cfg := Load()
	if cfg.OrphanTimeoutHours != 1 {
		t.Errorf("explicit 1h: want 1, got %d", cfg.OrphanTimeoutHours)
	}
}

func TestLoad_OrphanTimeoutHours_ZeroPanics(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_ORPHAN_TIMEOUT_HOURS", "0")
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for OrphanTimeoutHours=0; Load returned cleanly")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "must be > 0") {
			t.Errorf("panic message should explain the constraint; got %v", r)
		}
	}()
	Load()
}

func TestLoad_OrphanTimeoutHours_NegativePanics(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_ORPHAN_TIMEOUT_HOURS", "-1")
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic for OrphanTimeoutHours=-1; Load returned cleanly")
		}
	}()
	Load()
}

func TestLoad_ReconcilerIntervalSecs_DefaultIs60(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_RECONCILER_INTERVAL_SECS", "")
	cfg := Load()
	if cfg.ReconcilerIntervalSecs != 60 {
		t.Errorf("default: want 60, got %d", cfg.ReconcilerIntervalSecs)
	}
}

func TestLoad_ReconcilerIntervalSecs_PositiveValueAccepted(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_RECONCILER_INTERVAL_SECS", "5")
	cfg := Load()
	if cfg.ReconcilerIntervalSecs != 5 {
		t.Errorf("explicit 5s: want 5, got %d", cfg.ReconcilerIntervalSecs)
	}
}

func TestLoad_ReconcilerIntervalSecs_ZeroPanics(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_RECONCILER_INTERVAL_SECS", "0")
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for ReconcilerIntervalSecs=0; Load returned cleanly")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "must be > 0") {
			t.Errorf("panic message should explain the constraint; got %v", r)
		}
	}()
	Load()
}

func TestLoad_ReconcilerIntervalSecs_NegativePanics(t *testing.T) {
	t.Setenv("FLIGHTDECK_POSTGRES_URL", "postgres://test")
	t.Setenv("FLIGHTDECK_RECONCILER_INTERVAL_SECS", "-1")
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic for ReconcilerIntervalSecs=-1; Load returned cleanly")
		}
	}()
	Load()
}
