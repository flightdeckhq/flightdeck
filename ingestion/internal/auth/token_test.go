package auth

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// mockRow implements pgxRow for testing.
type mockRow struct{ exists bool }

func (r *mockRow) Scan(dest ...any) error {
	if len(dest) > 0 {
		if ptr, ok := dest[0].(*bool); ok {
			*ptr = r.exists
		}
	}
	return nil
}

// mockDB implements dbQuerier and counts calls.
type mockDB struct {
	exists    bool
	callCount atomic.Int32
}

func (m *mockDB) QueryRow(_ context.Context, _ string, _ ...any) pgxRow {
	m.callCount.Add(1)
	return &mockRow{exists: m.exists}
}

func TestTokenCacheHitAvoidsDatabaseCall(t *testing.T) {
	db := &mockDB{exists: true}
	v := newValidatorWithDB(db)

	// First call should hit the database
	valid, err := v.Validate(context.Background(), "tok_test")
	if err != nil || !valid {
		t.Fatalf("first validate failed: valid=%v err=%v", valid, err)
	}
	if db.callCount.Load() != 1 {
		t.Fatalf("expected 1 DB call after first validate, got %d", db.callCount.Load())
	}

	// Second call should hit the cache -- no additional DB call
	valid, err = v.Validate(context.Background(), "tok_test")
	if err != nil || !valid {
		t.Fatalf("second validate failed: valid=%v err=%v", valid, err)
	}
	if db.callCount.Load() != 1 {
		t.Errorf("expected 1 DB call (cache hit), got %d", db.callCount.Load())
	}
}

func TestTokenCacheExpiry(t *testing.T) {
	db := &mockDB{exists: true}
	v := newValidatorWithDB(db)

	// First call populates cache
	_, _ = v.Validate(context.Background(), "tok_expire")
	if db.callCount.Load() != 1 {
		t.Fatalf("expected 1 DB call, got %d", db.callCount.Load())
	}

	// Manually expire the cache entry
	hash := hashToken("tok_expire")
	v.mu.Lock()
	v.cache[hash] = cacheEntry{validAt: time.Now().Add(-2 * cacheTTL)}
	v.mu.Unlock()

	// Second call should miss cache and hit DB again
	_, _ = v.Validate(context.Background(), "tok_expire")
	if db.callCount.Load() != 2 {
		t.Errorf("expected 2 DB calls after cache expiry, got %d", db.callCount.Load())
	}
}
