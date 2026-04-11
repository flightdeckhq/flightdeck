// Package auth provides Bearer token validation for the query API.
//
// This is a stopgap reused by sensor-facing endpoints (POST
// /v1/directives/sync, POST /v1/directives/register) until the full
// JWT auth middleware lands in Phase 5. See DECISIONS.md D073.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
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

// dbQuerier abstracts the database query used for token lookup so
// the validator can be unit tested without a real Postgres pool.
type dbQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgxRow
}

type pgxRow interface {
	Scan(dest ...any) error
}

type poolAdapter struct{ pool *pgxpool.Pool }

func (a *poolAdapter) QueryRow(ctx context.Context, sql string, args ...any) pgxRow {
	return a.pool.QueryRow(ctx, sql, args...)
}

// Validator checks bearer tokens against hashed values in the
// api_tokens table. Mirrors the ingestion-side validator. Valid
// tokens are cached for cacheTTL.
type Validator struct {
	db    dbQuerier
	cache map[string]cacheEntry
	mu    sync.RWMutex
}

// NewValidator creates a Validator backed by the given pool.
func NewValidator(pool *pgxpool.Pool) *Validator {
	return &Validator{
		db:    &poolAdapter{pool: pool},
		cache: make(map[string]cacheEntry),
	}
}

// Validate returns true if the raw bearer token matches a stored hash.
func (v *Validator) Validate(ctx context.Context, rawToken string) (bool, error) {
	hash := hashToken(rawToken)

	v.mu.RLock()
	entry, found := v.cache[hash]
	v.mu.RUnlock()
	if found && time.Since(entry.validAt) < cacheTTL {
		return true, nil
	}

	var exists bool
	err := v.db.QueryRow(
		ctx,
		"SELECT EXISTS(SELECT 1 FROM api_tokens WHERE token_hash = $1)",
		hash,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("token lookup: %w", err)
	}

	if exists {
		v.mu.Lock()
		if len(v.cache) >= cacheMaxSize {
			v.evictOldest()
		}
		v.cache[hash] = cacheEntry{validAt: time.Now()}
		v.mu.Unlock()
	}

	return exists, nil
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

func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

// Middleware returns an http.Handler that requires a valid Bearer
// token on the Authorization header. On missing or invalid tokens
// it writes a JSON 401 and never calls next.
func Middleware(v *Validator, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if raw == "" || raw == r.Header.Get("Authorization") {
			// Either no header or it did not start with "Bearer "
			writeJSONError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		ok, err := v.Validate(r.Context(), raw)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "auth lookup error")
			return
		}
		if !ok {
			writeJSONError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(`{"error":"` + msg + `"}`))
}
