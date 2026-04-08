// Package auth provides Bearer token validation for the ingestion API.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	cacheTTL     = 60 * time.Second
	cacheMaxSize = 1000
)

type cacheEntry struct {
	validAt time.Time
}

// dbQuerier abstracts the database query used for token lookup.
// Implemented by pgxpool.Pool and mocks in tests.
type dbQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgxRow
}

// pgxRow abstracts pgx's Row.Scan for testability.
type pgxRow interface {
	Scan(dest ...any) error
}

// poolAdapter wraps pgxpool.Pool to satisfy dbQuerier.
type poolAdapter struct{ pool *pgxpool.Pool }

func (a *poolAdapter) QueryRow(ctx context.Context, sql string, args ...any) pgxRow {
	return a.pool.QueryRow(ctx, sql, args...)
}

// Validator checks bearer tokens against hashed values in the api_tokens table.
// Valid tokens are cached in memory for cacheTTL to reduce database load.
// Invalid tokens are never cached -- they always hit the database.
type Validator struct {
	db    dbQuerier
	cache map[string]cacheEntry
	mu    sync.RWMutex
}

// NewValidator creates a Validator backed by the given connection pool.
func NewValidator(pool *pgxpool.Pool) *Validator {
	return &Validator{
		db:    &poolAdapter{pool: pool},
		cache: make(map[string]cacheEntry),
	}
}

// newValidatorWithDB creates a Validator with a custom dbQuerier (for testing).
func newValidatorWithDB(db dbQuerier) *Validator {
	return &Validator{
		db:    db,
		cache: make(map[string]cacheEntry),
	}
}

// TODO(KI10)[Phase 5]: Token auth uses SHA256 without
// salt. If api_tokens table is leaked, short tokens
// (like tok_dev) can be brute-forced.
// Fix: use bcrypt or argon2 for production tokens.
// SHA256 is acceptable for dev seed only.
// See DECISIONS.md D046.

// Validate returns true if the raw bearer token matches a stored hash.
// The token is SHA-256 hashed before lookup -- raw tokens are never stored.
// Valid tokens are cached for 60s to reduce database load.
func (v *Validator) Validate(ctx context.Context, rawToken string) (bool, error) {
	hash := hashToken(rawToken)

	// Check cache for valid token
	v.mu.RLock()
	entry, found := v.cache[hash]
	v.mu.RUnlock()
	if found && time.Since(entry.validAt) < cacheTTL {
		return true, nil
	}

	// Cache miss or expired -- query database
	var exists bool
	err := v.db.QueryRow(
		ctx,
		"SELECT EXISTS(SELECT 1 FROM api_tokens WHERE token_hash = $1)",
		hash,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("token lookup: %w", err)
	}

	// Cache valid tokens only -- invalid tokens always hit the database
	if exists {
		v.mu.Lock()
		// Evict oldest entries if cache is full
		if len(v.cache) >= cacheMaxSize {
			v.evictOldest()
		}
		v.cache[hash] = cacheEntry{validAt: time.Now()}
		v.mu.Unlock()
	}

	return exists, nil
}

// evictOldest removes the oldest cache entry.
// Must be called with v.mu held for writing.
func (v *Validator) evictOldest() {
	oldest := time.Now()
	var oldestKey string
	for k, e := range v.cache {
		if e.validAt.Before(oldest) {
			oldest = e.validAt
			oldestKey = k
		}
	}
	if oldestKey != "" {
		delete(v.cache, oldestKey)
	}
}

func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}
