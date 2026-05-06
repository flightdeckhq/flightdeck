// MCP Protection Policy SQL methods on Store. Per Rule 35 every SQL
// query for the policy lives in this file. The mutation paths run
// inside a single BEGIN/COMMIT block so version-bump + entries-replace
// + audit-log entry land atomically.
//
// See ARCHITECTURE.md "MCP Protection Policy" → "Audit and versioning"
// for the transaction shape and DECISIONS.md D128 for the storage
// schema rationale.

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// dryRunReplayCap bounds the dry-run query result set per D137 so a
// fleet with millions of historical events can't degenerate the
// preview. Sampled descending by occurred_at so the most recent
// traffic always weighs.
const dryRunReplayCap = 10000

// EnsureGlobalMCPPolicy is the boot-time idempotent insert per D133.
// Race-safe under read-committed because the unique index
// (scope, COALESCE(scope_value, '')) rejects a concurrent second
// insert; the unique-violation is treated as "already created" and
// the caller continues.
func (s *Store) EnsureGlobalMCPPolicy(ctx context.Context) error {
	const sql = `
		INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
		SELECT 'global', NULL, 'blocklist', false
		WHERE NOT EXISTS (SELECT 1 FROM mcp_policies WHERE scope = 'global')
	`
	if _, err := s.pool.Exec(ctx, sql); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// Unique violation — a parallel API instance won the
			// race. Treat as already-created.
			return nil
		}
		return fmt.Errorf("ensure global mcp policy: %w", err)
	}
	return nil
}

// GetGlobalMCPPolicy returns the singleton global policy + entries.
// Always returns a non-nil policy after EnsureGlobalMCPPolicy has
// run (which is at API boot).
func (s *Store) GetGlobalMCPPolicy(ctx context.Context) (*MCPPolicy, error) {
	return s.fetchPolicyByScope(ctx, "global", "")
}

// GetMCPPolicy returns the flavor policy + entries. Returns
// (nil, nil) when no flavor policy exists so the handler can
// distinguish 404 from a real DB error.
func (s *Store) GetMCPPolicy(ctx context.Context, flavor string) (*MCPPolicy, error) {
	return s.fetchPolicyByScope(ctx, "flavor", flavor)
}

func (s *Store) fetchPolicyByScope(ctx context.Context, scope, scopeValue string) (*MCPPolicy, error) {
	var (
		policy      MCPPolicy
		scopeVal    *string
		modeNullable *string
	)
	const policySQL = `
		SELECT id::text, scope, scope_value, mode, block_on_uncertainty,
		       version, created_at, updated_at
		  FROM mcp_policies
		 WHERE scope = $1 AND COALESCE(scope_value, '') = $2
	`
	err := s.pool.QueryRow(ctx, policySQL, scope, scopeValue).Scan(
		&policy.ID, &policy.Scope, &scopeVal, &modeNullable,
		&policy.BlockOnUncertainty, &policy.Version,
		&policy.CreatedAt, &policy.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("fetch mcp policy: %w", err)
	}
	policy.ScopeValue = scopeVal
	policy.Mode = modeNullable

	entries, err := s.fetchEntries(ctx, policy.ID)
	if err != nil {
		return nil, err
	}
	policy.Entries = entries
	return &policy, nil
}

func (s *Store) fetchEntries(ctx context.Context, policyID string) ([]MCPPolicyEntry, error) {
	const sql = `
		SELECT id::text, policy_id::text, server_url_canonical, server_name,
		       fingerprint, entry_kind, enforcement, created_at
		  FROM mcp_policy_entries
		 WHERE policy_id = $1
		 ORDER BY created_at ASC
	`
	rows, err := s.pool.Query(ctx, sql, policyID)
	if err != nil {
		return nil, fmt.Errorf("fetch mcp policy entries: %w", err)
	}
	defer rows.Close()

	entries := []MCPPolicyEntry{}
	for rows.Next() {
		var e MCPPolicyEntry
		if err := rows.Scan(&e.ID, &e.PolicyID, &e.ServerURLCanonical,
			&e.ServerName, &e.Fingerprint, &e.EntryKind,
			&e.Enforcement, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan mcp policy entry: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// CreateMCPPolicy inserts a new flavor policy + entries inside one
// transaction with version=1 and an audit-log entry.
//
// Resolved entries (each entry's server_url_canonical + fingerprint)
// must be supplied by the caller — this layer does not import the
// identity helper to avoid the test boundary, but per Rule 35 the
// SQL stays here.
func (s *Store) CreateMCPPolicy(
	ctx context.Context,
	flavor string,
	mut MCPPolicyMutation,
	resolvedEntries []MCPPolicyEntry,
	actorTokenID *string,
) (*MCPPolicy, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. INSERT mcp_policies
	const insertSQL = `
		INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
		VALUES ('flavor', $1, NULL, $2)
		RETURNING id::text, version, created_at, updated_at
	`
	var policy MCPPolicy
	policy.Scope = "flavor"
	policy.ScopeValue = &flavor
	policy.BlockOnUncertainty = mut.BlockOnUncertainty
	if err := tx.QueryRow(ctx, insertSQL, flavor, mut.BlockOnUncertainty).Scan(
		&policy.ID, &policy.Version, &policy.CreatedAt, &policy.UpdatedAt,
	); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrMCPPolicyAlreadyExists
		}
		return nil, fmt.Errorf("insert mcp policy: %w", err)
	}

	// 2. INSERT entries
	persisted, err := insertEntries(ctx, tx, policy.ID, resolvedEntries)
	if err != nil {
		return nil, err
	}
	policy.Entries = persisted

	// 3. INSERT version snapshot
	if err := insertVersionSnapshot(ctx, tx, policy, actorTokenID); err != nil {
		return nil, err
	}

	// 4. INSERT audit log
	if err := insertAuditLog(ctx, tx, policy.ID, "policy_created",
		actorTokenID, mut, nil); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit create policy: %w", err)
	}
	return &policy, nil
}

// UpdateMCPPolicy replaces the policy state — entries, mode (global
// only), block_on_uncertainty — inside one transaction. SELECT FOR
// UPDATE prevents version-bump races between concurrent PUTs. The
// auditPayload extras dict carries handler-supplied annotations like
// {"via":"import"} or {"applied_template":"strict-baseline"}.
func (s *Store) UpdateMCPPolicy(
	ctx context.Context,
	scope, scopeValue string,
	mut MCPPolicyMutation,
	resolvedEntries []MCPPolicyEntry,
	actorTokenID *string,
	auditPayloadExtras map[string]any,
) (*MCPPolicy, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. SELECT FOR UPDATE current row
	const selectSQL = `
		SELECT id::text, mode, block_on_uncertainty, version
		  FROM mcp_policies
		 WHERE scope = $1 AND COALESCE(scope_value, '') = $2
		 FOR UPDATE
	`
	var (
		policyID    string
		oldMode     *string
		oldBOU      bool
		oldVersion  int
	)
	if err := tx.QueryRow(ctx, selectSQL, scope, scopeValue).Scan(
		&policyID, &oldMode, &oldBOU, &oldVersion,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrMCPPolicyNotFound
		}
		return nil, fmt.Errorf("lock mcp policy: %w", err)
	}

	// 2. UPDATE row (mode is only writable on global; the storage
	// CHECK enforces this regardless of what the caller supplies).
	const updateSQL = `
		UPDATE mcp_policies
		   SET mode = $1,
		       block_on_uncertainty = $2,
		       version = version + 1,
		       updated_at = NOW()
		 WHERE id = $3
		RETURNING version, created_at, updated_at
	`
	var (
		modeForWrite *string
		newPolicy    MCPPolicy
	)
	newPolicy.ID = policyID
	newPolicy.Scope = scope
	if scope == "flavor" {
		v := scopeValue
		newPolicy.ScopeValue = &v
		modeForWrite = nil // CHECK enforces: flavor rows have mode NULL
	} else {
		modeForWrite = mut.Mode
		newPolicy.Mode = mut.Mode
	}
	newPolicy.BlockOnUncertainty = mut.BlockOnUncertainty
	if err := tx.QueryRow(ctx, updateSQL,
		modeForWrite, mut.BlockOnUncertainty, policyID,
	).Scan(&newPolicy.Version, &newPolicy.CreatedAt, &newPolicy.UpdatedAt); err != nil {
		return nil, fmt.Errorf("update mcp policy: %w", err)
	}
	if scope == "global" {
		// global keeps its existing mode as the new mode unless
		// the caller supplied one
		if newPolicy.Mode == nil {
			newPolicy.Mode = oldMode
		}
	}

	// 3. DELETE existing entries; INSERT new entries
	const delEntriesSQL = `DELETE FROM mcp_policy_entries WHERE policy_id = $1`
	if _, err := tx.Exec(ctx, delEntriesSQL, policyID); err != nil {
		return nil, fmt.Errorf("delete entries: %w", err)
	}
	persisted, err := insertEntries(ctx, tx, policyID, resolvedEntries)
	if err != nil {
		return nil, err
	}
	newPolicy.Entries = persisted

	// 4. INSERT version snapshot
	if err := insertVersionSnapshot(ctx, tx, newPolicy, actorTokenID); err != nil {
		return nil, err
	}

	// 5. INSERT audit log
	if err := insertAuditLog(ctx, tx, policyID, "policy_updated",
		actorTokenID, mut, auditPayloadExtras); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit update policy: %w", err)
	}
	return &newPolicy, nil
}

// DeleteMCPPolicy removes a flavor policy. The audit-log entry is
// written first so the policy_id reference exists; the policy DELETE
// then sets the audit-log row's policy_id to NULL via ON DELETE SET
// NULL — the audit row survives the deletion and an operator can
// answer "who deleted what and when" later.
func (s *Store) DeleteMCPPolicy(ctx context.Context, flavor string, actorTokenID *string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const lookupSQL = `
		SELECT id::text FROM mcp_policies
		 WHERE scope = 'flavor' AND scope_value = $1
		 FOR UPDATE
	`
	var policyID string
	if err := tx.QueryRow(ctx, lookupSQL, flavor).Scan(&policyID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrMCPPolicyNotFound
		}
		return fmt.Errorf("lock for delete: %w", err)
	}

	if err := insertAuditLog(ctx, tx, policyID, "policy_deleted",
		actorTokenID, MCPPolicyMutation{}, map[string]any{"flavor": flavor}); err != nil {
		return err
	}

	const delSQL = `DELETE FROM mcp_policies WHERE id = $1`
	if _, err := tx.Exec(ctx, delSQL, policyID); err != nil {
		return fmt.Errorf("delete policy: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit delete policy: %w", err)
	}
	return nil
}

// ResolveMCPPolicy implements the D135 algorithm: flavor entry →
// global entry → global mode default. The caller passes the
// fingerprint that the API-side identity helper has already computed
// from server_url + server_name. Returns a non-nil result on every
// path; flavor=="" routes the resolve against global only.
func (s *Store) ResolveMCPPolicy(ctx context.Context, flavor, fingerprint string) (*MCPPolicyResolveResult, error) {
	// Step 1: flavor entry?
	if flavor != "" {
		const flavorEntrySQL = `
			SELECT mp.id::text, mpe.entry_kind, mpe.enforcement
			  FROM mcp_policies mp
			  JOIN mcp_policy_entries mpe ON mpe.policy_id = mp.id
			 WHERE mp.scope = 'flavor' AND mp.scope_value = $1
			   AND mpe.fingerprint = $2
		`
		var (
			policyID    string
			entryKind   string
			enforcement *string
		)
		err := s.pool.QueryRow(ctx, flavorEntrySQL, flavor, fingerprint).Scan(
			&policyID, &entryKind, &enforcement)
		switch {
		case err == nil:
			return &MCPPolicyResolveResult{
				Decision:     decisionFromEntry(entryKind, enforcement),
				DecisionPath: "flavor_entry",
				PolicyID:     policyID,
				Scope:        "flavor:" + flavor,
				Fingerprint:  fingerprint,
			}, nil
		case !errors.Is(err, pgx.ErrNoRows):
			return nil, fmt.Errorf("resolve flavor entry: %w", err)
		}
	}

	// Step 2: global entry?
	const globalEntrySQL = `
		SELECT mp.id::text, mpe.entry_kind, mpe.enforcement
		  FROM mcp_policies mp
		  JOIN mcp_policy_entries mpe ON mpe.policy_id = mp.id
		 WHERE mp.scope = 'global'
		   AND mpe.fingerprint = $1
	`
	var (
		gPolicyID    string
		gEntryKind   string
		gEnforcement *string
	)
	err := s.pool.QueryRow(ctx, globalEntrySQL, fingerprint).Scan(
		&gPolicyID, &gEntryKind, &gEnforcement)
	switch {
	case err == nil:
		return &MCPPolicyResolveResult{
			Decision:     decisionFromEntry(gEntryKind, gEnforcement),
			DecisionPath: "global_entry",
			PolicyID:     gPolicyID,
			Scope:        "global",
			Fingerprint:  fingerprint,
		}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return nil, fmt.Errorf("resolve global entry: %w", err)
	}

	// Step 3: global mode default
	const globalSQL = `
		SELECT id::text, mode, block_on_uncertainty
		  FROM mcp_policies
		 WHERE scope = 'global'
	`
	var (
		mPolicyID string
		mMode     string
		mBOU      bool
	)
	if err := s.pool.QueryRow(ctx, globalSQL).Scan(&mPolicyID, &mMode, &mBOU); err != nil {
		return nil, fmt.Errorf("resolve global mode default: %w", err)
	}

	// Per-flavor block_on_uncertainty (D135). When global mode is
	// allowlist AND flavor's BOU is true, fall-through still
	// resolves to block but with the audit-grade signal.
	flavorBOU := false
	if flavor != "" {
		const fbouSQL = `
			SELECT block_on_uncertainty
			  FROM mcp_policies
			 WHERE scope = 'flavor' AND scope_value = $1
		`
		_ = s.pool.QueryRow(ctx, fbouSQL, flavor).Scan(&flavorBOU)
	}

	decision := "allow"
	if mMode == "allowlist" {
		decision = "block"
	}
	scope := "global"
	if flavor != "" && flavorBOU && mMode == "allowlist" {
		scope = "flavor:" + flavor // attributed to the flavor that asked for BOU
	}
	return &MCPPolicyResolveResult{
		Decision:     decision,
		DecisionPath: "mode_default",
		PolicyID:     mPolicyID,
		Scope:        scope,
		Fingerprint:  fingerprint,
	}, nil
}

func decisionFromEntry(entryKind string, enforcement *string) string {
	if entryKind == "allow" {
		return "allow"
	}
	// deny entry — enforcement field upgrades the bare deny to
	// warn / block / interactive. Default for deny without
	// enforcement: block.
	if enforcement != nil && *enforcement != "" {
		return *enforcement
	}
	return "block"
}

// ListMCPPolicyVersions returns version metadata (no full snapshots)
// in DESC version order, paginated.
func (s *Store) ListMCPPolicyVersions(ctx context.Context, scope, scopeValue string, limit, offset int) ([]MCPPolicyVersionMeta, error) {
	const sql = `
		SELECT v.id::text, v.policy_id::text, v.version,
		       v.created_at, v.created_by::text
		  FROM mcp_policy_versions v
		  JOIN mcp_policies p ON p.id = v.policy_id
		 WHERE p.scope = $1 AND COALESCE(p.scope_value, '') = $2
		 ORDER BY v.version DESC
		 LIMIT $3 OFFSET $4
	`
	rows, err := s.pool.Query(ctx, sql, scope, scopeValue, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("list versions: %w", err)
	}
	defer rows.Close()

	versions := []MCPPolicyVersionMeta{}
	for rows.Next() {
		var v MCPPolicyVersionMeta
		var createdBy *string
		if err := rows.Scan(&v.ID, &v.PolicyID, &v.Version, &v.CreatedAt, &createdBy); err != nil {
			return nil, fmt.Errorf("scan version meta: %w", err)
		}
		v.CreatedBy = createdBy
		versions = append(versions, v)
	}
	return versions, rows.Err()
}

// GetMCPPolicyVersion returns one historical snapshot by integer
// version number (NOT by version_id UUID; the API path takes the
// integer to keep operator-typed URLs human-readable).
func (s *Store) GetMCPPolicyVersion(ctx context.Context, scope, scopeValue string, version int) (*MCPPolicyVersion, error) {
	const sql = `
		SELECT v.id::text, v.policy_id::text, v.version, v.snapshot,
		       v.created_at, v.created_by::text
		  FROM mcp_policy_versions v
		  JOIN mcp_policies p ON p.id = v.policy_id
		 WHERE p.scope = $1 AND COALESCE(p.scope_value, '') = $2
		   AND v.version = $3
	`
	var v MCPPolicyVersion
	var createdBy *string
	err := s.pool.QueryRow(ctx, sql, scope, scopeValue, version).Scan(
		&v.ID, &v.PolicyID, &v.Version, &v.Snapshot, &v.CreatedAt, &createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get version: %w", err)
	}
	v.CreatedBy = createdBy
	return &v, nil
}

// DiffMCPPolicyVersions fetches both snapshots and computes the
// structural diff in Go (easier to test, no JSONB-complexity in
// queries). Returns ErrMCPPolicyNotFound when either version is
// missing.
func (s *Store) DiffMCPPolicyVersions(ctx context.Context, scope, scopeValue string, fromVersion, toVersion int) (*MCPPolicyDiff, error) {
	from, err := s.GetMCPPolicyVersion(ctx, scope, scopeValue, fromVersion)
	if err != nil {
		return nil, err
	}
	to, err := s.GetMCPPolicyVersion(ctx, scope, scopeValue, toVersion)
	if err != nil {
		return nil, err
	}
	if from == nil || to == nil {
		return nil, ErrMCPPolicyNotFound
	}

	diff := &MCPPolicyDiff{
		FromVersion:    fromVersion,
		ToVersion:      toVersion,
		FromSnapshot:   from.Snapshot,
		ToSnapshot:     to.Snapshot,
		EntriesAdded:   []MCPPolicyEntry{},
		EntriesRemoved: []MCPPolicyEntry{},
		EntriesChanged: []EntryDiff{},
	}

	var fromShape, toShape MCPPolicy
	if err := json.Unmarshal(from.Snapshot, &fromShape); err != nil {
		return nil, fmt.Errorf("decode from snapshot: %w", err)
	}
	if err := json.Unmarshal(to.Snapshot, &toShape); err != nil {
		return nil, fmt.Errorf("decode to snapshot: %w", err)
	}

	if !stringPtrEqual(fromShape.Mode, toShape.Mode) {
		diff.ModeChanged = &DiffString{
			From: derefString(fromShape.Mode),
			To:   derefString(toShape.Mode),
		}
	}
	if fromShape.BlockOnUncertainty != toShape.BlockOnUncertainty {
		diff.BlockOnUncertaintyChanged = &DiffBool{
			From: fromShape.BlockOnUncertainty,
			To:   toShape.BlockOnUncertainty,
		}
	}

	fromByFP := map[string]MCPPolicyEntry{}
	for _, e := range fromShape.Entries {
		fromByFP[e.Fingerprint] = e
	}
	toByFP := map[string]MCPPolicyEntry{}
	for _, e := range toShape.Entries {
		toByFP[e.Fingerprint] = e
	}

	for fp, after := range toByFP {
		before, ok := fromByFP[fp]
		if !ok {
			diff.EntriesAdded = append(diff.EntriesAdded, after)
			continue
		}
		if !entriesEquivalent(before, after) {
			diff.EntriesChanged = append(diff.EntriesChanged, EntryDiff{
				Fingerprint: fp,
				Before:      before,
				After:       after,
			})
		}
	}
	for fp, before := range fromByFP {
		if _, ok := toByFP[fp]; !ok {
			diff.EntriesRemoved = append(diff.EntriesRemoved, before)
		}
	}

	return diff, nil
}

// ListMCPPolicyAuditLog paginates audit-log rows for a policy.
// eventType filter is applied when non-empty.
func (s *Store) ListMCPPolicyAuditLog(ctx context.Context, scope, scopeValue, eventType string, from, to *time.Time, limit, offset int) ([]MCPPolicyAuditLog, error) {
	conditions := []string{}
	args := []any{}
	argIdx := 1

	conditions = append(conditions, fmt.Sprintf(`p.scope = $%d`, argIdx))
	args = append(args, scope)
	argIdx++
	conditions = append(conditions, fmt.Sprintf(`COALESCE(p.scope_value, '') = $%d`, argIdx))
	args = append(args, scopeValue)
	argIdx++

	if eventType != "" {
		conditions = append(conditions, fmt.Sprintf(`a.event_type = $%d`, argIdx))
		args = append(args, eventType)
		argIdx++
	}
	if from != nil {
		conditions = append(conditions, fmt.Sprintf(`a.occurred_at >= $%d`, argIdx))
		args = append(args, *from)
		argIdx++
	}
	if to != nil {
		conditions = append(conditions, fmt.Sprintf(`a.occurred_at <= $%d`, argIdx))
		args = append(args, *to)
		argIdx++
	}
	args = append(args, limit, offset)

	query := fmt.Sprintf(`
		SELECT a.id::text, a.policy_id::text, a.event_type, a.actor::text,
		       a.payload, a.occurred_at
		  FROM mcp_policy_audit_log a
		  LEFT JOIN mcp_policies p ON p.id = a.policy_id
		 WHERE %s
		 ORDER BY a.occurred_at DESC
		 LIMIT $%d OFFSET $%d
	`, strings.Join(conditions, " AND "), argIdx, argIdx+1)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list audit log: %w", err)
	}
	defer rows.Close()

	logs := []MCPPolicyAuditLog{}
	for rows.Next() {
		var l MCPPolicyAuditLog
		var policyID, actor *string
		if err := rows.Scan(&l.ID, &policyID, &l.EventType, &actor, &l.Payload, &l.OccurredAt); err != nil {
			return nil, fmt.Errorf("scan audit log: %w", err)
		}
		l.PolicyID = policyID
		l.Actor = actor
		logs = append(logs, l)
	}
	return logs, rows.Err()
}

// granularityForPeriod maps the period query param to the
// time-bucket granularity used by date_trunc / generate_series in
// the metrics SQL. Locked in step 6.5: 24h → hour, 7d / 30d → day.
// Hour-level buckets at 30d would be 720 buckets per server which
// is too noisy for a sparkline; day-level at 24h would be a single
// data point which defeats the trend visualization.
func granularityForPeriod(period string) string {
	if period == "24h" || period == "" {
		return "hour"
	}
	return "day"
}

// granularityInterval returns the postgres interval string used in
// the generate_series step size. Mirrors granularityForPeriod.
func granularityInterval(granularity string) string {
	if granularity == "hour" {
		return "1 hour"
	}
	return "1 day"
}

// GetMCPPolicyMetrics aggregates policy_mcp_warn / policy_mcp_block
// events scoped to the flavor's policy. Returns BOTH time-bucketed
// series (zero-filled via generate_series so the dashboard sparkline
// renders honest gaps) AND per-server aggregate totals (used for the
// header summary table). Step 6.5 reshape — pre-step-6.5 callers
// only saw the aggregates. The aggregates are still computed in the
// SAME query as a separate windowed pass so the response stays
// single-fetch.
func (s *Store) GetMCPPolicyMetrics(ctx context.Context, scope, scopeValue, period string) (*MCPPolicyMetrics, error) {
	hours, err := periodToHours(period)
	if err != nil {
		return nil, err
	}
	granularity := granularityForPeriod(period)
	interval := granularityInterval(granularity)

	policyID, err := s.lookupPolicyID(ctx, scope, scopeValue)
	if err != nil {
		return nil, err
	}
	if policyID == "" {
		return &MCPPolicyMetrics{
			Period:          period,
			Granularity:     granularity,
			Buckets:         []MCPPolicyMetricsBucket{},
			BlocksPerServer: []ServerCountBucket{},
			WarnsPerServer:  []ServerCountBucket{},
		}, nil
	}

	// Aggregate per-server totals over the whole window. Powers the
	// header summary table on the dashboard.
	const aggregateSQL = `
		SELECT event_type,
		       payload->>'fingerprint'  AS fingerprint,
		       payload->>'server_name'  AS server_name,
		       COUNT(*) AS cnt
		  FROM events
		 WHERE event_type IN ('policy_mcp_warn', 'policy_mcp_block')
		   AND payload->>'policy_id' = $1
		   AND occurred_at >= NOW() - $2 * INTERVAL '1 hour'
		 GROUP BY event_type, fingerprint, server_name
		 ORDER BY cnt DESC
	`
	aggRows, err := s.pool.Query(ctx, aggregateSQL, policyID, hours)
	if err != nil {
		return nil, fmt.Errorf("query metrics aggregates: %w", err)
	}
	defer aggRows.Close()

	metrics := &MCPPolicyMetrics{
		Period:          period,
		Granularity:     granularity,
		Buckets:         []MCPPolicyMetricsBucket{},
		BlocksPerServer: []ServerCountBucket{},
		WarnsPerServer:  []ServerCountBucket{},
	}
	for aggRows.Next() {
		var (
			eventType string
			fp        *string
			name      *string
			count     int
		)
		if err := aggRows.Scan(&eventType, &fp, &name, &count); err != nil {
			return nil, fmt.Errorf("scan metrics aggregate row: %w", err)
		}
		bucket := ServerCountBucket{Count: count}
		if fp != nil {
			bucket.Fingerprint = *fp
		}
		if name != nil {
			bucket.ServerName = *name
		}
		switch eventType {
		case "policy_mcp_warn":
			metrics.WarnsPerServer = append(metrics.WarnsPerServer, bucket)
		case "policy_mcp_block":
			metrics.BlocksPerServer = append(metrics.BlocksPerServer, bucket)
		}
	}
	if err := aggRows.Err(); err != nil {
		return nil, fmt.Errorf("metrics aggregate rows: %w", err)
	}

	// Zero-filled time-bucket series. generate_series produces every
	// timestamp in the window at the chosen granularity even when no
	// matching event landed in that bucket — sparse data on a
	// security dashboard would render a flat-then-spike as a gradual
	// ramp, which misleads the operator (Step 6.5 PR Part B
	// rationale).
	bucketSQL := fmt.Sprintf(`
		WITH window_buckets AS (
			SELECT generate_series(
				date_trunc('%s', NOW() - $2 * INTERVAL '1 hour'),
				date_trunc('%s', NOW()),
				INTERVAL '%s'
			) AS bucket_ts
		),
		bucketed_events AS (
			SELECT date_trunc('%s', occurred_at) AS bucket_ts,
			       event_type,
			       payload->>'fingerprint'  AS fingerprint,
			       payload->>'server_name'  AS server_name,
			       COUNT(*) AS cnt
			  FROM events
			 WHERE event_type IN ('policy_mcp_warn', 'policy_mcp_block')
			   AND payload->>'policy_id' = $1
			   AND occurred_at >= NOW() - $2 * INTERVAL '1 hour'
			 GROUP BY bucket_ts, event_type, fingerprint, server_name
		)
		SELECT wb.bucket_ts,
		       be.event_type,
		       be.fingerprint,
		       be.server_name,
		       COALESCE(be.cnt, 0) AS cnt
		  FROM window_buckets wb
		  LEFT JOIN bucketed_events be ON be.bucket_ts = wb.bucket_ts
		 ORDER BY wb.bucket_ts ASC, be.event_type ASC
	`, granularity, granularity, interval, granularity)

	bucketRows, err := s.pool.Query(ctx, bucketSQL, policyID, hours)
	if err != nil {
		return nil, fmt.Errorf("query metrics buckets: %w", err)
	}
	defer bucketRows.Close()

	bucketByTimestamp := make(map[time.Time]*MCPPolicyMetricsBucket)
	bucketOrder := []time.Time{}
	for bucketRows.Next() {
		var (
			ts        time.Time
			eventType *string
			fp        *string
			name      *string
			count     int
		)
		if err := bucketRows.Scan(&ts, &eventType, &fp, &name, &count); err != nil {
			return nil, fmt.Errorf("scan metrics bucket row: %w", err)
		}
		// generate_series emits the timestamp UTC; preserve.
		ts = ts.UTC()
		entry, exists := bucketByTimestamp[ts]
		if !exists {
			entry = &MCPPolicyMetricsBucket{
				Timestamp: ts,
				Blocks:    []ServerCountBucket{},
				Warns:     []ServerCountBucket{},
			}
			bucketByTimestamp[ts] = entry
			bucketOrder = append(bucketOrder, ts)
		}
		// LEFT JOIN keeps empty slots — the row will have NULL
		// event_type / fingerprint / name. Skip the empty pad row;
		// the bucket is already in the map with empty slices.
		if eventType == nil {
			continue
		}
		serverBucket := ServerCountBucket{Count: count}
		if fp != nil {
			serverBucket.Fingerprint = *fp
		}
		if name != nil {
			serverBucket.ServerName = *name
		}
		switch *eventType {
		case "policy_mcp_warn":
			entry.Warns = append(entry.Warns, serverBucket)
		case "policy_mcp_block":
			entry.Blocks = append(entry.Blocks, serverBucket)
		}
	}
	if err := bucketRows.Err(); err != nil {
		return nil, fmt.Errorf("metrics bucket rows: %w", err)
	}
	for _, ts := range bucketOrder {
		metrics.Buckets = append(metrics.Buckets, *bucketByTimestamp[ts])
	}
	return metrics, nil
}

// DryRunCandidate is one event row pulled by DryRunMCPPolicyEvents
// for the handler's evaluation pass. The handler walks the
// SessionFingerprints JSONB to recover the canonical URL by name,
// then evaluates against the proposed policy.
type DryRunCandidate struct {
	EventID             string
	ServerName          string
	SessionFingerprints []byte // raw context.mcp_servers JSONB
}

// DryRunMCPPolicyEvents pulls the candidate set per D137. The
// proposed-policy evaluation runs in the handler so this layer stays
// SQL-only per Rule 35.
func (s *Store) DryRunMCPPolicyEvents(ctx context.Context, hours int) ([]DryRunCandidate, error) {
	const sql = `
		SELECT events.id::text,
		       COALESCE(events.payload->>'server_name', ''),
		       sessions.context->'mcp_servers'
		  FROM events
		  JOIN sessions ON sessions.session_id = events.session_id
		 WHERE events.event_type = 'mcp_tool_call'
		   AND events.occurred_at >= NOW() - $1 * INTERVAL '1 hour'
		 ORDER BY events.occurred_at DESC
		 LIMIT $2
	`
	rows, err := s.pool.Query(ctx, sql, hours, dryRunReplayCap)
	if err != nil {
		return nil, fmt.Errorf("dry run query: %w", err)
	}
	defer rows.Close()

	candidates := []DryRunCandidate{}
	for rows.Next() {
		var c DryRunCandidate
		if err := rows.Scan(&c.EventID, &c.ServerName, &c.SessionFingerprints); err != nil {
			return nil, fmt.Errorf("scan dry run candidate: %w", err)
		}
		candidates = append(candidates, c)
	}
	return candidates, rows.Err()
}

// lookupPolicyID returns the policy id for a (scope, scopeValue)
// pair, or empty string when no policy exists. The metrics handler
// uses this to short-circuit when no flavor policy has been created.
func (s *Store) lookupPolicyID(ctx context.Context, scope, scopeValue string) (string, error) {
	const sql = `
		SELECT id::text FROM mcp_policies
		 WHERE scope = $1 AND COALESCE(scope_value, '') = $2
	`
	var id string
	err := s.pool.QueryRow(ctx, sql, scope, scopeValue).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("lookup policy id: %w", err)
	}
	return id, nil
}

// ----- private helpers -----------------------------------------

func insertEntries(ctx context.Context, tx pgx.Tx, policyID string, entries []MCPPolicyEntry) ([]MCPPolicyEntry, error) {
	persisted := make([]MCPPolicyEntry, 0, len(entries))
	const sql = `
		INSERT INTO mcp_policy_entries
		    (policy_id, server_url_canonical, server_name, fingerprint,
		     entry_kind, enforcement)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id::text, created_at
	`
	for _, e := range entries {
		var id string
		var createdAt time.Time
		if err := tx.QueryRow(ctx, sql,
			policyID, e.ServerURLCanonical, e.ServerName, e.Fingerprint,
			e.EntryKind, e.Enforcement,
		).Scan(&id, &createdAt); err != nil {
			return nil, fmt.Errorf("insert entry: %w", err)
		}
		e.ID = id
		e.PolicyID = policyID
		e.CreatedAt = createdAt
		persisted = append(persisted, e)
	}
	return persisted, nil
}

func insertVersionSnapshot(ctx context.Context, tx pgx.Tx, policy MCPPolicy, actorTokenID *string) error {
	snapshot, err := json.Marshal(policy)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	const sql = `
		INSERT INTO mcp_policy_versions (policy_id, version, snapshot, created_by)
		VALUES ($1, $2, $3, $4)
	`
	if _, err := tx.Exec(ctx, sql, policy.ID, policy.Version, snapshot, actorTokenID); err != nil {
		return fmt.Errorf("insert version snapshot: %w", err)
	}
	return nil
}

func insertAuditLog(ctx context.Context, tx pgx.Tx, policyID, eventType string, actor *string, mut MCPPolicyMutation, extras map[string]any) error {
	payload := map[string]any{
		"block_on_uncertainty": mut.BlockOnUncertainty,
		"entry_count":          len(mut.Entries),
	}
	if mut.Mode != nil {
		payload["mode"] = *mut.Mode
	}
	for k, v := range extras {
		payload[k] = v
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal audit payload: %w", err)
	}
	const sql = `
		INSERT INTO mcp_policy_audit_log (policy_id, event_type, actor, payload)
		VALUES ($1, $2, $3, $4)
	`
	if _, err := tx.Exec(ctx, sql, policyID, eventType, actor, payloadJSON); err != nil {
		return fmt.Errorf("insert audit log: %w", err)
	}
	return nil
}

func periodToHours(period string) (int, error) {
	switch period {
	case "24h", "":
		return 24, nil
	case "7d":
		return 24 * 7, nil
	case "30d":
		return 24 * 30, nil
	default:
		return 0, fmt.Errorf("invalid period %q", period)
	}
}

func entriesEquivalent(a, b MCPPolicyEntry) bool {
	return a.ServerURLCanonical == b.ServerURLCanonical &&
		a.ServerName == b.ServerName &&
		a.EntryKind == b.EntryKind &&
		stringPtrEqual(a.Enforcement, b.Enforcement)
}

func stringPtrEqual(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ----- typed errors --------------------------------------------

// ErrMCPPolicyNotFound is returned by handlers as 404.
var ErrMCPPolicyNotFound = errors.New("mcp policy not found")

// ErrMCPPolicyAlreadyExists is returned on POST :flavor when a
// policy for that flavor already exists. Handler returns 409.
var ErrMCPPolicyAlreadyExists = errors.New("mcp policy already exists for this flavor")
