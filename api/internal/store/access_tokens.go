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

// devAccessTokenName is the reserved name of the seed row written by
// migration 000010. The CRUD API refuses to mutate this row so the
// ENVIRONMENT=dev gate stays the only way to enable or disable
// tok_dev -- operators cannot silently rename or delete it. See
// DECISIONS.md D095.
const devAccessTokenName = "Development Token"

// ErrDevAccessTokenProtected is returned when a caller tries to delete or
// rename the seed tok_dev row. Handlers translate this into an HTTP
// 403 so the dashboard can surface a clear message.
var ErrDevAccessTokenProtected = errors.New("tok_dev row is protected: delete or rename is not allowed")

// ErrAccessTokenNameRequired is returned when CreateAccessToken or RenameAccessToken
// is called with an empty name.
var ErrAccessTokenNameRequired = errors.New("token name is required")

// ErrAccessTokenNotFound signals that a DELETE / PATCH targeted a token id
// that does not exist. Handlers translate it into 404.
var ErrAccessTokenNotFound = errors.New("token not found")

// AccessTokenRow is the public projection of an access_tokens row. Hash and
// salt are intentionally absent -- the caller never has a reason to
// see them, and the handlers return only this struct so a leaked
// response body cannot expose the stored material.
type AccessTokenRow struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

// CreatedAccessTokenResponse is what POST /v1/tokens returns ONCE to the
// caller. The RawToken field carries the only copy of the plaintext
// that will ever leave the platform -- subsequent GETs never expose
// it. See the Authentication section of ARCHITECTURE.md.
type CreatedAccessTokenResponse struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Prefix    string    `json:"prefix"`
	RawToken  string    `json:"token"`
	CreatedAt time.Time `json:"created_at"`
}

// ListAccessTokens returns every access_tokens row sorted by creation time.
// The output excludes token_hash and salt.
func (s *Store) ListAccessTokens(ctx context.Context) ([]AccessTokenRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, prefix, created_at, last_used_at
		FROM access_tokens
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list tokens: %w", err)
	}
	defer rows.Close()

	out := make([]AccessTokenRow, 0)
	for rows.Next() {
		var t AccessTokenRow
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

// CreateAccessToken mints a new opaque bearer token and returns the
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
// and salt are -- and the caller receives it via CreatedAccessTokenResponse
// exactly once, on the POST response. Losing it requires creating a
// new token.
func (s *Store) CreateAccessToken(ctx context.Context, name string) (*CreatedAccessTokenResponse, error) {
	if name == "" {
		return nil, ErrAccessTokenNameRequired
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
		INSERT INTO access_tokens (name, token_hash, salt, prefix)
		VALUES ($1, $2, $3, $4)
		RETURNING id::text, created_at
	`, name, hash, salt, prefix).Scan(&id, &createdAt)
	if err != nil {
		return nil, fmt.Errorf("insert token: %w", err)
	}

	return &CreatedAccessTokenResponse{
		ID:        id,
		Name:      name,
		Prefix:    prefix,
		RawToken:  raw,
		CreatedAt: createdAt,
	}, nil
}

// DeleteAccessToken removes an access_tokens row by id. The tok_dev seed row
// is protected -- attempts return ErrDevAccessTokenProtected so the handler
// can surface 403. Missing ids return ErrAccessTokenNotFound → 404.
func (s *Store) DeleteAccessToken(ctx context.Context, id string) error {
	protected, err := s.isDevAccessTokenID(ctx, id)
	if err != nil {
		return err
	}
	if protected {
		return ErrDevAccessTokenProtected
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM access_tokens WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("delete token: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrAccessTokenNotFound
	}
	return nil
}

// RenameAccessToken updates the name field on an access_tokens row and returns
// the updated projection. Same dev-row and missing-row rules as
// DeleteAccessToken.
func (s *Store) RenameAccessToken(ctx context.Context, id, newName string) (*AccessTokenRow, error) {
	if newName == "" {
		return nil, ErrAccessTokenNameRequired
	}
	protected, err := s.isDevAccessTokenID(ctx, id)
	if err != nil {
		return nil, err
	}
	if protected {
		return nil, ErrDevAccessTokenProtected
	}

	var t AccessTokenRow
	err = s.pool.QueryRow(ctx, `
		UPDATE access_tokens
		SET name = $2
		WHERE id = $1::uuid
		RETURNING id::text, name, prefix, created_at, last_used_at
	`, id, newName).Scan(&t.ID, &t.Name, &t.Prefix, &t.CreatedAt, &t.LastUsedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrAccessTokenNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("rename token: %w", err)
	}
	return &t, nil
}

// isDevAccessTokenID reports whether the given id refers to the seeded
// "Development Token" row. Returns ErrAccessTokenNotFound if the id does
// not exist so the caller can short-circuit the 404 path without an
// extra round-trip.
func (s *Store) isDevAccessTokenID(ctx context.Context, id string) (bool, error) {
	var name string
	err := s.pool.QueryRow(ctx,
		`SELECT name FROM access_tokens WHERE id = $1::uuid`, id,
	).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrAccessTokenNotFound
	}
	if err != nil {
		return false, fmt.Errorf("lookup token name: %w", err)
	}
	return name == devAccessTokenName, nil
}
