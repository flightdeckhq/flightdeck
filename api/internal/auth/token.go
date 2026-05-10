// Package auth provides Bearer token validation for the query API.
//
// Mirrors ingestion/internal/auth in behavior -- the two services
// share the access_tokens table and must agree byte-for-byte on which
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
	cacheTTL = 60 * time.Second
	cacheMaxSize = 1000
	// devTokenRaw is the development-only sentinel bearer token.
	// Phase 4.5 L-1 contract: it is ONLY accepted when
	// ENVIRONMENT=dev (or the legacy FLIGHTDECK_DEV=1). In every
	// other environment, presenting "tok_dev" yields a 401 with
	// devTokenReject. There is no path where this constant
	// authenticates outside dev mode -- see Validate() below for
	// the env-gate. CI and local docker-compose intentionally
	// inherit the dev mode so existing tests pass without secret
	// material.
	devTokenRaw = "tok_dev"
	// devAdminTokenRaw is the dev-only admin sentinel. Same env
	// gate as devTokenRaw. In production, set
	// FLIGHTDECK_ADMIN_ACCESS_TOKEN to a real secret instead;
	// without it, no admin access exists anywhere in production
	// -- the safe default for the rarely-used reconcile-agents
	// endpoint.
	devAdminTokenRaw    = "tok_admin_dev"
	devTokenReject      = "tok_dev is only valid in development mode. Create a production token in the Settings page."
	devAdminTokenReject = "tok_admin_dev is only valid in development mode. Configure FLIGHTDECK_ADMIN_ACCESS_TOKEN in production."
	productionPrefix    = "ftd_"
	prefixLen           = 8
	// Environment variable name for the production admin token. When
	// set, any bearer whose raw value matches this env var
	// authenticates as an admin. Absent in production => no admin
	// access anywhere, which is the safe default for a rarely-used
	// ops capability (the reconcile-agents endpoint). Dev mode keeps
	// the hardcoded ``tok_admin_dev`` shortcut so CI and local runs
	// don't need the env var wired through every test harness.
	adminTokenEnvVar = "FLIGHTDECK_ADMIN_ACCESS_TOKEN"
)

// ValidationResult mirrors ingestion/internal/auth.ValidationResult.
//
// IsAdmin is the Phase 3-bis addition: ``AdminRequired`` middleware
// gates endpoints that mutate fleet-wide state (reconcile-agents
// today, more ops tooling in future) on this bit. Admin is a
// SUPERSET of the standard bearer gate — an admin token also passes
// the plain ``Middleware`` check, so a single operator token can
// both read dashboards and run ops. Scope separation would add a
// second token concept without much benefit at this scale.
type ValidationResult struct {
	Valid   bool
	ID      string
	Name    string
	Reason  string
	IsAdmin bool
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

// Validator checks bearer tokens against salted hashes in access_tokens.
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

// Validate resolves rawToken against access_tokens per the D095 algorithm.
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
	// Production admin token from env. Highest priority so an admin
	// in production authenticates even if a future token scheme
	// happens to collide on some prefix. Constant-time compare
	// avoids leaking the env-configured secret via timing.
	if adminToken := v.env(adminTokenEnvVar); adminToken != "" &&
		subtle.ConstantTimeCompare([]byte(rawToken), []byte(adminToken)) == 1 {
		return ValidationResult{
			Valid:   true,
			ID:      "admin-env",
			Name:    "Admin (env)",
			IsAdmin: true,
		}, nil
	}

	if rawToken == devTokenRaw {
		if v.env("ENVIRONMENT") != "dev" {
			return ValidationResult{Valid: false, Reason: devTokenReject}, nil
		}
		var id, name string
		err := v.db.QueryRow(ctx,
			`SELECT id::text, name FROM access_tokens WHERE name = 'Development Token' LIMIT 1`,
		).Scan(&id, &name)
		if err != nil {
			return ValidationResult{}, fmt.Errorf("lookup tok_dev row: %w", err)
		}
		_ = v.touchLastUsed(ctx, id)
		return ValidationResult{Valid: true, ID: id, Name: name}, nil
	}

	if rawToken == devAdminTokenRaw {
		if v.env("ENVIRONMENT") != "dev" {
			return ValidationResult{Valid: false, Reason: devAdminTokenReject}, nil
		}
		// Reuse the Development Token row for id/name so audit queries
		// see a known id. IsAdmin=true is the only delta vs tok_dev.
		var id, name string
		err := v.db.QueryRow(ctx,
			`SELECT id::text, name FROM access_tokens WHERE name = 'Development Token' LIMIT 1`,
		).Scan(&id, &name)
		if err != nil {
			return ValidationResult{}, fmt.Errorf("lookup tok_admin_dev row: %w", err)
		}
		_ = v.touchLastUsed(ctx, id)
		return ValidationResult{Valid: true, ID: id, Name: name, IsAdmin: true}, nil
	}

	if strings.HasPrefix(rawToken, productionPrefix) && len(rawToken) >= prefixLen {
		prefix := rawToken[:prefixLen]
		rows, err := v.db.Query(ctx,
			`SELECT id::text, name, token_hash, salt FROM access_tokens WHERE prefix = $1`,
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
		`UPDATE access_tokens SET last_used_at = NOW() WHERE id = $1::uuid`,
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

// validationResultCtxKey is the request-context key under which a
// successful Middleware run stashes the [ValidationResult] for
// downstream handlers (notably [AdminRequired]) to read without
// calling Validate again. Phase 4.5 M-2 closes a small TOCTOU
// window where the cache could expire between the Middleware
// validate and the AdminRequired re-validate, letting the second
// call hit a different code path than the first.
type validationResultCtxKey struct{}

// ValidationResultFromContext returns the ValidationResult that
// [Middleware] stashed for the current request, or zero-value +
// false if the request did not pass through Middleware.
func ValidationResultFromContext(ctx context.Context) (ValidationResult, bool) {
	v, ok := ctx.Value(validationResultCtxKey{}).(ValidationResult)
	return v, ok
}

// ContextWithValidationResult is a test-only mirror of [Middleware]'s
// internal context write. Production code MUST go through Middleware;
// callers that need to unit-test a handler in isolation use this to
// inject a synthetic ValidationResult without spinning up the full
// validator + bearer-token round-trip.
func ContextWithValidationResult(ctx context.Context, r ValidationResult) context.Context {
	return context.WithValue(ctx, validationResultCtxKey{}, r)
}

// Middleware returns an http.Handler that requires a valid Bearer
// token. On missing or invalid tokens it writes a JSON 401 and never
// calls next. When the validator surfaces a specific Reason (e.g.
// tok_dev rejected outside dev mode), that reason is used verbatim in
// the 401 body so operators see the actionable message.
//
// On success the resolved [ValidationResult] is stashed in the
// request context so downstream wrappers (e.g. [AdminRequired])
// can consult IsAdmin without a second Validate call.
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
		ctx := context.WithValue(r.Context(), validationResultCtxKey{}, result)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// AdminRequired wraps the standard ``Middleware`` gate and additionally
// requires the authenticated token to carry ``IsAdmin=true``. Use this
// for endpoints that mutate fleet-wide state (e.g. /v1/admin/
// reconcile-agents). Admin is a superset of the regular bearer gate,
// so an admin token hitting a plain ``Middleware``-wrapped route
// passes there too — callers don't need a separate token per
// sensitivity class.
//
// On a valid-but-non-admin token the handler returns 403 Forbidden
// with an ``admin token required`` body, NOT 401 — the token IS valid,
// it just lacks the needed scope.
func AdminRequired(v *Validator, next http.Handler) http.Handler {
	return Middleware(v, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Phase 4.5 M-2: read the validated result from the
		// request context that Middleware just populated, instead
		// of calling Validate again. The double-call previously
		// opened a TOCTOU window if the auth cache expired between
		// the two lookups (rare but possible under cache eviction
		// pressure). Reading from context guarantees IsAdmin is
		// evaluated against the same row Middleware already
		// authenticated against.
		result, ok := ValidationResultFromContext(r.Context())
		if !ok {
			// Should be unreachable: Middleware always stashes the
			// result on the success path. Fail closed if invariant
			// is violated.
			writeJSONError(w, http.StatusInternalServerError, "auth context missing")
			return
		}
		if !result.IsAdmin {
			writeJSONError(w, http.StatusForbidden, "admin token required")
			return
		}
		next.ServeHTTP(w, r)
	}))
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
