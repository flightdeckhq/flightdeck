// Package auth provides Bearer token validation for the ingestion API.
//
// Tokens are opaque strings stored as SHA256(salt || raw_token) in the
// access_tokens table. See the Authentication section of
// ARCHITECTURE.md for the full model.
//
// The package reads access_tokens through the storage boundary, so it
// runs on SQLite and Postgres alike: the SQL below is the common
// subset of both dialects, and the one construct that differs (the
// current time) comes from the Dialect.
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

const (
	cacheTTL         = 60 * time.Second
	cacheMaxSize     = 1000
	devTokenRaw      = "tok_dev"
	devTokenReject   = "tok_dev is only valid in development mode. Create a production token in the Settings page."
	productionPrefix = "ftd_"
	prefixLen        = 8
)

// The validator's queries. Ids are read as text on both backends
// (CAST is a no-op on SQLite, where the column is text) and bound as
// text when matched, which Postgres compares against its uuid column.
const (
	queryDevToken = `SELECT CAST(id AS TEXT), name FROM access_tokens WHERE name = 'Development Token' LIMIT 1`
	queryByPrefix = `SELECT CAST(id AS TEXT), name, token_hash, salt FROM access_tokens WHERE prefix = $1`
	// queryTouchLastUsed takes the dialect's current-time expression.
	queryTouchLastUsed = `UPDATE access_tokens SET last_used_at = %s WHERE id = $1`
)

// ValidationResult is the outcome of resolving a Bearer token against
// access_tokens. When Valid is true the caller receives the row's id and
// human-readable name, which the events handler injects into the NATS
// payload for session_start events so the worker can persist them onto
// the new session row. When Valid is false, Reason is an
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

// dbQuerier is the narrow database surface the validator needs.
// Implemented by sqlQuerier over storage.DB in production and by fakes
// in tests.
type dbQuerier interface {
	QueryRow(ctx context.Context, query string, args ...any) rowScanner
	Query(ctx context.Context, query string, args ...any) (rowsIter, error)
	Exec(ctx context.Context, query string, args ...any) error
}

type rowScanner interface {
	Scan(dest ...any) error
}

// rowsIter is the minimal *sql.Rows surface used to iterate candidate
// rows during ftd_ prefix lookup.
type rowsIter interface {
	Next() bool
	Scan(dest ...any) error
	Close()
	Err() error
}

// sqlQuerier runs the validator's reads on the database's read handle
// and its one write (last_used_at) on the writer.
type sqlQuerier struct {
	db *storage.DB
}

func (q *sqlQuerier) QueryRow(ctx context.Context, query string, args ...any) rowScanner {
	return q.db.Reader().QueryRowContext(ctx, query, args...)
}

func (q *sqlQuerier) Query(ctx context.Context, query string, args ...any) (rowsIter, error) {
	rows, err := q.db.Reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return &sqlRows{rows: rows}, nil
}

func (q *sqlQuerier) Exec(ctx context.Context, query string, args ...any) error {
	_, err := q.db.ExecContext(ctx, query, args...)
	return err
}

type sqlRows struct{ rows *sql.Rows }

func (r *sqlRows) Next() bool             { return r.rows.Next() }
func (r *sqlRows) Scan(dest ...any) error { return r.rows.Scan(dest...) }
func (r *sqlRows) Close()                 { _ = r.rows.Close() }
func (r *sqlRows) Err() error             { return r.rows.Err() }

// envLookup abstracts os.Getenv so tests can flip ENVIRONMENT without
// leaking state into the real process environment.
type envLookup func(string) string

// Validator checks bearer tokens against salted hashes in access_tokens.
// Valid results are cached in-memory for cacheTTL to keep the hot path
// off the database for repeat clients. Invalid tokens are NOT cached
// so a rejected attempt always re-hits the DB -- this matches the
// prior stopgap's behavior and guarantees that adding a new token
// takes effect immediately.
type Validator struct {
	db    dbQuerier
	cache map[string]cacheEntry
	mu    sync.RWMutex
	// generation counts cache invalidations (Invalidate, Flush). A
	// lookup that missed the cache records it before querying the
	// database and caches its result only if no invalidation happened
	// meanwhile, so a revocation that lands while the query is in
	// flight cannot be overwritten by the stale result.
	generation uint64
	env        envLookup
	// touchLastUsed is queryTouchLastUsed with the dialect's current
	// time filled in.
	touchLastUsedQuery string
	// onListening, when set (tests only), runs each time the revocation
	// listener has subscribed and flushed the cache.
	onListening func()
}

// NewValidator creates a Validator backed by the given database. Env
// lookups default to os.Getenv.
func NewValidator(db *storage.DB) *Validator {
	return newValidatorWithDB(&sqlQuerier{db: db}, db.Dialect, os.Getenv)
}

// newValidatorWithDB creates a Validator with a custom dbQuerier,
// dialect and env lookup (for testing). A nil dialect means Postgres.
func newValidatorWithDB(db dbQuerier, dialect storage.Dialect, env envLookup) *Validator {
	if env == nil {
		env = os.Getenv
	}
	if dialect == nil {
		dialect = storage.DialectFor(storage.Postgres)
	}
	return &Validator{
		db:                 db,
		cache:              make(map[string]cacheEntry),
		env:                env,
		touchLastUsedQuery: fmt.Sprintf(queryTouchLastUsed, dialect.Now()),
	}
}

// Validate resolves rawToken against access_tokens by its salted SHA-256 hash.
//
//  1. raw == "tok_dev"  → accepted only when ENVIRONMENT=dev. When the
//     guard rejects, ValidationResult.Reason carries the operator-
//     facing message so the handler can surface it verbatim in the
//     401 body.
//  2. raw starts with "ftd_" → narrow on access_tokens.prefix (first 8
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
	// Caching dev-mode rejects is safe because the gate's input is
	// (raw token, ENVIRONMENT) and ENVIRONMENT is stable for the life of
	// the process. A flip would require a restart, which clears the cache
	// anyway. The cache is keyed on the SHA-256 of the token so the
	// plaintext bearer secret is never held as a map key.
	key := cacheKey(rawToken)
	v.mu.RLock()
	entry, found := v.cache[key]
	generation := v.generation
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
		if v.generation == generation {
			if len(v.cache) >= cacheMaxSize {
				v.evictOldest()
			}
			v.cache[key] = cacheEntry{result: result, validAt: time.Now()}
		}
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
		err := v.db.QueryRow(ctx, queryDevToken).Scan(&id, &name)
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
		rows, err := v.db.Query(ctx, queryByPrefix, prefix)
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
	return v.db.Exec(ctx, v.touchLastUsedQuery, id)
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

// cacheKey derives the in-memory validation-cache key from the raw token.
// The cache is keyed on the SHA-256 of the token, never the plaintext, so the
// bearer secret is not recoverable from a heap dump of the cache map.
func cacheKey(rawToken string) string {
	sum := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(sum[:])
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
