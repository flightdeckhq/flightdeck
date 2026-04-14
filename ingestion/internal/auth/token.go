// Package auth provides Bearer token validation for the ingestion API.
//
// Tokens are opaque strings stored as SHA256(salt || raw_token) in the
// api_tokens table. See DECISIONS.md D095 and the Authentication
// section of ARCHITECTURE.md for the full model.
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	cacheTTL         = 60 * time.Second
	cacheMaxSize     = 1000
	devTokenRaw      = "tok_dev"
	devTokenReject   = "tok_dev is only valid in development mode. Create a production token in the Settings page."
	productionPrefix = "ftd_"
	prefixLen        = 8
)

// ValidationResult is the outcome of resolving a Bearer token against
// api_tokens. When Valid is true the caller receives the row's id and
// human-readable name, which the events handler injects into the NATS
// payload for session_start events so the worker can persist them onto
// the new session row (D095). When Valid is false, Reason is an
// http-safe message the handler can put in the 401 body; an empty
// Reason means "use a generic invalid-token message".
type ValidationResult struct {
	Valid  bool
	ID     string
	Name   string
	Reason string
}

type cacheEntry struct {
	result  ValidationResult
	validAt time.Time
}

// dbQuerier is the narrow pgx surface the validator needs. Implemented
// by pgxpool.Pool in production and mocks in tests.
type dbQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgxRow
	Query(ctx context.Context, sql string, args ...any) (pgxRows, error)
	Exec(ctx context.Context, sql string, args ...any) error
}

type pgxRow interface {
	Scan(dest ...any) error
}

// pgxRows is the minimal pgx.Rows surface used to iterate candidate
// rows during ftd_ prefix lookup.
type pgxRows interface {
	Next() bool
	Scan(dest ...any) error
	Close()
	Err() error
}

type poolAdapter struct{ pool *pgxpool.Pool }

func (a *poolAdapter) QueryRow(ctx context.Context, sql string, args ...any) pgxRow {
	return a.pool.QueryRow(ctx, sql, args...)
}

func (a *poolAdapter) Query(ctx context.Context, sql string, args ...any) (pgxRows, error) {
	rows, err := a.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return &pgxRowsAdapter{rows: rows}, nil
}

func (a *poolAdapter) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := a.pool.Exec(ctx, sql, args...)
	return err
}

type pgxRowsAdapter struct{ rows pgx.Rows }

func (a *pgxRowsAdapter) Next() bool              { return a.rows.Next() }
func (a *pgxRowsAdapter) Scan(dest ...any) error  { return a.rows.Scan(dest...) }
func (a *pgxRowsAdapter) Close()                  { a.rows.Close() }
func (a *pgxRowsAdapter) Err() error              { return a.rows.Err() }

// envLookup abstracts os.Getenv so tests can flip ENVIRONMENT without
// leaking state into the real process environment.
type envLookup func(string) string

// Validator checks bearer tokens against salted hashes in api_tokens.
// Valid results are cached in-memory for cacheTTL to keep the hot path
// off the database for repeat clients. Invalid tokens are NOT cached
// so a rejected attempt always re-hits the DB -- this matches the
// prior stopgap's behavior and guarantees that adding a new token
// takes effect immediately.
type Validator struct {
	db    dbQuerier
	cache map[string]cacheEntry
	mu    sync.RWMutex
	env   envLookup
}

// NewValidator creates a Validator backed by the given pool. Env
// lookups default to os.Getenv.
func NewValidator(pool *pgxpool.Pool) *Validator {
	return &Validator{
		db:    &poolAdapter{pool: pool},
		cache: make(map[string]cacheEntry),
		env:   os.Getenv,
	}
}

// newValidatorWithDB creates a Validator with a custom dbQuerier and
// env lookup (for testing).
func newValidatorWithDB(db dbQuerier, env envLookup) *Validator {
	if env == nil {
		env = os.Getenv
	}
	return &Validator{
		db:    db,
		cache: make(map[string]cacheEntry),
		env:   env,
	}
}

// Validate resolves rawToken against api_tokens per the D095 algorithm.
//
//  1. raw == "tok_dev"  → accepted only when ENVIRONMENT=dev. When the
//     guard rejects, ValidationResult.Reason carries the operator-
//     facing message so the handler can surface it verbatim in the
//     401 body.
//  2. raw starts with "ftd_" → narrow on api_tokens.prefix (first 8
//     chars of the raw token), then compute SHA256(salt || raw) per
//     candidate row and compare in constant time. Update
//     last_used_at on match.
//  3. Anything else → Valid=false with no Reason (generic 401).
//
// Returns an error only on unexpected DB failures. Normal "token not
// known" paths return Valid=false, nil.
func (v *Validator) Validate(ctx context.Context, rawToken string) (ValidationResult, error) {
	if rawToken == "" {
		return ValidationResult{}, nil
	}

	// Cache hit -- both accept and (intentionally) reject results.
	// Caching dev-mode rejects keyed on the raw token is safe because
	// the gate's input is (raw token, ENVIRONMENT) and ENVIRONMENT is
	// stable for the life of the process. A flip would require a
	// restart, which clears the cache anyway.
	cacheKey := rawToken
	v.mu.RLock()
	entry, found := v.cache[cacheKey]
	v.mu.RUnlock()
	if found && time.Since(entry.validAt) < cacheTTL {
		return entry.result, nil
	}

	result, err := v.resolve(ctx, rawToken)
	if err != nil {
		return ValidationResult{}, err
	}

	// Cache the result -- accept or dev-mode reject. Unknown-token
	// rejects (Valid=false, Reason=="") are NOT cached so rotation
	// and new token creation take effect immediately without a
	// cacheTTL wait. The cache check above must also gate on this.
	if result.Valid || result.Reason != "" {
		v.mu.Lock()
		if len(v.cache) >= cacheMaxSize {
			v.evictOldest()
		}
		v.cache[cacheKey] = cacheEntry{result: result, validAt: time.Now()}
		v.mu.Unlock()
	}

	return result, nil
}

func (v *Validator) resolve(ctx context.Context, rawToken string) (ValidationResult, error) {
	if rawToken == devTokenRaw {
		if v.env("ENVIRONMENT") != "dev" {
			return ValidationResult{Valid: false, Reason: devTokenReject}, nil
		}
		var id, name string
		err := v.db.QueryRow(ctx,
			`SELECT id::text, name FROM api_tokens WHERE name = 'Development Token' LIMIT 1`,
		).Scan(&id, &name)
		if err != nil {
			return ValidationResult{}, fmt.Errorf("lookup tok_dev row: %w", err)
		}
		if err := v.touchLastUsed(ctx, id); err != nil {
			// Not load-bearing -- log-worthy in production, but a
			// failed UPDATE should not reject an otherwise-valid
			// token. The caller sees a Valid result either way.
			_ = err
		}
		return ValidationResult{Valid: true, ID: id, Name: name}, nil
	}

	if strings.HasPrefix(rawToken, productionPrefix) && len(rawToken) >= prefixLen {
		prefix := rawToken[:prefixLen]
		rows, err := v.db.Query(ctx,
			`SELECT id::text, name, token_hash, salt FROM api_tokens WHERE prefix = $1`,
			prefix,
		)
		if err != nil {
			return ValidationResult{}, fmt.Errorf("token prefix lookup: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			var id, name, tokenHash, salt string
			if err := rows.Scan(&id, &name, &tokenHash, &salt); err != nil {
				return ValidationResult{}, fmt.Errorf("scan candidate: %w", err)
			}
			if constantTimeEqual(hashWithSalt(salt, rawToken), tokenHash) {
				if err := v.touchLastUsed(ctx, id); err != nil {
					_ = err
				}
				return ValidationResult{Valid: true, ID: id, Name: name}, nil
			}
		}
		if err := rows.Err(); err != nil {
			return ValidationResult{}, fmt.Errorf("iterate candidates: %w", err)
		}
		return ValidationResult{Valid: false}, nil
	}

	return ValidationResult{Valid: false}, nil
}

func (v *Validator) touchLastUsed(ctx context.Context, id string) error {
	return v.db.Exec(ctx,
		`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1::uuid`,
		id,
	)
}

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

// hashWithSalt returns hex(SHA256(salt || raw_token)). The salt is
// treated as an opaque string -- the seed migration uses hex-encoded
// bytes but any stable textual salt works.
func hashWithSalt(salt, raw string) string {
	h := sha256.Sum256([]byte(salt + raw))
	return hex.EncodeToString(h[:])
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
