package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// devAccessTokenName is the reserved name of the seed row written by
// migration 000010. The CRUD API refuses to mutate this row so the
// ENVIRONMENT=dev gate stays the only way to enable or disable
// tok_dev -- operators cannot silently rename or delete it.
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

// ListAccessTokens returns every access_tokens row, newest first.
// Tokens created at the same instant (created_at resolves one
// millisecond on SQLite) keep that order among themselves through the
// dialect's insertion order. The output excludes token_hash and salt.
func (s *Store) ListAccessTokens(ctx context.Context) ([]AccessTokenRow, error) {
	rows, err := s.reader().QueryContext(ctx, `
		SELECT CAST(id AS TEXT), name, prefix, created_at, last_used_at
		FROM access_tokens
		ORDER BY created_at DESC, `+s.d.InsertionOrder("", "id")+` DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list tokens: %w", err)
	}
	defer func() { _ = rows.Close() }()

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
// Generation:
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
		createdAt storage.Time
	)
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO access_tokens (name, token_hash, salt, prefix)
		VALUES ($1, $2, $3, $4)
		RETURNING CAST(id AS TEXT), created_at
	`, name, hash, salt, prefix).Scan(&id, &createdAt)
	if err != nil {
		return nil, fmt.Errorf("insert token: %w", err)
	}

	return &CreatedAccessTokenResponse{
		ID:        id,
		Name:      name,
		Prefix:    prefix,
		RawToken:  raw,
		CreatedAt: createdAt.Time,
	}, nil
}

// DeleteAccessToken removes an access_tokens row by id. The tok_dev seed row
// is protected -- attempts return ErrDevAccessTokenProtected so the handler
// can surface 403. Missing ids return ErrAccessTokenNotFound → 404.
//
// After the delete commits, the token id is published on
// AccessTokenRevokedChannel so every validator drops its cached
// acceptance of the token at once. On Postgres the row's trigger
// publishes the same id for a delete made outside the API; the
// validators tolerate the duplicate.
func (s *Store) DeleteAccessToken(ctx context.Context, id string) error {
	id = uuidArg(id)
	protected, err := s.isDevAccessTokenID(ctx, id)
	if err != nil {
		return err
	}
	if protected {
		return ErrDevAccessTokenProtected
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM access_tokens WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete token: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrAccessTokenNotFound
	}
	if err := s.bus.Publish(ctx, AccessTokenRevokedChannel, id); err != nil {
		// The row is gone; a cached validation of it expires with
		// the validator's TTL.
		slog.Warn("token revocation not published", "token_id", id, "err", err)
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
	id = uuidArg(id)
	protected, err := s.isDevAccessTokenID(ctx, id)
	if err != nil {
		return nil, err
	}
	if protected {
		return nil, ErrDevAccessTokenProtected
	}

	var t AccessTokenRow
	var createdAt, lastUsedAt storage.Time
	err = s.db.QueryRowContext(ctx, `
		UPDATE access_tokens
		SET name = $2
		WHERE id = $1
		RETURNING CAST(id AS TEXT), name, prefix, created_at, last_used_at
	`, id, newName).Scan(&t.ID, &t.Name, &t.Prefix, &createdAt, &lastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrAccessTokenNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("rename token: %w", err)
	}
	t.CreatedAt = createdAt.Time
	if lastUsedAt.Valid {
		lu := lastUsedAt.Time
		t.LastUsedAt = &lu
	}
	return &t, nil
}

// isDevAccessTokenID reports whether the given id refers to the seeded
// "Development Token" row. Returns ErrAccessTokenNotFound if the id does
// not exist so the caller can short-circuit the 404 path without an
// extra round-trip.
func (s *Store) isDevAccessTokenID(ctx context.Context, id string) (bool, error) {
	var name string
	err := s.reader().QueryRowContext(ctx,
		`SELECT name FROM access_tokens WHERE id = $1`, id,
	).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrAccessTokenNotFound
	}
	if err != nil {
		return false, fmt.Errorf("lookup token name: %w", err)
	}
	return name == devAccessTokenName, nil
}

// suppliedSaltDomain separates the salt derived for a supplied token
// from any other SHA-256 of the same value.
const suppliedSaltDomain = "flightdeck supplied access token salt\x00"

// EnsureSuppliedAccessToken stores raw, a token the operator chose, as
// an access_tokens row named name unless the row is already there, and
// reports whether this call inserted it. The row has the shape
// CreateAccessToken writes (salted hash, salt, prefix); only the salt
// differs: it is derived from the token, not random, so every process
// that is given the same token computes the same hash and the unique
// index on it makes the insert idempotent. Processes that start
// together with one token all succeed and leave one row. The salt's
// job, keeping equal secrets from showing as equal hashes and a
// precomputed table from applying, is moot for a value the caller has
// checked to be 128 random bits; raw is not validated here.
func EnsureSuppliedAccessToken(ctx context.Context, db *storage.DB, name, raw string) (bool, error) {
	if name == "" {
		return false, ErrAccessTokenNameRequired
	}
	if len(raw) < 8 {
		return false, errors.New("supplied token is shorter than a token prefix")
	}
	saltSum := sha256.Sum256([]byte(suppliedSaltDomain + raw))
	salt := hex.EncodeToString(saltSum[:16])
	sum := sha256.Sum256([]byte(salt + raw))
	res, err := db.ExecContext(ctx, `
		INSERT INTO access_tokens (name, token_hash, salt, prefix)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (token_hash) DO NOTHING
	`, name, hex.EncodeToString(sum[:]), salt, raw[:8])
	if err != nil {
		return false, fmt.Errorf("insert supplied token: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("insert supplied token: %w", err)
	}
	return n > 0, nil
}
