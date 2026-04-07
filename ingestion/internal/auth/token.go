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
