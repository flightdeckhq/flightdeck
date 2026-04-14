// Package auth provides Bearer token validation for the query API.
//
// Mirrors ingestion/internal/auth in behavior -- the two services
// share the api_tokens table and must agree byte-for-byte on which
// tokens are accepted. The only difference is the surface: ingestion
// handlers consume ValidationResult directly so they can inject the
// resolved token id/name into the NATS payload for session_start
// events; the query API only needs a 401-or-pass gate, so this
// package also exports a chi-free http.Handler middleware.
//
// See DECISIONS.md D095 and the Authentication section of
// ARCHITECTURE.md for the full model.
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
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

// ValidationResult mirrors ingestion/internal/auth.ValidationResult.
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

type dbQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgxRow
	Query(ctx context.Context, sql string, args ...any) (pgxRows, error)
	Exec(ctx context.Context, sql string, args ...any) error
}

type pgxRow interface {
	Scan(dest ...any) error
}

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

func (a *pgxRowsAdapter) Next() bool             { return a.rows.Next() }
func (a *pgxRowsAdapter) Scan(dest ...any) error { return a.rows.Scan(dest...) }
func (a *pgxRowsAdapter) Close()                 { a.rows.Close() }
func (a *pgxRowsAdapter) Err() error             { return a.rows.Err() }

type envLookup func(string) string

// Validator checks bearer tokens against salted hashes in api_tokens.
type Validator struct {
	db    dbQuerier
	cache map[string]cacheEntry
	mu    sync.RWMutex
	env   envLookup
}

// NewValidator creates a Validator backed by the given pool.
func NewValidator(pool *pgxpool.Pool) *Validator {
	return &Validator{
		db:    &poolAdapter{pool: pool},
		cache: make(map[string]cacheEntry),
		env:   os.Getenv,
	}
}

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
func (v *Validator) Validate(ctx context.Context, rawToken string) (ValidationResult, error) {
	if rawToken == "" {
		return ValidationResult{}, nil
	}

	v.mu.RLock()
	entry, found := v.cache[rawToken]
	v.mu.RUnlock()
	if found && time.Since(entry.validAt) < cacheTTL {
		return entry.result, nil
	}

	result, err := v.resolve(ctx, rawToken)
	if err != nil {
		return ValidationResult{}, err
	}

	if result.Valid || result.Reason != "" {
		v.mu.Lock()
		if len(v.cache) >= cacheMaxSize {
			v.evictOldest()
		}
		v.cache[rawToken] = cacheEntry{result: result, validAt: time.Now()}
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
		_ = v.touchLastUsed(ctx, id)
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
				_ = v.touchLastUsed(ctx, id)
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

func hashWithSalt(salt, raw string) string {
	h := sha256.Sum256([]byte(salt + raw))
	return hex.EncodeToString(h[:])
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Middleware returns an http.Handler that requires a valid Bearer
// token. On missing or invalid tokens it writes a JSON 401 and never
// calls next. When the validator surfaces a specific Reason (e.g.
// tok_dev rejected outside dev mode), that reason is used verbatim in
// the 401 body so operators see the actionable message.
func Middleware(v *Validator, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if raw == "" || raw == r.Header.Get("Authorization") {
			writeJSONError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		result, err := v.Validate(r.Context(), raw)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "auth lookup error")
			return
		}
		if !result.Valid {
			reason := result.Reason
			if reason == "" {
				reason = "invalid token"
			}
			writeJSONError(w, http.StatusUnauthorized, reason)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	// Quote the message via JSON marshaling so embedded quotes don't
	// break the wire format. The old implementation concatenated the
	// string directly; now that Reason carries user-facing sentences
	// with punctuation, we defer to encoding/json.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	b, mErr := jsonMarshalError(msg)
	if mErr != nil {
		_, _ = w.Write([]byte(`{"error":"internal error"}`))
		return
	}
	_, _ = w.Write(b)
}

func jsonMarshalError(msg string) ([]byte, error) {
	return []byte(fmt.Sprintf(`{"error":%q}`, msg)), nil
}
