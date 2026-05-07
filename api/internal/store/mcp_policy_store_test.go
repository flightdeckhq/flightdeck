// MCP Protection Policy store tests. Use the same newTestStore +
// dbURLForTest pattern as agents_reconcile_test.go. Tests skip
// cleanly when no TEST_POSTGRES_URL / FLIGHTDECK_POSTGRES_URL is
// set so `go test ./...` stays green on workstations without a
// running dev stack.
//
// Each test creates an isolated fixture (random flavor name) so
// concurrent test runs don't collide on the (scope, scope_value)
// uniqueness invariant. t.Cleanup wipes after each test.

package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// fingerprintLiteral mirrors the canonical D127 hash without
// importing the api/internal/mcp_identity package (would be a
// cyclic-test artifact for store-only tests). The store's
// ResolveMCPPolicy takes the fingerprint as input from the
// handler — store tests can use any 16+ hex string.
func fingerprintLiteral(seed string) string {
	// Stable per-seed pseudo-fingerprint sufficient for store
	// uniqueness — store tests don't validate the hash itself,
	// only that lookups by fingerprint hit the right row.
	const padding = "0000000000000000"
	out := strings.Repeat("0", 16) + seed
	if len(out) < 64 {
		out += strings.Repeat("0", 64-len(out))
	}
	_ = padding
	return out[:64]
}

func uniqueFlavor(t *testing.T) string {
	t.Helper()
	return "test-mcp-" + randomUUID(t)[:8]
}

func cleanupMCPPolicyByFlavor(t *testing.T, s *Store, flavor string) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx,
		`DELETE FROM mcp_policies WHERE scope = 'flavor' AND scope_value = $1`,
		flavor); err != nil {
		t.Logf("cleanup mcp_policies: %v", err)
	}
}

func TestEnsureGlobalMCPPolicyIdempotent(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	// First call may insert (or no-op if a prior test / API run
	// already created the singleton). Both calls return nil.
	if err := store.EnsureGlobalMCPPolicy(ctx); err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	if err := store.EnsureGlobalMCPPolicy(ctx); err != nil {
		t.Fatalf("second ensure (idempotency): %v", err)
	}

	// Verify exactly one global row exists.
	var count int
	if err := store.pool.QueryRow(ctx,
		`SELECT count(*) FROM mcp_policies WHERE scope = 'global'`,
	).Scan(&count); err != nil {
		t.Fatalf("count global: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 global policy, got %d", count)
	}
}

// TestGlobalMCPPolicySeededByMigration asserts the post-migration
// invariant from migration 000019: a fresh dev stack has the global
// policy row present without anyone calling EnsureGlobalMCPPolicy.
// This guards the cold-boot race where api boots before workers has
// applied migrations -- the seed migration is the single writer that
// guarantees the row exists, and this test fails loudly if the seed
// is dropped, mode drifts off the blocklist default, or
// block_on_uncertainty drifts off false.
func TestGlobalMCPPolicySeededByMigration(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	var (
		count              int
		mode               *string
		blockOnUncertainty bool
		version            int
	)
	if err := store.pool.QueryRow(ctx, `
		SELECT count(*) FROM mcp_policies WHERE scope = 'global'
	`).Scan(&count); err != nil {
		t.Fatalf("count global rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected exactly 1 global mcp_policies row post-migration, got %d", count)
	}

	if err := store.pool.QueryRow(ctx, `
		SELECT mode, block_on_uncertainty, version
		  FROM mcp_policies
		 WHERE scope = 'global'
	`).Scan(&mode, &blockOnUncertainty, &version); err != nil {
		t.Fatalf("read global row: %v", err)
	}
	if mode == nil || *mode != "blocklist" {
		t.Errorf("seed mode = %v, want \"blocklist\"", mode)
	}
	if blockOnUncertainty {
		t.Errorf("seed block_on_uncertainty = true, want false")
	}
	if version != 1 {
		t.Errorf("seed version = %d, want 1", version)
	}
}

func TestGetGlobalMCPPolicyAlwaysReturns(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	if err := store.EnsureGlobalMCPPolicy(ctx); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	policy, err := store.GetGlobalMCPPolicy(ctx)
	if err != nil {
		t.Fatalf("GetGlobalMCPPolicy: %v", err)
	}
	if policy == nil {
		t.Fatal("expected non-nil global policy")
	}
	if policy.Scope != "global" {
		t.Errorf("scope = %q, want global", policy.Scope)
	}
	if policy.ScopeValue != nil {
		t.Errorf("scope_value = %v, want nil", policy.ScopeValue)
	}
	if policy.Mode == nil || (*policy.Mode != "blocklist" && *policy.Mode != "allowlist") {
		t.Errorf("mode = %v, want blocklist or allowlist", policy.Mode)
	}
}

func TestCreateMCPPolicyRoundTrip(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	mut := MCPPolicyMutation{BlockOnUncertainty: true}
	enforce := "block"
	resolved := []MCPPolicyEntry{{
		ServerURLCanonical: "https://maps.example.com/sse",
		ServerName:         "maps",
		Fingerprint:        fingerprintLiteral("maps"),
		EntryKind:          "allow",
		Enforcement:        &enforce,
	}}

	created, err := store.CreateMCPPolicy(ctx, flavor, mut, resolved, nil)
	if err != nil {
		t.Fatalf("CreateMCPPolicy: %v", err)
	}
	if created.Version != 1 {
		t.Errorf("created.Version = %d, want 1", created.Version)
	}
	if !created.BlockOnUncertainty {
		t.Errorf("BlockOnUncertainty = false, want true")
	}
	if len(created.Entries) != 1 {
		t.Fatalf("entries len = %d, want 1", len(created.Entries))
	}

	fetched, err := store.GetMCPPolicy(ctx, flavor)
	if err != nil {
		t.Fatalf("GetMCPPolicy: %v", err)
	}
	if fetched == nil || fetched.ID != created.ID {
		t.Fatalf("fetch round-trip mismatch")
	}
	if len(fetched.Entries) != 1 || fetched.Entries[0].ServerName != "maps" {
		t.Errorf("entry round-trip mismatch: %+v", fetched.Entries)
	}
}

func TestCreateMCPPolicyRejectsDuplicateFlavor(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	mut := MCPPolicyMutation{BlockOnUncertainty: false}
	if _, err := store.CreateMCPPolicy(ctx, flavor, mut, nil, nil); err != nil {
		t.Fatalf("first create: %v", err)
	}
	_, err := store.CreateMCPPolicy(ctx, flavor, mut, nil, nil)
	if err != ErrMCPPolicyAlreadyExists {
		t.Errorf("expected ErrMCPPolicyAlreadyExists, got %v", err)
	}
}

func TestUpdateMCPPolicyBumpsVersion(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	mut := MCPPolicyMutation{BlockOnUncertainty: false}
	created, err := store.CreateMCPPolicy(ctx, flavor, mut, nil, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Version != 1 {
		t.Fatalf("version = %d, want 1", created.Version)
	}

	mut2 := MCPPolicyMutation{BlockOnUncertainty: true}
	enforce := "warn"
	entries := []MCPPolicyEntry{{
		ServerURLCanonical: "https://x.example.com",
		ServerName:         "x",
		Fingerprint:        fingerprintLiteral("x"),
		EntryKind:          "deny",
		Enforcement:        &enforce,
	}}
	updated, err := store.UpdateMCPPolicy(ctx, "flavor", flavor, mut2, entries, nil, nil)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Version != 2 {
		t.Errorf("version after update = %d, want 2", updated.Version)
	}
	if !updated.BlockOnUncertainty {
		t.Errorf("BlockOnUncertainty = false after update, want true")
	}

	versions, err := store.ListMCPPolicyVersions(ctx, "flavor", flavor, 50, 0)
	if err != nil {
		t.Fatalf("list versions: %v", err)
	}
	if len(versions) < 2 {
		t.Errorf("expected >= 2 version snapshots, got %d", len(versions))
	}
}

func TestDeleteMCPPolicyPreservesAuditLog(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	if _, err := store.CreateMCPPolicy(ctx, flavor,
		MCPPolicyMutation{BlockOnUncertainty: false}, nil, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.DeleteMCPPolicy(ctx, flavor, nil); err != nil {
		t.Fatalf("delete: %v", err)
	}

	// Policy gone
	if p, err := store.GetMCPPolicy(ctx, flavor); err != nil {
		t.Fatalf("get after delete: %v", err)
	} else if p != nil {
		t.Errorf("expected nil policy after delete, got %+v", p)
	}

	// Audit log row survives with policy_id NULL after the SET NULL
	// cascade.
	var count int
	if err := store.pool.QueryRow(ctx,
		`SELECT count(*) FROM mcp_policy_audit_log
		   WHERE event_type = 'policy_deleted'
		     AND payload->>'flavor' = $1`, flavor,
	).Scan(&count); err != nil {
		t.Fatalf("count audit: %v", err)
	}
	if count == 0 {
		t.Errorf("expected audit-log row to survive delete")
	}
}

func TestResolveMCPPolicyPrecedence(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	if err := store.EnsureGlobalMCPPolicy(ctx); err != nil {
		t.Fatalf("ensure global: %v", err)
	}

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	flavorEntryFP := fingerprintLiteral("flavor-only")
	globalEntryFP := fingerprintLiteral("global-only")
	unmatchedFP := fingerprintLiteral("unmatched")

	enforce := "block"
	flavorEntries := []MCPPolicyEntry{{
		ServerURLCanonical: "https://flavor.example.com",
		ServerName:         "flavor-srv",
		Fingerprint:        flavorEntryFP,
		EntryKind:          "deny",
		Enforcement:        &enforce,
	}}
	if _, err := store.CreateMCPPolicy(ctx, flavor,
		MCPPolicyMutation{BlockOnUncertainty: false}, flavorEntries, nil); err != nil {
		t.Fatalf("create flavor: %v", err)
	}

	// Seed a global entry directly (avoiding mutation of the
	// shared global policy in test concurrency would require a
	// separate test database; a single global row is acceptable
	// for local sequential test runs).
	globalPolicy, err := store.GetGlobalMCPPolicy(ctx)
	if err != nil {
		t.Fatalf("get global: %v", err)
	}
	if _, err := store.pool.Exec(ctx, `
		INSERT INTO mcp_policy_entries (policy_id, server_url_canonical,
		    server_name, fingerprint, entry_kind, enforcement)
		VALUES ($1, $2, $3, $4, 'allow', NULL)`,
		globalPolicy.ID, "https://global.example.com", "global-srv", globalEntryFP); err != nil {
		t.Fatalf("seed global entry: %v", err)
	}
	t.Cleanup(func() {
		_, _ = store.pool.Exec(ctx,
			`DELETE FROM mcp_policy_entries WHERE fingerprint = $1`, globalEntryFP)
	})

	// Step 1: flavor entry wins
	r, err := store.ResolveMCPPolicy(ctx, flavor, flavorEntryFP)
	if err != nil {
		t.Fatalf("resolve flavor: %v", err)
	}
	if r.DecisionPath != "flavor_entry" {
		t.Errorf("decision_path = %q, want flavor_entry", r.DecisionPath)
	}
	if r.Decision != "block" {
		t.Errorf("decision = %q, want block", r.Decision)
	}

	// Step 2: global entry catches when flavor has no opinion
	r, err = store.ResolveMCPPolicy(ctx, flavor, globalEntryFP)
	if err != nil {
		t.Fatalf("resolve global: %v", err)
	}
	if r.DecisionPath != "global_entry" {
		t.Errorf("decision_path = %q, want global_entry", r.DecisionPath)
	}
	if r.Decision != "allow" {
		t.Errorf("decision = %q, want allow", r.Decision)
	}

	// Step 3: mode default applies to truly unknown URLs
	r, err = store.ResolveMCPPolicy(ctx, flavor, unmatchedFP)
	if err != nil {
		t.Fatalf("resolve mode default: %v", err)
	}
	if r.DecisionPath != "mode_default" {
		t.Errorf("decision_path = %q, want mode_default", r.DecisionPath)
	}
}

func TestDiffMCPPolicyVersions(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	enforce := "block"
	v1Entries := []MCPPolicyEntry{{
		ServerURLCanonical: "https://a.example.com",
		ServerName:         "a",
		Fingerprint:        fingerprintLiteral("a"),
		EntryKind:          "allow",
		Enforcement:        &enforce,
	}}
	if _, err := store.CreateMCPPolicy(ctx, flavor,
		MCPPolicyMutation{BlockOnUncertainty: false}, v1Entries, nil); err != nil {
		t.Fatalf("create v1: %v", err)
	}

	v2Entries := []MCPPolicyEntry{{
		ServerURLCanonical: "https://b.example.com",
		ServerName:         "b",
		Fingerprint:        fingerprintLiteral("b"),
		EntryKind:          "deny",
		Enforcement:        &enforce,
	}}
	if _, err := store.UpdateMCPPolicy(ctx, "flavor", flavor,
		MCPPolicyMutation{BlockOnUncertainty: true}, v2Entries, nil, nil); err != nil {
		t.Fatalf("update v2: %v", err)
	}

	diff, err := store.DiffMCPPolicyVersions(ctx, "flavor", flavor, 1, 2)
	if err != nil {
		t.Fatalf("diff: %v", err)
	}
	if diff.BlockOnUncertaintyChanged == nil ||
		diff.BlockOnUncertaintyChanged.From != false ||
		diff.BlockOnUncertaintyChanged.To != true {
		t.Errorf("BOU diff missing or wrong: %+v", diff.BlockOnUncertaintyChanged)
	}
	if len(diff.EntriesAdded) != 1 || diff.EntriesAdded[0].ServerName != "b" {
		t.Errorf("EntriesAdded mismatch: %+v", diff.EntriesAdded)
	}
	if len(diff.EntriesRemoved) != 1 || diff.EntriesRemoved[0].ServerName != "a" {
		t.Errorf("EntriesRemoved mismatch: %+v", diff.EntriesRemoved)
	}
}

func TestListMCPPolicyAuditLog(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	if _, err := store.CreateMCPPolicy(ctx, flavor,
		MCPPolicyMutation{BlockOnUncertainty: false}, nil, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := store.UpdateMCPPolicy(ctx, "flavor", flavor,
		MCPPolicyMutation{BlockOnUncertainty: true}, nil, nil, nil); err != nil {
		t.Fatalf("update: %v", err)
	}

	logs, err := store.ListMCPPolicyAuditLog(ctx, "flavor", flavor, "", nil, nil, 50, 0)
	if err != nil {
		t.Fatalf("list audit log: %v", err)
	}
	if len(logs) < 2 {
		t.Errorf("expected >= 2 audit-log rows (create + update), got %d", len(logs))
	}
	// Most recent first
	if logs[0].EventType != "policy_updated" {
		t.Errorf("first log event_type = %q, want policy_updated", logs[0].EventType)
	}
}

func TestGetMCPPolicyMetricsEmptyByDefault(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	if _, err := store.CreateMCPPolicy(ctx, flavor,
		MCPPolicyMutation{BlockOnUncertainty: false}, nil, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	metrics, err := store.GetMCPPolicyMetrics(ctx, "flavor", flavor, "24h")
	if err != nil {
		t.Fatalf("metrics: %v", err)
	}
	if len(metrics.WarnsPerServer) != 0 || len(metrics.BlocksPerServer) != 0 {
		t.Errorf("expected empty metrics buckets pre-step-4, got %+v", metrics)
	}
	if metrics.Period != "24h" {
		t.Errorf("period = %q, want 24h", metrics.Period)
	}
}

func TestGetMCPPolicyMetricsRejectsBadPeriod(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	if _, err := store.GetMCPPolicyMetrics(ctx, "flavor", "x", "garbage"); err == nil {
		t.Errorf("expected error for invalid period")
	}
}

func TestUpdateMissingPolicyReturnsNotFound(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := "test-mcp-missing-" + randomUUID(t)[:8]
	_, err := store.UpdateMCPPolicy(ctx, "flavor", flavor,
		MCPPolicyMutation{BlockOnUncertainty: false}, nil, nil, nil)
	if err != ErrMCPPolicyNotFound {
		t.Errorf("expected ErrMCPPolicyNotFound, got %v", err)
	}
}

func TestVersionSnapshotIsValidJSON(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	flavor := uniqueFlavor(t)
	t.Cleanup(func() { cleanupMCPPolicyByFlavor(t, store, flavor) })

	if _, err := store.CreateMCPPolicy(ctx, flavor,
		MCPPolicyMutation{BlockOnUncertainty: true}, nil, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	v, err := store.GetMCPPolicyVersion(ctx, "flavor", flavor, 1)
	if err != nil {
		t.Fatalf("get version: %v", err)
	}
	if v == nil {
		t.Fatal("expected v1 snapshot, got nil")
	}
	var decoded MCPPolicy
	if err := json.Unmarshal(v.Snapshot, &decoded); err != nil {
		t.Errorf("snapshot is not valid MCPPolicy JSON: %v", err)
	}
	if decoded.Version != 1 {
		t.Errorf("decoded version = %d, want 1", decoded.Version)
	}
}

func TestDryRunMCPPolicyEventsHonorsHoursWindow(t *testing.T) {
	store, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	// Smoke-only: no events to query against by default. The
	// integration test seeds events and asserts replay shape.
	candidates, err := store.DryRunMCPPolicyEvents(ctx, 1)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	// candidates may or may not be empty depending on dev-stack
	// state; the contract is "no error and a slice" rather than
	// a specific count.
	_ = candidates
	_ = time.Now()
}
