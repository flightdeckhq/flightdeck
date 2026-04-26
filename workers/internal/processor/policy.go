package processor

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	blockThresholdPct = 100
	policyCacheTTL    = 5 * time.Minute
)

// CachedPolicy holds a policy with its load timestamp for TTL expiry.
type CachedPolicy struct {
	TokenLimit   *int64
	WarnAtPct    *int
	DegradeAtPct *int
	DegradeTo    *string
	BlockAtPct   *int
	LoadedAt     time.Time
}

// PolicyEvaluator checks token thresholds after each post_call event.
// Uses an in-memory cache to avoid per-event Postgres queries.
// Cache is invalidated on policy_update directive and expires after policyCacheTTL.
type PolicyEvaluator struct {
	pool    *pgxpool.Pool
	cache   map[string]*CachedPolicy
	cacheMu sync.RWMutex
	fired   map[string]map[string]bool // session_id -> directive_type -> fired
	firedMu sync.RWMutex
}

// NewPolicyEvaluator creates a PolicyEvaluator with an empty cache.
func NewPolicyEvaluator(pool *pgxpool.Pool) *PolicyEvaluator {
	return &PolicyEvaluator{
		pool:  pool,
		cache: make(map[string]*CachedPolicy),
		fired: make(map[string]map[string]bool),
	}
}

// InvalidateCache removes cached policies for a flavor.
func (pe *PolicyEvaluator) InvalidateCache(flavor string) {
	pe.cacheMu.Lock()
	defer pe.cacheMu.Unlock()
	delete(pe.cache, "flavor:"+flavor)
	delete(pe.cache, "org:")
}

// getPolicy returns the effective policy for a session, using cache when possible.
// Lookup order: session scope -> flavor scope -> org scope -> nil (no policy).
func (pe *PolicyEvaluator) getPolicy(ctx context.Context, flavor, sessionID string) *CachedPolicy {
	// Check cache first. Phase 4.5 M-25: an expired entry on a
	// higher-priority scope (session > flavor > org) used to leave
	// the entry in the map, fall through to the next scope, and
	// rebuild only the matched scope's key — leaving the expired
	// entry as zombie cache that would be re-checked next call. Now
	// we evict expired entries inline so the next miss does a clean
	// loadPolicyFromDB and repopulates from the correct scope.
	for _, key := range []string{
		"session:" + sessionID,
		"flavor:" + flavor,
		"org:",
	} {
		pe.cacheMu.RLock()
		cached, ok := pe.cache[key]
		pe.cacheMu.RUnlock()
		if !ok {
			continue
		}
		if time.Since(cached.LoadedAt) < policyCacheTTL {
			return cached
		}
		pe.cacheMu.Lock()
		// Re-check under the write lock in case another goroutine
		// already refreshed the entry between our RLock and Lock.
		if c2, ok2 := pe.cache[key]; ok2 && time.Since(c2.LoadedAt) >= policyCacheTTL {
			delete(pe.cache, key)
		}
		pe.cacheMu.Unlock()
	}

	// Cache miss or expired -- query Postgres with cascading lookup
	policy := pe.loadPolicyFromDB(ctx, flavor, sessionID)
	return policy
}

func (pe *PolicyEvaluator) loadPolicyFromDB(ctx context.Context, flavor, sessionID string) *CachedPolicy {
	// Try session scope
	if sessionID != "" {
		if p := pe.queryPolicy(ctx, "session", sessionID); p != nil {
			pe.cachePolicy("session:"+sessionID, p)
			return p
		}
	}
	// Try flavor scope
	if flavor != "" {
		if p := pe.queryPolicy(ctx, "flavor", flavor); p != nil {
			pe.cachePolicy("flavor:"+flavor, p)
			return p
		}
	}
	// Try org scope
	if p := pe.queryPolicy(ctx, "org", ""); p != nil {
		pe.cachePolicy("org:", p)
		return p
	}
	return nil
}

func (pe *PolicyEvaluator) queryPolicy(ctx context.Context, scope, scopeValue string) *CachedPolicy {
	var cp CachedPolicy
	err := pe.pool.QueryRow(ctx, `
		SELECT token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct
		FROM token_policies WHERE scope = $1 AND scope_value = $2
	`, scope, scopeValue).Scan(
		&cp.TokenLimit, &cp.WarnAtPct, &cp.DegradeAtPct, &cp.DegradeTo, &cp.BlockAtPct,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		slog.Error("policy query error", "scope", scope, "scope_value", scopeValue, "err", err)
		return nil
	}
	cp.LoadedAt = time.Now()
	return &cp
}

func (pe *PolicyEvaluator) cachePolicy(key string, p *CachedPolicy) {
	pe.cacheMu.Lock()
	defer pe.cacheMu.Unlock()
	pe.cache[key] = p
}

// HasFired checks if a directive type has already fired for a session.
//
// Deprecated for production use. This + MarkFired form a TOCTOU
// pair — if two goroutines run HasFired/MarkFired concurrently they
// can both observe ``false`` and both fire. Use [CheckAndMarkFired]
// for atomic check-and-set. Retained as exported only for tests
// that legitimately need to inspect or seed firing state without
// triggering the atomic semantics. Phase 4.5 M-12.
func (pe *PolicyEvaluator) HasFired(sessionID, directiveType string) bool {
	pe.firedMu.RLock()
	defer pe.firedMu.RUnlock()
	if m, ok := pe.fired[sessionID]; ok {
		return m[directiveType]
	}
	return false
}

// MarkFired records that a directive type has fired for a session.
//
// Deprecated for production use. Production code MUST use
// [CheckAndMarkFired] for atomic check-and-set. Retained only for
// tests that need to seed firing state. Phase 4.5 M-12.
func (pe *PolicyEvaluator) MarkFired(sessionID, directiveType string) {
	pe.firedMu.Lock()
	defer pe.firedMu.Unlock()
	if pe.fired[sessionID] == nil {
		pe.fired[sessionID] = make(map[string]bool)
	}
	pe.fired[sessionID][directiveType] = true
}

// CheckAndMarkFired atomically checks if a directive type has fired and marks it.
// Returns true if the caller should fire the directive (was not previously fired).
// This avoids the TOCTOU race between separate HasFired/MarkFired calls.
func (pe *PolicyEvaluator) CheckAndMarkFired(sessionID, directiveType string) bool {
	pe.firedMu.Lock()
	defer pe.firedMu.Unlock()
	if pe.fired[sessionID] == nil {
		pe.fired[sessionID] = make(map[string]bool)
	}
	if pe.fired[sessionID][directiveType] {
		return false
	}
	pe.fired[sessionID][directiveType] = true
	return true
}

// Evaluate checks the session's token usage against the effective policy.
// Writes warn, degrade, or shutdown directives to the directives table.
func (pe *PolicyEvaluator) Evaluate(ctx context.Context, sessionID string) error {
	var tokensUsed int
	var flavor string
	err := pe.pool.QueryRow(ctx, `
		SELECT tokens_used, flavor FROM sessions WHERE session_id = $1::uuid
	`, sessionID).Scan(&tokensUsed, &flavor)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	policy := pe.getPolicy(ctx, flavor, sessionID)
	if policy == nil || policy.TokenLimit == nil || *policy.TokenLimit <= 0 {
		return nil
	}

	limit := *policy.TokenLimit
	// Phase 4.5 L-12: Multiply before divide preserves precision but
	// is safe from overflow at any realistic input. tokensUsed is
	// the per-session running total (int from sessions table), and
	// int64.Max is ~9.2e18, so tokensUsed would need to exceed
	// ~9.2e16 (two orders of magnitude beyond any conceivable LLM
	// session) before the multiplication overflows int64. The DB
	// column itself caps at INT (2.1e9) so the mul is always safe.
	pctUsed := (int64(tokensUsed) * 100) / limit

	// Check block threshold
	blockPct := int64(blockThresholdPct)
	if policy.BlockAtPct != nil {
		blockPct = int64(*policy.BlockAtPct)
	}
	if pctUsed >= blockPct {
		return pe.writeDirective(ctx, sessionID, flavor, "shutdown", "token_budget_exceeded", nil)
	}

	// Check degrade threshold (fire-once per session, atomic check-and-mark)
	if policy.DegradeAtPct != nil && pctUsed >= int64(*policy.DegradeAtPct) {
		if pe.CheckAndMarkFired(sessionID, "degrade") {
			return pe.writeDirective(ctx, sessionID, flavor, "degrade", "token_budget_degrade", policy.DegradeTo)
		}
	}

	// Check warn threshold (fire-once per session, atomic check-and-mark)
	if policy.WarnAtPct != nil && pctUsed >= int64(*policy.WarnAtPct) {
		if pe.CheckAndMarkFired(sessionID, "warn") {
			return pe.writeDirective(ctx, sessionID, flavor, "warn", "token_budget_warning", nil)
		}
	}

	return nil
}

func (pe *PolicyEvaluator) writeDirective(
	ctx context.Context,
	sessionID, flavor, action, reason string,
	degradeTo *string,
) error {
	// For shutdown: always write (no dedup -- fires on every post_call past limit)
	// For warn/degrade: already deduped by hasFired/markFired
	if action == "shutdown" {
		// Check if shutdown already pending
		var exists bool
		err := pe.pool.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM directives
			WHERE session_id = $1::uuid AND action = 'shutdown' AND delivered_at IS NULL)
		`, sessionID).Scan(&exists)
		if err != nil {
			return err
		}
		if exists {
			return nil
		}
	}

	query := `INSERT INTO directives (session_id, flavor, action, reason, degrade_to, issued_by) VALUES ($1::uuid, $2, $3, $4, $5, 'policy_evaluator')`
	_, err := pe.pool.Exec(ctx, query, sessionID, flavor, action, reason, degradeTo)
	if err != nil {
		return err
	}

	slog.Info("policy directive issued", "session_id", sessionID, "action", action, "reason", reason)
	return nil
}
