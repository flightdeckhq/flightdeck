package writer

import "testing"

func TestPoolConfig_SetsTheLockTimeoutOnEveryConnection(t *testing.T) {
	cfg, err := PoolConfig("postgres://u:p@localhost:5432/flightdeck?sslmode=disable")
	if err != nil {
		t.Fatalf("PoolConfig: %v", err)
	}
	if got := cfg.ConnConfig.RuntimeParams["lock_timeout"]; got != "8000" {
		t.Fatalf("lock_timeout = %q, want 8000 (ms)", got)
	}
}
