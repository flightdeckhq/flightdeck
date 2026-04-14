package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// devTokenName is the reserved name of the seed row written by
// migration 000010. The CRUD API refuses to mutate this row so the
// ENVIRONMENT=dev gate stays the only way to enable or disable
// tok_dev -- operators cannot silently rename or delete it. See
// DECISIONS.md D095.
const devTokenName = "Development Token"

// ErrDevTokenProtected is returned when a caller tries to delete or
// rename the seed tok_dev row. Handlers translate this into an HTTP
// 403 so the dashboard can surface a clear message.
var ErrDevTokenProtected = errors.New("tok_dev row is protected: delete or rename is not allowed")

// ErrTokenNameRequired is returned when CreateToken or RenameToken
// is called with an empty name.
var ErrTokenNameRequired = errors.New("token name is required")

// ErrTokenNotFound signals that a DELETE / PATCH targeted a token id
// that does not exist. Handlers translate it into 404.
var ErrTokenNotFound = errors.New("token not found")

// TokenRow is the public projection of an api_tokens row. Hash and
// salt are intentionally absent -- the caller never has a reason to
// see them, and the handlers return only this struct so a leaked
// response body cannot expose the stored material.
type TokenRow struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

// CreatedTokenResponse is what POST /v1/tokens returns ONCE to the
// caller. The RawToken field carries the only copy of the plaintext
// that will ever leave the platform -- subsequent GETs never expose
// it. See the Authentication section of ARCHITECTURE.md.
type CreatedTokenResponse struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Prefix    string    `json:"prefix"`
	RawToken  string    `json:"token"`
	CreatedAt time.Time `json:"created_at"`
}

// ListTokens returns every api_tokens row sorted by creation time.
// The output excludes token_hash and salt.
func (s *Store) ListTokens(ctx context.Context) ([]TokenRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, prefix, created_at, last_used_at
		FROM api_tokens
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list tokens: %w", err)
	}
	defer rows.Close()

	out := make([]TokenRow, 0)
	for rows.Next() {
		var t TokenRow
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return nil, fmt.Errorf("scan token: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate tokens: %w", err)
	}
	return out, nil
}

// CreateToken mints a new opaque bearer token and returns the
// plaintext together with the stored-row projection.
//
// Generation follows DECISIONS.md D095:
//
//   - plaintext = "ftd_" + 32 random hex chars (16 crypto/rand bytes)
//   - salt      = 16 random bytes, hex-encoded (32 chars)
//   - hash      = hex(SHA256(salt_hex || plaintext))
//   - prefix    = first 8 chars of plaintext
//
// The plaintext is never written to the database -- only the hash
// and salt are -- and the caller receives it via CreatedTokenResponse
// exactly once, on the POST response. Losing it requires creating a
// new token.
func (s *Store) CreateToken(ctx context.Context, name string) (*CreatedTokenResponse, error) {
	if name == "" {
		return nil, ErrTokenNameRequired
	}

	// 16 random bytes for the token body → 32 hex chars after the
	// "ftd_" prefix, for 36 char tokens total. crypto/rand.Read
	// returns an error only if the system RNG is unavailable, which
	// in practice means we cannot mint a safe token and must refuse.
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("generate token bytes: %w", err)
	}
	raw := "ftd_" + hex.EncodeToString(tokenBytes)

	saltBytes := make([]byte, 16)
	if _, err := rand.Read(saltBytes); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}
	salt := hex.EncodeToString(saltBytes)

	sum := sha256.Sum256([]byte(salt + raw))
	hash := hex.EncodeToString(sum[:])
	prefix := raw[:8]

	var (
		id        string
		createdAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO api_tokens (name, token_hash, salt, prefix)
		VALUES ($1, $2, $3, $4)
		RETURNING id::text, created_at
	`, name, hash, salt, prefix).Scan(&id, &createdAt)
	if err != nil {
		return nil, fmt.Errorf("insert token: %w", err)
	}

	return &CreatedTokenResponse{
		ID:        id,
		Name:      name,
		Prefix:    prefix,
		RawToken:  raw,
		CreatedAt: createdAt,
	}, nil
}

// DeleteToken removes an api_tokens row by id. The tok_dev seed row
// is protected -- attempts return ErrDevTokenProtected so the handler
// can surface 403. Missing ids return ErrTokenNotFound → 404.
func (s *Store) DeleteToken(ctx context.Context, id string) error {
	protected, err := s.isDevTokenID(ctx, id)
	if err != nil {
		return err
	}
	if protected {
		return ErrDevTokenProtected
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM api_tokens WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("delete token: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrTokenNotFound
	}
	return nil
}

// RenameToken updates the name field on an api_tokens row and returns
// the updated projection. Same dev-row and missing-row rules as
// DeleteToken.
func (s *Store) RenameToken(ctx context.Context, id, newName string) (*TokenRow, error) {
	if newName == "" {
		return nil, ErrTokenNameRequired
	}
	protected, err := s.isDevTokenID(ctx, id)
	if err != nil {
		return nil, err
	}
	if protected {
		return nil, ErrDevTokenProtected
	}

	var t TokenRow
	err = s.pool.QueryRow(ctx, `
		UPDATE api_tokens
		SET name = $2
		WHERE id = $1::uuid
		RETURNING id::text, name, prefix, created_at, last_used_at
	`, id, newName).Scan(&t.ID, &t.Name, &t.Prefix, &t.CreatedAt, &t.LastUsedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTokenNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("rename token: %w", err)
	}
	return &t, nil
}

// isDevTokenID reports whether the given id refers to the seeded
// "Development Token" row. Returns ErrTokenNotFound if the id does
// not exist so the caller can short-circuit the 404 path without an
// extra round-trip.
func (s *Store) isDevTokenID(ctx context.Context, id string) (bool, error) {
	var name string
	err := s.pool.QueryRow(ctx,
		`SELECT name FROM api_tokens WHERE id = $1::uuid`, id,
	).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrTokenNotFound
	}
	if err != nil {
		return false, fmt.Errorf("lookup token name: %w", err)
	}
	return name == devTokenName, nil
}
