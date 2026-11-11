// MCP Protection Policy SQL methods on Store. Per Rule 35 every SQL
// query for the policy lives in this file. The mutation paths run
// inside a single BEGIN/COMMIT block so entries-replace + audit-log
// entry land atomically.
//
// See ARCHITECTURE.md "MCP Protection Policy" → "Audit" for the
// transaction shape.

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// EnsureGlobalMCPPolicy is a boot-time idempotent retry. Migration
// 000019 seeds the global empty-blocklist row at install time,
// which closes the cold-boot race where api beat workers to a
// fresh database and 500'd until manual restart. This hook stays as
// a defensive noop for install paths where api may run before the
// migrator (e.g. future operator-managed Helm charts). Race-safe
// under read-committed because the unique index
// (scope, COALESCE(scope_value, ”)) rejects a concurrent second
// insert; the unique-violation is treated as "already created" and
// the caller continues.
func (s *Store) EnsureGlobalMCPPolicy(ctx context.Context) error {
	const query = `
		INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
		SELECT 'global', NULL, 'blocklist', FALSE
		WHERE NOT EXISTS (SELECT 1 FROM mcp_policies WHERE scope = 'global')
	`
	if _, err := s.db.ExecContext(ctx, query); err != nil {
		if storage.IsUniqueViolation(err) {
			// A parallel API instance won the race. Treat as
			// already-created.
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
		policy       MCPPolicy
		scopeVal     *string
		modeNullable *string
	)
	const policySQL = `
		SELECT CAST(id AS TEXT), scope, scope_value, mode, block_on_uncertainty,
		       created_at, updated_at
		  FROM mcp_policies
		 WHERE scope = $1 AND COALESCE(scope_value, '') = $2
	`
	err := s.reader().QueryRowContext(ctx, policySQL, scope, scopeValue).Scan(
		&policy.ID, &policy.Scope, &scopeVal, &modeNullable,
		&policy.BlockOnUncertainty,
		&policy.CreatedAt, &policy.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
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
	const query = `
		SELECT CAST(id AS TEXT), CAST(policy_id AS TEXT), server_url_canonical, server_name,
		       fingerprint, entry_kind, enforcement, created_at
		  FROM mcp_policy_entries
		 WHERE policy_id = $1
		 ORDER BY created_at ASC, id ASC
	`
	rows, err := s.reader().QueryContext(ctx, query, policyID)
	if err != nil {
		return nil, fmt.Errorf("fetch mcp policy entries: %w", err)
	}
	defer func() { _ = rows.Close() }()

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
// transaction with an audit-log entry.
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// 1. INSERT mcp_policies
	const insertSQL = `
		INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
		VALUES ('flavor', $1, NULL, $2)
		RETURNING CAST(id AS TEXT), created_at, updated_at
	`
	var policy MCPPolicy
	policy.Scope = "flavor"
	policy.ScopeValue = &flavor
	policy.BlockOnUncertainty = mut.BlockOnUncertainty
	var created, updated storage.Time
	if err := tx.QueryRowContext(ctx, insertSQL, flavor, mut.BlockOnUncertainty).Scan(
		&policy.ID, &created, &updated,
	); err != nil {
		if storage.IsUniqueViolation(err) {
			return nil, ErrMCPPolicyAlreadyExists
		}
		return nil, fmt.Errorf("insert mcp policy: %w", err)
	}
	policy.CreatedAt, policy.UpdatedAt = created.Time, updated.Time

	// 2. INSERT entries
	persisted, err := insertEntries(ctx, tx, policy.ID, resolvedEntries)
	if err != nil {
		return nil, err
	}
	policy.Entries = persisted

	// 3. INSERT audit log
	if err := insertAuditLog(ctx, tx, policy.ID, "policy_created",
		actorTokenID, mut, nil); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create policy: %w", err)
	}
	return &policy, nil
}

// UpdateMCPPolicy replaces the policy state — entries, mode (global
// only), block_on_uncertainty — inside one transaction. The row is
// locked for the transaction (SELECT FOR UPDATE on Postgres; on
// SQLite the writer's IMMEDIATE transaction holds the database's one
// write lock) so concurrent PUTs cannot lose an update. The
// auditPayload extras dict carries handler-supplied annotations like
// {"applied_template":"strict-baseline"}.
func (s *Store) UpdateMCPPolicy(
	ctx context.Context,
	scope, scopeValue string,
	mut MCPPolicyMutation,
	resolvedEntries []MCPPolicyEntry,
	actorTokenID *string,
	auditPayloadExtras map[string]any,
) (*MCPPolicy, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// 1. Lock and read the current row
	selectSQL := `
		SELECT CAST(id AS TEXT), mode, block_on_uncertainty
		  FROM mcp_policies
		 WHERE scope = $1 AND COALESCE(scope_value, '') = $2` + s.q.forUpdate()
	var (
		policyID string
		oldMode  *string
		oldBOU   bool
	)
	if err := tx.QueryRowContext(ctx, selectSQL, scope, scopeValue).Scan(
		&policyID, &oldMode, &oldBOU,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrMCPPolicyNotFound
		}
		return nil, fmt.Errorf("lock mcp policy: %w", err)
	}

	// 2. UPDATE row (mode is only writable on global; the storage
	// CHECK enforces this regardless of what the caller supplies).
	updateSQL := `
		UPDATE mcp_policies
		   SET mode = $1,
		       block_on_uncertainty = $2,
		       updated_at = ` + s.d.Now() + `
		 WHERE id = $3
		RETURNING created_at, updated_at
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
	var created, updated storage.Time
	if err := tx.QueryRowContext(ctx, updateSQL,
		modeForWrite, mut.BlockOnUncertainty, policyID,
	).Scan(&created, &updated); err != nil {
		return nil, fmt.Errorf("update mcp policy: %w", err)
	}
	newPolicy.CreatedAt, newPolicy.UpdatedAt = created.Time, updated.Time
	if scope == "global" {
		// global keeps its existing mode as the new mode unless
		// the caller supplied one
		if newPolicy.Mode == nil {
			newPolicy.Mode = oldMode
		}
	}

	// 3. DELETE existing entries; INSERT new entries
	const delEntriesSQL = `DELETE FROM mcp_policy_entries WHERE policy_id = $1`
	if _, err := tx.ExecContext(ctx, delEntriesSQL, policyID); err != nil {
		return nil, fmt.Errorf("delete entries: %w", err)
	}
	persisted, err := insertEntries(ctx, tx, policyID, resolvedEntries)
	if err != nil {
		return nil, err
	}
	newPolicy.Entries = persisted

	// 4. INSERT audit log
	if err := insertAuditLog(ctx, tx, policyID, "policy_updated",
		actorTokenID, mut, auditPayloadExtras); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	lookupSQL := `
		SELECT CAST(id AS TEXT) FROM mcp_policies
		 WHERE scope = 'flavor' AND scope_value = $1` + s.q.forUpdate()
	var policyID string
	if err := tx.QueryRowContext(ctx, lookupSQL, flavor).Scan(&policyID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrMCPPolicyNotFound
		}
		return fmt.Errorf("lock for delete: %w", err)
	}

	if err := insertAuditLog(ctx, tx, policyID, "policy_deleted",
		actorTokenID, MCPPolicyMutation{}, map[string]any{"flavor": flavor}); err != nil {
		return err
	}

	const delSQL = `DELETE FROM mcp_policies WHERE id = $1`
	if _, err := tx.ExecContext(ctx, delSQL, policyID); err != nil {
		return fmt.Errorf("delete policy: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete policy: %w", err)
	}
	return nil
}

// entryRestrictivenessOrder orders a scope's entries for one server URL
// most restrictive first, so a URL that carries several entries (names
// differ) resolves to the strictest: a deny that blocks (bare deny,
// block, interactive), then a deny that warns, then an allow. Entries of
// equal rank yield the same decision, so which of them is returned does
// not matter. The sensor and the plugin rank the same way.
const entryRestrictivenessOrder = `CASE
	WHEN mpe.entry_kind = 'allow' THEN 2
	WHEN mpe.enforcement = 'warn' THEN 1
	ELSE 0
END, mpe.created_at DESC`

// ResolveMCPPolicy implements the resolution algorithm: flavor entry →
// global entry → global mode default. The caller passes the
// fingerprint that the API-side identity helper has already computed
// from server_url + server_name. Returns a non-nil result on every
// path; flavor=="" routes the resolve against global only.
func (s *Store) ResolveMCPPolicy(ctx context.Context, flavor, canonicalURL, fingerprint string) (*MCPPolicyResolveResult, error) {
	// Step 1: flavor entry?
	if flavor != "" {
		const flavorEntrySQL = `
			SELECT CAST(mp.id AS TEXT), mpe.entry_kind, mpe.enforcement
			  FROM mcp_policies mp
			  JOIN mcp_policy_entries mpe ON mpe.policy_id = mp.id
			 WHERE mp.scope = 'flavor' AND mp.scope_value = $1
			   AND mpe.server_url_canonical = $2
			 ORDER BY ` + entryRestrictivenessOrder + `
			 LIMIT 1
		`
		var (
			policyID    string
			entryKind   string
			enforcement *string
		)
		err := s.reader().QueryRowContext(ctx, flavorEntrySQL, flavor, canonicalURL).Scan(
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
		case !errors.Is(err, sql.ErrNoRows):
			return nil, fmt.Errorf("resolve flavor entry: %w", err)
		}
	}

	// Step 2: global entry?
	const globalEntrySQL = `
		SELECT CAST(mp.id AS TEXT), mpe.entry_kind, mpe.enforcement
		  FROM mcp_policies mp
		  JOIN mcp_policy_entries mpe ON mpe.policy_id = mp.id
		 WHERE mp.scope = 'global'
		   AND mpe.server_url_canonical = $1
		 ORDER BY ` + entryRestrictivenessOrder + `
		 LIMIT 1
	`
	var (
		gPolicyID    string
		gEntryKind   string
		gEnforcement *string
	)
	err := s.reader().QueryRowContext(ctx, globalEntrySQL, canonicalURL).Scan(
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
	case !errors.Is(err, sql.ErrNoRows):
		return nil, fmt.Errorf("resolve global entry: %w", err)
	}

	// Step 3: global mode default
	const globalSQL = `
		SELECT CAST(id AS TEXT), mode, block_on_uncertainty
		  FROM mcp_policies
		 WHERE scope = 'global'
	`
	var (
		mPolicyID string
		mMode     string
		mBOU      bool
	)
	if err := s.reader().QueryRowContext(ctx, globalSQL).Scan(&mPolicyID, &mMode, &mBOU); err != nil {
		return nil, fmt.Errorf("resolve global mode default: %w", err)
	}

	// Per-flavor block_on_uncertainty. When global mode is
	// allowlist AND flavor's BOU is true, fall-through still
	// resolves to block but with the audit-grade signal.
	flavorBOU := false
	if flavor != "" {
		const fbouSQL = `
			SELECT block_on_uncertainty
			  FROM mcp_policies
			 WHERE scope = 'flavor' AND scope_value = $1
		`
		_ = s.reader().QueryRowContext(ctx, fbouSQL, flavor).Scan(&flavorBOU)
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
		SELECT CAST(a.id AS TEXT), CAST(a.policy_id AS TEXT), a.event_type, CAST(a.actor AS TEXT),
		       a.payload, a.occurred_at
		  FROM mcp_policy_audit_log a
		  LEFT JOIN mcp_policies p ON p.id = a.policy_id
		 WHERE %s
		 ORDER BY a.occurred_at DESC, %s
		 LIMIT $%d OFFSET $%d
	`, strings.Join(conditions, " AND "), s.q.auditLogTieBreak(), argIdx, argIdx+1)

	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list audit log: %w", err)
	}
	defer func() { _ = rows.Close() }()

	logs := []MCPPolicyAuditLog{}
	for rows.Next() {
		var l MCPPolicyAuditLog
		var policyID, actor *string
		var payloadRaw []byte
		if err := rows.Scan(&l.ID, &policyID, &l.EventType, &actor, &payloadRaw, &l.OccurredAt); err != nil {
			return nil, fmt.Errorf("scan audit log: %w", err)
		}
		l.PolicyID = policyID
		l.Actor = actor
		l.Payload = json.RawMessage(append([]byte(nil), payloadRaw...))
		logs = append(logs, l)
	}
	return logs, rows.Err()
}

// granularityForPeriod maps the period query param to the
// time-bucket granularity used by the metrics SQL: 24h → hour,
// 7d / 30d → day.
// Hour-level buckets at 30d would be 720 buckets per server which
// is too noisy for a sparkline; day-level at 24h would be a single
// data point which defeats the trend visualization.
func granularityForPeriod(period string) string {
	if period == "24h" || period == "" {
		return "hour"
	}
	return "day"
}

// bucketStep returns the width of a metrics bucket and truncates t to
// its start, the way the SQL truncation does.
func bucketStep(granularity string) (step time.Duration, trunc func(time.Time) time.Time) {
	if granularity == "hour" {
		return time.Hour, func(t time.Time) time.Time { return t.UTC().Truncate(time.Hour) }
	}
	return 24 * time.Hour, func(t time.Time) time.Time {
		t = t.UTC()
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	}
}

// GetMCPPolicyMetrics aggregates policy_mcp_warn / policy_mcp_block
// events scoped to the flavor's policy. Returns BOTH time-bucketed
// series (zero-filled so the dashboard sparkline renders honest gaps)
// AND per-server aggregate totals (used for the header summary
// table).
func (s *Store) GetMCPPolicyMetrics(ctx context.Context, scope, scopeValue, period string) (*MCPPolicyMetrics, error) {
	hours, err := periodToHours(period)
	if err != nil {
		return nil, err
	}
	granularity := granularityForPeriod(period)
	unit, _ := truncUnit(granularity)
	step, trunc := bucketStep(granularity)

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

	// The window is computed once here so the aggregates, the
	// bucketed events and the zero-fill share one clock reading.
	now := time.Now().UTC()
	since := now.Add(-time.Duration(hours) * time.Hour)
	d := s.d
	fingerprint := d.JSONText("payload", "fingerprint")
	serverName := d.JSONText("payload", "server_name")

	// Aggregate per-server totals over the whole window. Powers the
	// header summary table on the dashboard.
	aggregateSQL := `
		SELECT event_type,
		       ` + fingerprint + ` AS fingerprint,
		       ` + serverName + ` AS server_name,
		       COUNT(*) AS cnt
		  FROM events
		 WHERE event_type IN ('policy_mcp_warn', 'policy_mcp_block')
		   AND ` + d.JSONText("payload", "policy_id") + ` = $1
		   AND occurred_at >= $2
		 GROUP BY event_type, fingerprint, server_name
		 ORDER BY cnt DESC, event_type ASC, fingerprint ASC, server_name ASC
	`
	aggRows, err := s.reader().QueryContext(ctx, aggregateSQL, policyID, since)
	if err != nil {
		return nil, fmt.Errorf("query metrics aggregates: %w", err)
	}
	defer func() { _ = aggRows.Close() }()

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

	// Zero-filled time-bucket series. Every bucket in the window at
	// the chosen granularity is present even when no matching event
	// landed in it — sparse data on a security dashboard would render
	// a flat-then-spike as a gradual ramp, which misleads the operator.
	// The buckets are generated here from the same window the query
	// filters on; the query groups the events by the same truncation.
	bucketSQL := `
		SELECT ` + d.DateTrunc(unit, "occurred_at") + ` AS bucket_ts,
		       event_type,
		       ` + fingerprint + ` AS fingerprint,
		       ` + serverName + ` AS server_name,
		       COUNT(*) AS cnt
		  FROM events
		 WHERE event_type IN ('policy_mcp_warn', 'policy_mcp_block')
		   AND ` + d.JSONText("payload", "policy_id") + ` = $1
		   AND occurred_at >= $2
		 GROUP BY bucket_ts, event_type, fingerprint, server_name
		 ORDER BY bucket_ts ASC, event_type ASC, fingerprint ASC, server_name ASC
	`

	bucketRows, err := s.reader().QueryContext(ctx, bucketSQL, policyID, since)
	if err != nil {
		return nil, fmt.Errorf("query metrics buckets: %w", err)
	}
	defer func() { _ = bucketRows.Close() }()

	bucketByTimestamp := make(map[time.Time]*MCPPolicyMetricsBucket)
	for ts := trunc(since); !ts.After(trunc(now)); ts = ts.Add(step) {
		bucketByTimestamp[ts] = &MCPPolicyMetricsBucket{
			Timestamp: ts,
			Blocks:    []ServerCountBucket{},
			Warns:     []ServerCountBucket{},
		}
		metrics.Buckets = append(metrics.Buckets, MCPPolicyMetricsBucket{})
	}
	for bucketRows.Next() {
		var (
			ts        storage.Time
			eventType string
			fp        *string
			name      *string
			count     int
		)
		if err := bucketRows.Scan(&ts, &eventType, &fp, &name, &count); err != nil {
			return nil, fmt.Errorf("scan metrics bucket row: %w", err)
		}
		entry, exists := bucketByTimestamp[ts.Time.UTC()]
		if !exists {
			// Every event the query returns is at or after the
			// window's start, so its bucket is at or after the first
			// zero-filled one; only an event stamped after the clock
			// reading the buckets end at (a client clock ahead of the
			// server's) falls outside the series, and it is left out
			// rather than given a bucket the window does not show.
			continue
		}
		serverBucket := ServerCountBucket{Count: count}
		if fp != nil {
			serverBucket.Fingerprint = *fp
		}
		if name != nil {
			serverBucket.ServerName = *name
		}
		switch eventType {
		case "policy_mcp_warn":
			entry.Warns = append(entry.Warns, serverBucket)
		case "policy_mcp_block":
			entry.Blocks = append(entry.Blocks, serverBucket)
		}
	}
	if err := bucketRows.Err(); err != nil {
		return nil, fmt.Errorf("metrics bucket rows: %w", err)
	}
	i := 0
	for ts := trunc(since); !ts.After(trunc(now)); ts = ts.Add(step) {
		metrics.Buckets[i] = *bucketByTimestamp[ts]
		i++
	}
	return metrics, nil
}

// lookupPolicyID returns the policy id for a (scope, scopeValue)
// pair, or empty string when no policy exists. The metrics handler
// uses this to short-circuit when no flavor policy has been created.
func (s *Store) lookupPolicyID(ctx context.Context, scope, scopeValue string) (string, error) {
	const query = `
		SELECT CAST(id AS TEXT) FROM mcp_policies
		 WHERE scope = $1 AND COALESCE(scope_value, '') = $2
	`
	var id string
	err := s.reader().QueryRowContext(ctx, query, scope, scopeValue).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("lookup policy id: %w", err)
	}
	return id, nil
}

// ----- private helpers -----------------------------------------

func insertEntries(ctx context.Context, tx *sql.Tx, policyID string, entries []MCPPolicyEntry) ([]MCPPolicyEntry, error) {
	persisted := make([]MCPPolicyEntry, 0, len(entries))
	const query = `
		INSERT INTO mcp_policy_entries
		    (policy_id, server_url_canonical, server_name, fingerprint,
		     entry_kind, enforcement)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING CAST(id AS TEXT), created_at
	`
	for _, e := range entries {
		var id string
		var createdAt storage.Time
		if err := tx.QueryRowContext(ctx, query,
			policyID, e.ServerURLCanonical, e.ServerName, e.Fingerprint,
			e.EntryKind, e.Enforcement,
		).Scan(&id, &createdAt); err != nil {
			return nil, fmt.Errorf("insert entry: %w", err)
		}
		e.ID = id
		e.PolicyID = policyID
		e.CreatedAt = createdAt.Time
		persisted = append(persisted, e)
	}
	return persisted, nil
}

func insertAuditLog(ctx context.Context, tx *sql.Tx, policyID, eventType string, actor *string, mut MCPPolicyMutation, extras map[string]any) error {
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
	var actorID *string
	if actor != nil {
		id := uuidArg(*actor)
		actorID = &id
	}
	const query = `
		INSERT INTO mcp_policy_audit_log (policy_id, event_type, actor, payload)
		VALUES ($1, $2, $3, $4)
	`
	if _, err := tx.ExecContext(ctx, query, policyID, eventType, actorID, string(payloadJSON)); err != nil {
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
		return 0, fmt.Errorf("%w: %q", ErrMCPPolicyInvalidPeriod, period)
	}
}

// ----- typed errors --------------------------------------------

// ErrMCPPolicyNotFound is returned by handlers as 404.
var ErrMCPPolicyNotFound = errors.New("mcp policy not found")

// ErrMCPPolicyAlreadyExists is returned on POST :flavor when a
// policy for that flavor already exists. Handler returns 409.
var ErrMCPPolicyAlreadyExists = errors.New("mcp policy already exists for this flavor")

// ErrMCPPolicyInvalidPeriod is returned by periodToHours for unknown
// period values. Handlers convert to 400 with an actionable message
// listing the accepted vocabulary. Wrap with fmt.Errorf("%w: %q", ...)
// so callers can recover the offending period via errors.Unwrap +
// the formatted error text while the sentinel survives errors.Is.
var ErrMCPPolicyInvalidPeriod = errors.New("mcp policy: invalid period")
