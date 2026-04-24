package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ReconcileResult captures what a ReconcileAgents call observed and
// corrected. Serialised verbatim by the /v1/admin/reconcile-agents
// handler so operators can see exactly which counters drifted and by
// how many agents. A clean stack returns AgentsUpdated=0 and an empty
// CountersUpdated map.
//
// Errors contains per-agent failures (one entry per agent that hit a
// per-agent SQL error). The top-level error return of ReconcileAgents
// is reserved for fatal database issues — listing agents, pool
// exhaustion, etc. — so callers can distinguish "scan failed
// completely" from "scanned N agents, three had issues, the rest
// reconciled".
type ReconcileResult struct {
	AgentsScanned   int            `json:"agents_scanned"`
	AgentsUpdated   int            `json:"agents_updated"`
	CountersUpdated map[string]int `json:"counters_updated"`
	DurationMs      int64          `json:"duration_ms"`
	Errors          []string       `json:"errors"`
}

// reconcileColumns lists the denormalised columns on the agents table
// that ReconcileAgents recomputes from sessions ground truth. The
// worker's write paths (workers/internal/writer/postgres.go) touch
// these on event arrivals but carry no decrement / compensate path,
// so drift can accumulate across session deletes, failed event
// processing, and pre-migration data. Keep in sync with the UPDATE
// below if a column is added or removed.
var reconcileColumns = []string{
	"total_sessions",
	"total_tokens",
	"first_seen_at",
	"last_seen_at",
}

// ReconcileAgents recomputes the denormalised rollup counters on every
// agent row from the sessions table (the ground truth). For each
// agent:
//
//  1. Read the stored rollup values.
//  2. Compute ground truth via COUNT / SUM / MIN / MAX on sessions.
//  3. If any column diverged, UPDATE the agent row within a per-agent
//     transaction and record which column(s) were corrected.
//
// Per-agent granularity balances lock scope with atomicity — a single
// outer transaction across all agents would hold row locks for
// minutes on a large fleet; per-column transactions would complicate
// "was this row corrected" accounting. Per-agent is the sweet spot.
//
// **Orphan policy** (conservative). When an agent has zero sessions,
// total_sessions and total_tokens are corrected to 0, but
// first_seen_at and last_seen_at are NOT touched. Overwriting those
// columns with NULL (MIN/MAX over an empty set) would be semantically
// wrong — the values were set by the original UpsertAgent at agent
// creation and carry ground-truth information about when the agent
// row itself appeared. Orphan-agent row cleanup is a separate
// decision and a separate PR.
//
// **Concurrency note**. ReconcileAgents is NOT atomic against
// concurrent worker writes. The worker's BumpAgentSessionCount /
// IncrementAgentTokens execute `SET col = col + N` as deltas; if a
// bump lands between our SELECT COUNT(*) and our UPDATE SET, the bump
// can overshoot by that delta and create drift the next reconcile
// fixes. In practice this window is bounded by per-agent events-per-
// second during reconcile, and admin invocation is rare enough (ops
// tooling, not a hot-path) that the residual drift converges over
// subsequent calls. Documented here rather than fixed because the
// alternative — a fleet-wide write barrier or advisory lock on the
// worker's hot path — costs more than the problem is worth at this
// scale.
func (s *Store) ReconcileAgents(ctx context.Context) (*ReconcileResult, error) {
	start := time.Now()
	result := &ReconcileResult{
		CountersUpdated: make(map[string]int),
		Errors:          []string{},
	}

	// List every agent id + its current rollup snapshot. Fewer
	// round-trips than re-selecting inside the per-agent transaction.
	type agentSnap struct {
		agentID       string
		firstSeenAt   time.Time
		lastSeenAt    time.Time
		totalSessions int
		totalTokens   int64
	}
	var agents []agentSnap

	rows, err := s.pool.Query(ctx, `
		SELECT agent_id::text, first_seen_at, last_seen_at, total_sessions, total_tokens
		FROM agents
		ORDER BY agent_id
	`)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var a agentSnap
		if err := rows.Scan(
			&a.agentID, &a.firstSeenAt, &a.lastSeenAt,
			&a.totalSessions, &a.totalTokens,
		); err != nil {
			return nil, fmt.Errorf("scan agent: %w", err)
		}
		agents = append(agents, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agents: %w", err)
	}

	result.AgentsScanned = len(agents)

	for _, a := range agents {
		corrected, perAgentErr := s.reconcileOneAgent(
			ctx, a.agentID,
			a.firstSeenAt, a.lastSeenAt,
			a.totalSessions, a.totalTokens,
		)
		if perAgentErr != nil {
			result.Errors = append(result.Errors,
				fmt.Sprintf("agent %s: %v", a.agentID, perAgentErr))
			continue
		}
		if len(corrected) > 0 {
			result.AgentsUpdated++
			for col := range corrected {
				result.CountersUpdated[col]++
			}
		}
	}

	result.DurationMs = time.Since(start).Milliseconds()
	return result, nil
}

// reconcileOneAgent computes ground truth for a single agent, compares
// to the provided current values, and writes back if any column
// diverged. Returns the set of columns that were corrected (empty set
// if the agent was already consistent).
func (s *Store) reconcileOneAgent(
	ctx context.Context,
	agentID string,
	curFirstSeen, curLastSeen time.Time,
	curSessions int, curTokens int64,
) (map[string]bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	// Rollback is a no-op after a successful Commit, so the defer is
	// safe regardless of the success path.
	defer func() { _ = tx.Rollback(ctx) }()

	// Ground truth from sessions. COALESCE on the SUM handles the
	// zero-sessions case; MIN/MAX stay NULL-able and surface as
	// pgtype-aware pointers so the orphan case is distinguishable
	// from "ground truth equal to epoch".
	var (
		trueSessions int
		trueTokens   int64
		trueMinStart *time.Time
		trueMaxSeen  *time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(tokens_used), 0),
			MIN(started_at),
			MAX(last_seen_at)
		FROM sessions
		WHERE agent_id = $1::uuid
	`, agentID).Scan(&trueSessions, &trueTokens, &trueMinStart, &trueMaxSeen)
	if err != nil {
		return nil, fmt.Errorf("query ground truth: %w", err)
	}

	corrected := make(map[string]bool)
	if trueSessions != curSessions {
		corrected["total_sessions"] = true
	}
	if trueTokens != curTokens {
		corrected["total_tokens"] = true
	}
	// Orphan case: MIN/MAX NULL. Leave first/last_seen_at untouched
	// per conservative policy documented on ReconcileAgents.
	if trueMinStart != nil && !trueMinStart.Equal(curFirstSeen) {
		corrected["first_seen_at"] = true
	}
	if trueMaxSeen != nil && !trueMaxSeen.Equal(curLastSeen) {
		corrected["last_seen_at"] = true
	}

	if len(corrected) == 0 {
		// Clean slate — no-op commit keeps the txid counter happy and
		// exercises the commit path for symmetry in tests.
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit clean: %w", err)
		}
		return corrected, nil
	}

	// Build the UPDATE. For the two counters we always SET to the
	// computed value; for the two timestamp columns we use COALESCE
	// so NULL (orphan) leaves the column untouched.
	var firstSeenArg, lastSeenArg *time.Time
	if corrected["first_seen_at"] {
		firstSeenArg = trueMinStart
	}
	if corrected["last_seen_at"] {
		lastSeenArg = trueMaxSeen
	}

	_, err = tx.Exec(ctx, `
		UPDATE agents SET
			total_sessions = $2,
			total_tokens   = $3,
			first_seen_at  = COALESCE($4, first_seen_at),
			last_seen_at   = COALESCE($5, last_seen_at)
		WHERE agent_id = $1::uuid
	`, agentID, trueSessions, trueTokens, firstSeenArg, lastSeenArg)
	if err != nil {
		return nil, fmt.Errorf("update agent: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return corrected, nil
}
