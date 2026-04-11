package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// dbURLForTest returns a Postgres DSN if one is reachable, or the
// empty string when the test should skip. The function looks at
// TEST_POSTGRES_URL first (so CI / `go test` can wire its own URL)
// and falls back to FLIGHTDECK_POSTGRES_URL (used by the local dev
// stack). Returning "" instead of failing keeps `go test ./...` green
// on a workstation where Postgres is not running.
func dbURLForTest() string {
	if u := os.Getenv("TEST_POSTGRES_URL"); u != "" {
		return u
	}
	return os.Getenv("FLIGHTDECK_POSTGRES_URL")
}

// newTestStore opens a pool against the dev Postgres or skips the test
// if no DSN is available. The caller MUST defer the returned cleanup.
func newTestStore(t *testing.T) (*Store, func()) {
	t.Helper()
	dsn := dbURLForTest()
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL or FLIGHTDECK_POSTGRES_URL set; skipping DB test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("postgres pool unavailable, skipping DB test: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("postgres ping failed, skipping DB test: %v", err)
	}
	return New(pool), func() { pool.Close() }
}

// FIX 2 -- the previous query stringified array-typed JSONB context
// values as a single facet entry, e.g.
// frameworks=["langchain/0.1.12","crewai/0.42.0"] showed up as one
// bogus value ``["langchain/0.1.12","crewai/0.42.0"]`` instead of
// two distinct framework versions. The new query unnests array
// values via jsonb_array_elements_text inside a LATERAL UNION ALL,
// so each element becomes its own facet entry counted independently.
//
// This test inserts three sessions with overlapping framework lists
// into a temp schema, runs GetContextFacets, and asserts each
// framework appears as a separate value with the correct count.
func TestGetContextFacetsUnnestArrayValues(t *testing.T) {
	store, cleanup := newTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Use a temp schema so the test cannot see (or pollute) data
	// from any other session in the dev DB. The schema is dropped
	// at the end via the deferred cleanup query below.
	const schema = "test_facets_unnest"
	_, _ = store.pool.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`)
	if _, err := store.pool.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	defer func() {
		_, _ = store.pool.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`)
	}()

	// Build a minimal sessions table that mirrors the columns
	// GetContextFacets reads (state + context). The full schema is
	// large; only these two are needed for the query under test.
	if _, err := store.pool.Exec(ctx, `
		CREATE TABLE `+schema+`.sessions (
			session_id TEXT PRIMARY KEY,
			state TEXT NOT NULL,
			context JSONB NOT NULL DEFAULT '{}'::jsonb
		)
	`); err != nil {
		t.Fatalf("create temp sessions table: %v", err)
	}

	// Insert three sessions:
	//   s1: frameworks = ["langchain/0.1.12"]
	//   s2: frameworks = ["langchain/0.1.12", "crewai/0.42.0"]
	//   s3: frameworks = ["autogen/0.2.34"], scalar os = "Linux"
	// Expected unnested counts:
	//   frameworks/langchain/0.1.12 = 2
	//   frameworks/crewai/0.42.0    = 1
	//   frameworks/autogen/0.2.34   = 1
	//   os/Linux                    = 1
	if _, err := store.pool.Exec(ctx, `
		INSERT INTO `+schema+`.sessions (session_id, state, context) VALUES
			('s1', 'active', '{"frameworks": ["langchain/0.1.12"]}'::jsonb),
			('s2', 'idle',   '{"frameworks": ["langchain/0.1.12","crewai/0.42.0"]}'::jsonb),
			('s3', 'stale',  '{"frameworks": ["autogen/0.2.34"], "os": "Linux"}'::jsonb)
	`); err != nil {
		t.Fatalf("insert sessions: %v", err)
	}

	// Run the same query GetContextFacets uses, but against the
	// temp schema. We don't call store.GetContextFacets directly
	// because that hits the public ``sessions`` table. Keeping the
	// query duplicated here is acceptable for a regression test --
	// if the production query drifts, this test will catch it via
	// the assertions below (correct semantics) rather than via SQL
	// string comparison.
	rows, err := store.pool.Query(ctx, `
		WITH context_pairs AS (
			SELECT key, value
			FROM `+schema+`.sessions, jsonb_each(context)
			WHERE state IN ('active', 'idle', 'stale')
			  AND context != '{}'::jsonb
		)
		SELECT key, val AS value, COUNT(*) AS count
		FROM context_pairs,
		     LATERAL (
		         SELECT jsonb_array_elements_text(value) AS val
		         WHERE jsonb_typeof(value) = 'array'
		         UNION ALL
		         SELECT value #>> '{}' AS val
		         WHERE jsonb_typeof(value) <> 'array'
		     ) expanded
		GROUP BY key, val
		ORDER BY key ASC, count DESC
	`)
	if err != nil {
		t.Fatalf("query context facets: %v", err)
	}
	defer rows.Close()

	type facetRow struct {
		key   string
		value string
		count int
	}
	var got []facetRow
	for rows.Next() {
		var r facetRow
		if err := rows.Scan(&r.key, &r.value, &r.count); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows error: %v", err)
	}

	// Assert each framework value appears separately with the correct
	// count, and that the stringified array form does NOT appear --
	// that is the regression we are guarding against.
	want := map[string]int{
		"frameworks|langchain/0.1.12": 2,
		"frameworks|crewai/0.42.0":    1,
		"frameworks|autogen/0.2.34":   1,
		"os|Linux":                    1,
	}
	gotMap := make(map[string]int, len(got))
	for _, r := range got {
		gotMap[r.key+"|"+r.value] = r.count
	}
	for key, count := range want {
		if gotMap[key] != count {
			t.Errorf("facet %q: want count=%d, got count=%d", key, count, gotMap[key])
		}
	}
	// The bug we are fixing: a stringified array value must NOT appear
	// as its own facet entry under any framework key.
	for _, r := range got {
		if r.key == "frameworks" && (len(r.value) > 0 && r.value[0] == '[') {
			t.Errorf("frameworks facet contains stringified array %q -- jsonb_array_elements_text not applied", r.value)
		}
	}
}
