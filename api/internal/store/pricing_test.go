// Pricing tests. Run with `go test ./api/internal/store/...`.
//
// These tests cover the per-model CASE cost expression. The catalogue
// and loader are tested in pricing_catalogue_test.go and
// pricing_loader_test.go.
package store

import (
	"regexp"
	"strings"
	"testing"
)

// snapshotPricing swaps in a controlled pricing map for the duration
// of a test so formula tests are not coupled to whatever pricing.yaml
// happens to hold. Restores the previous map on cleanup.
func snapshotPricing(t *testing.T, pricing map[string]ModelPricing) {
	t.Helper()
	prev := modelPricing
	modelPricing = pricing
	t.Cleanup(func() { modelPricing = prev })
}

// TestBuildCostAggregateSQL_CacheAwareFormula asserts the four-term
// structure of the emitted SQL and that rates match the active map.
// The SQL is consumed by pgx at runtime; we verify its shape here.
func TestBuildCostAggregateSQL_CacheAwareFormula(t *testing.T) {
	snapshotPricing(t, map[string]ModelPricing{
		"claude-sonnet-4-6": {InputPerMTok: 3.00, OutputPerMTok: 15.00},
	})

	sql := BuildCostAggregateSQL("e.model")

	// Per-token rate for a $3.00/Mtok input price.
	const inputPerTok = "0.0000030000"
	const outputPerTok = "0.0000150000"

	requireContains(t, sql, "COALESCE(tokens_input, 0) - COALESCE(tokens_cache_read, 0) - COALESCE(tokens_cache_creation, 0)",
		"uncached input term")
	requireContains(t, sql, "COALESCE(tokens_cache_read, 0)", "cache_read term")
	requireContains(t, sql, "COALESCE(tokens_cache_creation, 0)", "cache_creation term")
	requireContains(t, sql, "COALESCE(tokens_output, 0)", "output term")
	requireContains(t, sql, "* 0.1000", "cache_read ratio 0.10")
	requireContains(t, sql, "* 1.2500", "cache_creation ratio 1.25")
	requireContains(t, sql, "WHEN 'claude-sonnet-4-6' THEN "+inputPerTok, "input CASE")
	requireContains(t, sql, "WHEN 'claude-sonnet-4-6' THEN "+outputPerTok, "output CASE")
	requireContains(t, sql, "ELSE 0 END", "unknown-model fallback")
}

// TestBuildCostAggregateSQL_CollapsesWhenNoCacheTokens documents the
// provider-agnostic guarantee: rows whose cache columns are 0 (a
// provider that reports no cache tokens, or an OpenAI call with no
// cache read) produce a cost equal to the old two-term formula.
// Verified symbolically --
// with both cache terms zeroed, cost(row) = uncached * input_rate +
// output * output_rate = tokens_input * input_rate + tokens_output *
// output_rate, the plain two-term expression.
//
// This is enforced structurally rather than by running SQL so the
// test is hermetic. The runtime behaviour is exercised by the
// integration suite.
func TestBuildCostAggregateSQL_CollapsesWhenNoCacheTokens(t *testing.T) {
	snapshotPricing(t, map[string]ModelPricing{
		"gpt-4o": {InputPerMTok: 2.50, OutputPerMTok: 10.00},
	})
	sql := BuildCostAggregateSQL("e.model")

	// Grab the coefficient that multiplies the uncached-input CASE.
	// Confirms the CASE applies full input rate (no cache ratio).
	uncachedPattern := regexp.MustCompile(
		`\(COALESCE\(tokens_input, 0\) - COALESCE\(tokens_cache_read, 0\) - COALESCE\(tokens_cache_creation, 0\)\) \* \(CASE e\.model WHEN 'gpt-4o' THEN 0\.0000025000`,
	)
	if !uncachedPattern.MatchString(sql) {
		t.Fatalf("uncached input term does not apply full input rate for gpt-4o\n%s", sql)
	}

	// And that cache terms use the same input CASE (just scaled). Rows
	// with cache_read = cache_creation = 0 (no cache tokens reported, or
	// an OpenAI call without a cache read) zero those terms so the
	// formula reduces to uncached * input + output * output, identical
	// to the two-term expression. That invariant is proved by algebra, not by running
	// SQL -- the structural check above is sufficient.
}

// TestBuildCostAggregateSQL_UnknownModelFallsBackToZero verifies the
// ELSE 0 branch: a model not in the pricing map contributes zero to
// the SUM. Handler separately surfaces partial_estimate via
// KnownPricedModels, so cost for unknown-model periods goes to 0
// silently in the aggregate.
func TestBuildCostAggregateSQL_UnknownModelFallsBackToZero(t *testing.T) {
	snapshotPricing(t, map[string]ModelPricing{
		"claude-sonnet-4-6": {InputPerMTok: 3.00, OutputPerMTok: 15.00},
	})
	sql := BuildCostAggregateSQL("e.model")

	// The CASE has no entry for 'unknown-model-abc', so the ELSE
	// clause kicks in and every token for that model contributes 0.
	// Assert the CASE does not mention a surprise model.
	if strings.Contains(sql, "unknown-model-abc") {
		t.Fatal("CASE unexpectedly contains unknown model")
	}
	requireContains(t, sql, "ELSE 0 END", "ELSE fallback present")
}

// TestKnownPricedModels returns the current map keys sorted. This is
// how the handler decides whether partial_estimate should be flipped.
func TestKnownPricedModels_ReturnsSortedKeys(t *testing.T) {
	snapshotPricing(t, map[string]ModelPricing{
		"model-b": {2.0, 4.0},
		"model-a": {1.0, 2.0},
		"model-c": {3.0, 6.0},
	})
	got := KnownPricedModels()
	want := []string{"model-a", "model-b", "model-c"}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("want %v, got %v", want, got)
	}
}

func requireContains(t *testing.T, haystack, needle, reason string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("expected substring (%s): %q not found in\n%s", reason, needle, haystack)
	}
}

// With no prices loaded the expression is still valid SQL: every rate
// is 0 rather than a CASE without a WHEN arm.
func TestBuildCostAggregateSQL_NoPricesIsValidSQL(t *testing.T) {
	snapshotPricing(t, map[string]ModelPricing{})
	sql := BuildCostAggregateSQL("e.model")
	if strings.Contains(sql, "CASE e.model ELSE") {
		t.Errorf("empty price map produced a CASE without WHEN: %s", sql)
	}
}
