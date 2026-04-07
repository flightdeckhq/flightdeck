// Package auth provides Bearer token validation for the ingestion API.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Validator checks bearer tokens against hashed values in the api_tokens table.
type Validator struct {
	pool *pgxpool.Pool
}

// NewValidator creates a Validator backed by the given connection pool.
func NewValidator(pool *pgxpool.Pool) *Validator {
	return &Validator{pool: pool}
}

// TODO(KI03)[Phase 3]: Token validation hits Postgres on
// every request with no caching. At high throughput this
// becomes a bottleneck.
// Fix: add in-memory LRU cache with 60s TTL.
// See DECISIONS.md D048.

// TODO(KI10)[Phase 5]: Token auth uses SHA256 without
// salt. If api_tokens table is leaked, short tokens
// (like tok_dev) can be brute-forced.
// Fix: use bcrypt or argon2 for production tokens.
// SHA256 is acceptable for dev seed only.
// See DECISIONS.md D046.

// Validate returns true if the raw bearer token matches a stored hash.
// The token is SHA-256 hashed before lookup -- raw tokens are never stored.
func (v *Validator) Validate(ctx context.Context, rawToken string) (bool, error) {
	hash := hashToken(rawToken)

	var exists bool
	err := v.pool.QueryRow(
		ctx,
		"SELECT EXISTS(SELECT 1 FROM api_tokens WHERE token_hash = $1)",
		hash,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("token lookup: %w", err)
	}
	return exists, nil
}

func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}
