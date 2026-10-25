package store

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestFrameworkDimensionUsesLateralUnnest guards the fix that made
// group_by=framework report real framework names instead of collapsing
// every row to 'unknown'. The sensor writes framework versions to
// sessions.context->'frameworks' (a JSONB array), so the dimension
// expression must reference the unnested alias “fw“ and the
// dimensionSource must contribute a LATERAL join fragment that the
// FROM clause builder appends to the query.
func TestFrameworkDimensionUsesLateralUnnest(t *testing.T) {
	dim, ok := dimensions["framework"]
	if !ok {
		t.Fatalf("dimensions[\"framework\"] is missing")
	}
	if dim.exprEvents != "fw" || dim.exprSessions != "fw" {
		t.Errorf(
			"framework dimension must project the unnested alias ``fw``; got exprEvents=%q exprSessions=%q",
			dim.exprEvents, dim.exprSessions,
		)
	}
	if !dim.needsSessionJoin {
		t.Error("framework dimension must set needsSessionJoin=true for event-based metrics")
	}
	if dim.fromExtras == "" {
		t.Fatal("framework dimension must carry a LATERAL join in fromExtras")
	}
	if !strings.Contains(dim.fromExtras, "jsonb_array_elements_text") {
		t.Errorf(
			"framework fromExtras must unnest via jsonb_array_elements_text; got %q",
			dim.fromExtras,
		)
	}
	if !strings.Contains(dim.fromExtras, "s.context->'frameworks'") {
		t.Errorf(
			"framework fromExtras must read s.context->'frameworks'; got %q",
			dim.fromExtras,
		)
	}
	if !strings.Contains(dim.fromExtras, "LEFT JOIN LATERAL") {
		t.Errorf(
			"framework fromExtras must be LEFT JOIN LATERAL so sessions with no frameworks still produce an 'unknown' row; got %q",
			dim.fromExtras,
		)
	}
}

// TestNonFrameworkDimensionsHaveNoFromExtras ensures the fromExtras
// escape hatch is only used by the framework dimension. If a future
// dimension needs it, the dimensions map entry and this assertion
// should be updated together.
func TestNonFrameworkDimensionsHaveNoFromExtras(t *testing.T) {
	for name, dim := range dimensions {
		if name == "framework" {
			continue
		}
		if dim.fromExtras != "" {
			t.Errorf("dimensions[%q].fromExtras should be empty, got %q", name, dim.fromExtras)
		}
	}
}

// TestSubAgentDimensionsBucketNullsAsRoot guards the agent_role and
// parent_session_id projections against the unknown-fallback drift
// the rest of the dimension family uses. The design spec
// (CLAUDE.md Rule 25, ARCHITECTURE.md analytics section) requires
// "(root)" as the null bucket for these two
// dims so the dashboard can label the no-parent / no-role bucket
// with a meaningful term rather than the generic "unknown" the
// other dims use.
func TestSubAgentDimensionsBucketNullsAsRoot(t *testing.T) {
	for _, name := range []string{"agent_role", "parent_session_id"} {
		dim, ok := dimensions[name]
		if !ok {
			t.Fatalf("dimensions[%q] is missing", name)
		}
		// COALESCE-to-(root) baked into the expression itself so
		// the outer COALESCE(<dim>, 'unknown') in the query builder
		// never overrides the (root) label. Asserting on the
		// expression text catches both regressions: (a) someone
		// dropping the COALESCE, (b) someone changing the literal
		// from "(root)" to "unknown".
		for _, expr := range []string{dim.exprEvents, dim.exprSessions} {
			if !strings.Contains(expr, "COALESCE") {
				t.Errorf("dimensions[%q] expression must wrap the column in COALESCE; got %q", name, expr)
			}
			if !strings.Contains(expr, "'(root)'") {
				t.Errorf("dimensions[%q] expression must use '(root)' as null label; got %q", name, expr)
			}
		}
		if !dim.needsSessionJoin {
			t.Errorf("dimensions[%q] must set needsSessionJoin=true so events-based metrics can group by it", name)
		}
	}
}

// TestParentSessionIDDimensionCastsToText covers the postgres-
// specific detail that parent_session_id is a UUID column and the
// projection must cast to text before COALESCE so the result column
// scans into a Go string. Catching the missing cast here is cheaper
// than a 500 in production when an operator first opens the new
// chart.
func TestParentSessionIDDimensionCastsToText(t *testing.T) {
	dim := dimensions["parent_session_id"]
	for _, expr := range []string{dim.exprEvents, dim.exprSessions} {
		if !strings.Contains(expr, "::text") {
			t.Errorf("parent_session_id dimension must cast UUID to text before COALESCE; got %q", expr)
		}
	}
}

// TestQueryAnalytics_TwoDimRejectsIdenticalAxes validates the
// store-level guard against a primary == secondary group_by. The
// handler also rejects this with a 400, but the store guard is the
// belt-and-suspenders that catches a future internal caller (Roadmap
// landing page, analytics export job) that bypasses the handler.
func TestQueryAnalytics_TwoDimRejectsIdenticalAxes(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	now := time.Now().UTC()
	_, err := s.QueryAnalytics(context.Background(), AnalyticsParams{
		Metric:           "tokens",
		GroupBy:          "flavor",
		GroupBySecondary: "flavor",
		Range:            "custom",
		From:             now.Add(-time.Hour),
		To:               now,
		Granularity:      "day",
	})
	if err == nil {
		t.Fatal("expected error for primary == secondary group_by")
	}
	if !strings.Contains(err.Error(), "must differ") {
		t.Errorf("expected 'must differ' error message; got %v", err)
	}
}

// TestQueryAnalytics_TwoDimRejectsInvalidSecondary covers the
// validation symmetry: the secondary axis goes through the same
// dimensions whitelist as the primary. Anything outside the locked
// list is a 400-equivalent error from the store.
func TestQueryAnalytics_TwoDimRejectsInvalidSecondary(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	now := time.Now().UTC()
	_, err := s.QueryAnalytics(context.Background(), AnalyticsParams{
		Metric:           "tokens",
		GroupBy:          "flavor",
		GroupBySecondary: "made_up_dim",
		Range:            "custom",
		From:             now.Add(-time.Hour),
		To:               now,
		Granularity:      "day",
	})
	if err == nil {
		t.Fatal("expected error for invalid secondary group_by")
	}
	if !strings.Contains(err.Error(), "secondary") {
		t.Errorf("expected 'secondary' error message; got %v", err)
	}
}

// TestQueryAnalytics_SingleDimRegression confirms that a single-dim
// query with the new code path returns DataPoints with NO
// “Breakdown“ field set. The wire shape promise is
// "Single-dim queries (no comma) preserve the single-axis wire shape
// exactly"; the omitempty tag handles the JSON layer, but the Go
// struct must also reflect the contract so a future caller reading
// .Breakdown.Length can rely on it being 0.
func TestQueryAnalytics_SingleDimRegression(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	flavor := "test-subagent-single-" + randomUUID(t)[:8]

	// Seed an agent first to satisfy the sessions.agent_id FK,
	// then a session + a post_call event so the query has data
	// to chart. State=closed so the row doesn't interact with
	// the reconciler in the shared test DB.
	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-1*time.Hour), now.Add(-30*time.Minute), 1, 100)
	sessionID := randomUUID(t)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 100,
			'production', 'flightdeck_sensor'
		)
	`, sessionID, agentID, flavor, now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO events (
			id, session_id, flavor, event_type, model,
			tokens_total, occurred_at, has_content
		) VALUES (
			gen_random_uuid(), $1::uuid, $2, 'post_call', 'claude-sonnet-4-6',
			100, $3, false
		)
	`, sessionID, flavor, now.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
	})

	resp, err := s.QueryAnalytics(ctx, AnalyticsParams{
		Metric:      "tokens",
		GroupBy:     "flavor",
		Range:       "custom",
		From:        now.Add(-time.Hour),
		To:          now,
		Granularity: "day",
		// FilterFlavor scopes us to our seeded fixture so other
		// concurrent test data in the shared dev DB doesn't bleed
		// into the assertion.
		FilterFlavor: flavor,
	})
	if err != nil {
		t.Fatalf("QueryAnalytics: %v", err)
	}
	if len(resp.Series) != 1 {
		t.Fatalf("expected 1 series, got %d", len(resp.Series))
	}
	for _, dp := range resp.Series[0].Data {
		if dp.Breakdown != nil {
			t.Errorf("single-dim DataPoint must have nil Breakdown; got %+v", dp.Breakdown)
		}
	}
}

// TestQueryAnalytics_TwoDimParentRoleBreakdown is the canonical
// integration test for the two-dimension group_by contract. Seed one parent
// session with two child sessions of different roles (Researcher /
// Writer); each child contributes tokens; assert the response
// returns one series per parent (one in this case) whose DataPoints
// carry a Breakdown[] with two entries summing to the row total.
func TestQueryAnalytics_TwoDimParentRoleBreakdown(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	parentSessionID := randomUUID(t)
	parentFlavor := "test-subagent-parent-" + randomUUID(t)[:8]
	childResearcher := randomUUID(t)
	childWriter := randomUUID(t)

	// Three agents (parent + two children) so the sessions.agent_id
	// FKs all resolve. Each agent uses its own ID; the identity derivation
	// creates a distinct agent_id per (5-tuple + role) pair so the
	// child sessions land under fresh agents anyway.
	parentAgentID := randomUUID(t)
	researcherAgentID := randomUUID(t)
	writerAgentID := randomUUID(t)
	seedAgent(t, s, parentAgentID, now.Add(-2*time.Hour), now.Add(-30*time.Minute), 1, 0)
	seedAgent(t, s, researcherAgentID, now.Add(-2*time.Hour), now.Add(-30*time.Minute), 1, 250)
	seedAgent(t, s, writerAgentID, now.Add(-2*time.Hour), now.Add(-30*time.Minute), 1, 100)

	// Parent session — closed root with no parent linkage.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state,
			started_at, last_seen_at, tokens_used,
			agent_type, client_type
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed',
			$4, $4, 0,
			'production', 'flightdeck_sensor'
		)
	`, parentSessionID, parentAgentID, parentFlavor, now.Add(-1*time.Hour)); err != nil {
		t.Fatalf("seed parent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM events WHERE session_id IN ($1::uuid, $2::uuid, $3::uuid)`,
			parentSessionID, childResearcher, childWriter)
	})

	// Two child sessions under the same parent, different roles.
	for _, c := range []struct {
		id      string
		agentID string
		role    string
		toks    int
	}{
		{childResearcher, researcherAgentID, "Researcher", 250},
		{childWriter, writerAgentID, "Writer", 100},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type,
				parent_session_id, agent_role
			) VALUES (
				$1::uuid, $2::uuid, $3, 'closed',
				$4, $4, $5,
				'production', 'flightdeck_sensor',
				$6::uuid, $7
			)
		`, c.id, c.agentID, parentFlavor+"-child", now.Add(-30*time.Minute), c.toks,
			parentSessionID, c.role); err != nil {
			t.Fatalf("seed child %s: %v", c.role, err)
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type, model,
				tokens_total, occurred_at, has_content
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, 'post_call', 'claude-sonnet-4-6',
				$3, $4, false
			)
		`, c.id, parentFlavor+"-child", c.toks, now.Add(-30*time.Minute)); err != nil {
			t.Fatalf("seed event for %s: %v", c.role, err)
		}
	}

	resp, err := s.QueryAnalytics(ctx, AnalyticsParams{
		Metric:           "tokens",
		GroupBy:          "parent_session_id",
		GroupBySecondary: "agent_role",
		Range:            "custom",
		From:             now.Add(-2 * time.Hour),
		To:               now,
		Granularity:      "day",
		// Restrict to children only so the (root) bucket from the
		// parent session itself doesn't show up in the result.
		FilterIsSubAgent: true,
	})
	if err != nil {
		t.Fatalf("QueryAnalytics: %v", err)
	}

	// Find the series for our parent.
	var got *AnalyticsSeries
	for i := range resp.Series {
		if resp.Series[i].Dimension == parentSessionID {
			got = &resp.Series[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("expected a series with dimension=%s; got %d series",
			parentSessionID, len(resp.Series))
	}

	if len(got.Data) != 1 {
		t.Fatalf("expected 1 DataPoint per parent in this window; got %d", len(got.Data))
	}
	dp := got.Data[0]
	if len(dp.Breakdown) != 2 {
		t.Fatalf("expected 2 breakdown entries (Researcher + Writer); got %d", len(dp.Breakdown))
	}

	// Sum-equals-Value invariant: DataPoint.Value must equal the
	// sum of Breakdown[].Value within the same point. The
	// dashboard relies on this to render either flat or stacked
	// representations without re-summing client-side.
	var bdSum float64
	bdMap := map[string]float64{}
	for _, b := range dp.Breakdown {
		bdSum += b.Value
		bdMap[b.Key] = b.Value
	}
	if dp.Value != bdSum {
		t.Errorf("DataPoint.Value=%v should equal sum of Breakdown=%v", dp.Value, bdSum)
	}
	if bdMap["Researcher"] != 250 {
		t.Errorf("Researcher tokens=%v, want 250", bdMap["Researcher"])
	}
	if bdMap["Writer"] != 100 {
		t.Errorf("Writer tokens=%v, want 100", bdMap["Writer"])
	}

	// Wire metadata: GroupBy in the response must echo the request
	// shape so the dashboard can re-derive the request from a
	// reloaded URL.
	if resp.GroupBy != "parent_session_id,agent_role" {
		t.Errorf("response.GroupBy=%q, want %q", resp.GroupBy, "parent_session_id,agent_role")
	}
}

// TestQueryAnalytics_TwoDimEmptyResult verifies the response shape
// when the time window contains no rows at all. Series must be
// empty (no series, no NaN totals); the request should not error.
// Charts depend on this shape to render the empty-state copy
// without a special-case for "missing series" vs "explicitly
// empty".
func TestQueryAnalytics_TwoDimEmptyResult(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	// Custom range strictly in the future → guaranteed zero rows.
	now := time.Now().UTC()
	resp, err := s.QueryAnalytics(context.Background(), AnalyticsParams{
		Metric:           "tokens",
		GroupBy:          "parent_session_id",
		GroupBySecondary: "agent_role",
		Range:            "custom",
		From:             now.Add(24 * time.Hour),
		To:               now.Add(48 * time.Hour),
		Granularity:      "day",
	})
	if err != nil {
		t.Fatalf("QueryAnalytics empty: %v", err)
	}
	if len(resp.Series) != 0 {
		t.Errorf("expected 0 series in empty window; got %d", len(resp.Series))
	}
	if resp.Totals.GrandTotal != 0 {
		t.Errorf("expected grand_total=0 in empty window; got %v", resp.Totals.GrandTotal)
	}
}

// TestQueryAnalytics_ConcurrentRequestsAreSafe runs the 2-dim path
// from many goroutines simultaneously. The store has been shared-
// pool-safe since v0.1.0 but the new query-builder branches add
// shared mutable state (filterArgs, fromClause string-building) that
// must not be touched outside per-call locals. A regression here
// would manifest as randomly mis-bucketed rows or a crash under
// load — neither shows up in single-threaded tests.
func TestQueryAnalytics_ConcurrentRequestsAreSafe(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	now := time.Now().UTC()
	params := AnalyticsParams{
		Metric:           "tokens",
		GroupBy:          "parent_session_id",
		GroupBySecondary: "agent_role",
		Range:            "custom",
		From:             now.Add(-1 * time.Hour),
		To:               now,
		Granularity:      "day",
	}

	const goroutines = 8
	const iterations = 5
	var wg sync.WaitGroup
	errCh := make(chan error, goroutines*iterations)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				if _, err := s.QueryAnalytics(context.Background(), params); err != nil {
					errCh <- err
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Errorf("concurrent QueryAnalytics: %v", err)
		}
	}
}

// TestAppendBreakdownPoint_SumInvariant covers the in-memory fold
// loop that turns SQL rows into the breakdown shape. Pure unit test
// — no DB needed. Catches off-by-one regressions in the "append to
// existing point vs start a new one" branch.
func TestAppendBreakdownPoint_SumInvariant(t *testing.T) {
	bucket1 := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	bucket2 := time.Date(2026, 5, 2, 0, 0, 0, 0, time.UTC)
	series := &AnalyticsSeries{Dimension: "p1"}
	appendBreakdownPoint(series, bucket1, "Researcher", 100)
	appendBreakdownPoint(series, bucket1, "Writer", 50)
	appendBreakdownPoint(series, bucket2, "Researcher", 25)
	if len(series.Data) != 2 {
		t.Fatalf("expected 2 DataPoints; got %d", len(series.Data))
	}
	if series.Data[0].Value != 150 {
		t.Errorf("bucket1 Value=%v, want 150 (100+50)", series.Data[0].Value)
	}
	if len(series.Data[0].Breakdown) != 2 {
		t.Errorf("bucket1 breakdown len=%d, want 2", len(series.Data[0].Breakdown))
	}
	if series.Data[1].Value != 25 {
		t.Errorf("bucket2 Value=%v, want 25", series.Data[1].Value)
	}
	if len(series.Data[1].Breakdown) != 1 {
		t.Errorf("bucket2 breakdown len=%d, want 1", len(series.Data[1].Breakdown))
	}
}

// seedSessionRow inserts one closed session with optional parent,
// role and context for the analytics tests below. tokens lands on
// sessions.tokens_used, which the sub-agent metrics read.
func seedSessionRow(
	t *testing.T, s *Store, sessionID, agentID, flavor string,
	parentID, role *string, contextJSON string, startedAt time.Time, tokens int,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (
			session_id, agent_id, flavor, state, started_at, last_seen_at,
			tokens_used, agent_type, client_type, parent_session_id,
			agent_role, context
		) VALUES (
			$1::uuid, $2::uuid, $3, 'closed', $4, $4,
			$5, 'production', 'flightdeck_sensor', $6::uuid,
			$7, $8::jsonb
		)
	`, sessionID, agentID, flavor, startedAt, tokens, parentID, role, contextJSON); err != nil {
		t.Fatalf("seed session %s: %v", sessionID, err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, sessionID)
	})
}

// TestQueryAnalytics_SubagentMetricsAcceptFrameworkDimension pins the
// sub-agent query path's FROM clause: the framework dimension projects
// the “fw“ alias of a LATERAL unnest, and without that join every
// sub-agent metric grouped by framework failed with "column fw does
// not exist".
func TestQueryAnalytics_SubagentMetricsAcceptFrameworkDimension(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	flavor := "test-subagent-framework-" + randomUUID(t)[:8]
	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-2*time.Hour), now.Add(-30*time.Minute), 2, 300)
	parentID := randomUUID(t)
	childID := randomUUID(t)
	researcher := "Researcher"
	seedSessionRow(t, s, parentID, agentID, flavor, nil, nil,
		`{"frameworks": ["langgraph/0.6.11"]}`, now.Add(-40*time.Minute), 100)
	seedSessionRow(t, s, childID, agentID, flavor, &parentID, &researcher,
		`{"frameworks": ["langgraph/0.6.11"]}`, now.Add(-39*time.Minute), 200)

	for _, metric := range []string{
		"parent_token_sum", "child_token_sum", "child_count", "parent_to_first_child_latency_ms",
	} {
		resp, err := s.QueryAnalytics(ctx, AnalyticsParams{
			Metric: metric, GroupBy: "framework", Range: "custom",
			From: now.Add(-time.Hour), To: now, Granularity: "day",
			FilterFlavor: flavor,
		})
		if err != nil {
			t.Fatalf("%s grouped by framework: %v", metric, err)
		}
		if len(resp.Series) != 1 || resp.Series[0].Dimension != "langgraph/0.6.11" {
			t.Fatalf("%s: expected one series for langgraph/0.6.11, got %+v", metric, resp.Series)
		}
	}
	// Two-dim shape with framework as the secondary axis takes the
	// same join.
	if _, err := s.QueryAnalytics(ctx, AnalyticsParams{
		Metric: "child_count", GroupBy: "flavor", GroupBySecondary: "framework",
		Range: "custom", From: now.Add(-time.Hour), To: now, Granularity: "day",
		FilterFlavor: flavor,
	}); err != nil {
		t.Fatalf("child_count flavor x framework: %v", err)
	}
}

// TestQueryAnalytics_SubagentLatencySkipsChildlessParents pins the
// latency metric's behaviour on a bucket that mixes a childless
// session with a real parent: the childless row contributes no
// NULL to the average (which previously broke the scan with "cannot
// scan NULL into *float64") and the average reflects the real
// parent only.
func TestQueryAnalytics_SubagentLatencySkipsChildlessParents(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	flavor := "test-subagent-latency-" + randomUUID(t)[:8]
	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-2*time.Hour), now.Add(-30*time.Minute), 3, 300)
	lonerID := randomUUID(t)
	parentID := randomUUID(t)
	childID := randomUUID(t)
	writer := "Writer"
	seedSessionRow(t, s, lonerID, agentID, flavor, nil, nil, `{}`, now.Add(-45*time.Minute), 100)
	seedSessionRow(t, s, parentID, agentID, flavor, nil, nil, `{}`, now.Add(-40*time.Minute), 100)
	seedSessionRow(t, s, childID, agentID, flavor, &parentID, &writer, `{}`,
		now.Add(-40*time.Minute).Add(1500*time.Millisecond), 100)

	// The loner alone: no parent spawned anything, so the metric has
	// no series at all rather than a NULL row.
	resp, err := s.QueryAnalytics(ctx, AnalyticsParams{
		Metric: "parent_to_first_child_latency_ms", GroupBy: "flavor", Range: "custom",
		From: now.Add(-50 * time.Minute), To: now.Add(-42 * time.Minute), Granularity: "day",
		FilterFlavor: flavor,
	})
	if err != nil {
		t.Fatalf("latency over childless window: %v", err)
	}
	if len(resp.Series) != 0 {
		t.Fatalf("expected no series for a childless window, got %+v", resp.Series)
	}

	// Loner + parent in one bucket: the average is the parent's 1500ms.
	resp, err = s.QueryAnalytics(ctx, AnalyticsParams{
		Metric: "parent_to_first_child_latency_ms", GroupBy: "flavor", Range: "custom",
		From: now.Add(-time.Hour), To: now, Granularity: "day",
		FilterFlavor: flavor,
	})
	if err != nil {
		t.Fatalf("latency over mixed window: %v", err)
	}
	if len(resp.Series) != 1 || len(resp.Series[0].Data) != 1 {
		t.Fatalf("expected one series with one bucket, got %+v", resp.Series)
	}
	if got := resp.Series[0].Data[0].Value; got < 1499 || got > 1501 {
		t.Fatalf("expected ~1500ms latency, got %v", got)
	}
}

// TestQueryAnalytics_PeriodChangeComparesPreviousWindow pins
// period_change_pct: the previous-period total is the same series
// query over the window before the requested one. Before the fix the
// previous-period query referenced table aliases that did not exist
// in its outer scope, failed on most metric / dimension pairs and
// silently reported a 0% change.
func TestQueryAnalytics_PeriodChangeComparesPreviousWindow(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	flavor := "test-period-change-" + randomUUID(t)[:8]
	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-3*time.Hour), now.Add(-30*time.Minute), 1, 400)
	sessionID := randomUUID(t)
	seedSessionRow(t, s, sessionID, agentID, flavor, nil, nil, `{}`, now.Add(-90*time.Minute), 400)
	// The events name a model the test prices itself, so estimated
	// cost does not depend on what the shared model_pricing table holds.
	model := flavor + "-model"
	seedPrice(t, s, model, 3, 15)
	for _, ev := range []struct {
		at     time.Time
		tokens int
	}{
		{now.Add(-90 * time.Minute), 100}, // previous window
		{now.Add(-30 * time.Minute), 300}, // current window
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (
				id, session_id, flavor, event_type, model, tokens_total,
				tokens_input, tokens_output, latency_ms, occurred_at, has_content,
				billing_mode
			) VALUES (
				gen_random_uuid(), $1::uuid, $2, 'post_call', $5,
				$3, $3, 0, 250, $4, false, 'metered'
			)
		`, sessionID, flavor, ev.tokens, ev.at, model); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}

	for _, metric := range []string{"tokens", "latency_avg", "latency_p95", "estimated_cost"} {
		for _, dim := range []string{"flavor", "model", "framework", "host", "agent_role"} {
			resp, err := s.QueryAnalytics(ctx, AnalyticsParams{
				Metric: metric, GroupBy: dim, Range: "custom",
				From: now.Add(-time.Hour), To: now, Granularity: "day",
				FilterFlavor: flavor,
			})
			if err != nil {
				t.Fatalf("%s by %s: %v", metric, dim, err)
			}
			switch metric {
			case "tokens":
				if resp.Totals.PeriodChangePct < 199.9 || resp.Totals.PeriodChangePct > 200.1 {
					t.Fatalf("tokens by %s: expected +200%% change, got %v", dim, resp.Totals.PeriodChangePct)
				}
			case "latency_avg", "latency_p95":
				// Same latency in both windows: no change.
				if resp.Totals.PeriodChangePct != 0 {
					t.Fatalf("%s by %s: expected 0%% change, got %v", metric, dim, resp.Totals.PeriodChangePct)
				}
			case "estimated_cost":
				if resp.Totals.PeriodChangePct <= 0 {
					t.Fatalf("estimated_cost by %s: expected a positive change, got %v", dim, resp.Totals.PeriodChangePct)
				}
			}
		}
	}
}

// seedPrice inserts a direct-platform model_pricing row for model and
// removes it after the test.
func seedPrice(t *testing.T, s *Store, model string, input, output float64) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO model_pricing (model_id, platform, provider, input, output, cache_read,
			cache_write_5m, cache_write_1h, source)
		VALUES ($1, 'direct', 'other', $2, $3, $2, $2, $2, 'override')`,
		model, input, output); err != nil {
		t.Fatalf("seed price for %s: %v", model, err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM model_pricing WHERE model_id = $1`, model)
	})
}
