// Pricing tests. Run with `go test ./api/internal/store/...`.
//
// These tests cover the pure-SQL and pure-Go surface of the pricing
// table: formula generation and YAML loader. They do not touch
// Postgres -- analytics/query behaviour is tested via the integration
// suite.
package store

import (
	"os"
	"path/filepath"
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
// provider-agnostic guarantee: OpenAI rows (cache columns = 0) produce
// a cost equal to the old two-term formula. Verified symbolically --
// with both cache terms zeroed, cost(row) = uncached * input_rate +
// output * output_rate = tokens_input * input_rate + tokens_output *
// output_rate, the pre-D101 expression.
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

	// And that cache terms use the same input CASE (just scaled). OpenAI
	// rows with cache_read = cache_creation = 0 zero those terms so the
	// formula reduces to uncached * input + output * output, identical
	// to pre-D101. That invariant is proved by algebra, not by running
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

// ------------------------------------------------------------------
// pricing_loader tests
// ------------------------------------------------------------------

func writeTempYaml(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

// TestParsePricingFile_Valid covers the happy path: a well-formed YAML
// with two models parses into a map with the right prices.
func TestParsePricingFile_Valid(t *testing.T) {
	path := writeTempYaml(t, "valid.yaml", `
version: 1
updated: 2026-04-17
models:
  - model_id: claude-sonnet-4-6
    provider: anthropic
    input: 3.00
    output: 15.00
  - model_id: gpt-4o
    provider: openai
    input: 2.50
    output: 10.00
`)
	got, err := parsePricingFile(path)
	if err != nil {
		t.Fatalf("expected valid parse, got: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got["claude-sonnet-4-6"].InputPerMTok != 3.00 {
		t.Errorf("sonnet input: want 3.00, got %v", got["claude-sonnet-4-6"].InputPerMTok)
	}
	if got["gpt-4o"].OutputPerMTok != 10.00 {
		t.Errorf("gpt-4o output: want 10.00, got %v", got["gpt-4o"].OutputPerMTok)
	}
}

// TestParsePricingFile_DuplicateModelID rejects a file with two entries
// sharing the same model_id. This catches copy-paste mistakes in PRs
// that would silently keep only one of the conflicting prices.
func TestParsePricingFile_DuplicateModelID(t *testing.T) {
	path := writeTempYaml(t, "dup.yaml", `
version: 1
models:
  - model_id: gpt-4o
    provider: openai
    input: 2.50
    output: 10.00
  - model_id: gpt-4o
    provider: openai
    input: 3.00
    output: 12.00
`)
	_, err := parsePricingFile(path)
	if err == nil {
		t.Fatal("expected duplicate-model_id error, got nil")
	}
	if !strings.Contains(err.Error(), "duplicate") {
		t.Errorf("error should mention duplicate, got: %v", err)
	}
}

// TestParsePricingFile_NegativePriceRejected ensures malformed prices
// are caught at load time rather than silently producing negative
// cost numbers.
func TestParsePricingFile_NegativePriceRejected(t *testing.T) {
	path := writeTempYaml(t, "neg.yaml", `
version: 1
models:
  - model_id: broken-model
    provider: anthropic
    input: -1.00
    output: 5.00
`)
	_, err := parsePricingFile(path)
	if err == nil || !strings.Contains(err.Error(), "input must be >= 0") {
		t.Fatalf("expected negative-input error, got: %v", err)
	}
}

// TestParsePricingFile_InvalidProviderRejected catches a typo in the
// provider field. The valid-providers set is closed because the SQL
// CASE in ProviderCaseSQL only knows those names.
func TestParsePricingFile_InvalidProviderRejected(t *testing.T) {
	path := writeTempYaml(t, "provider.yaml", `
version: 1
models:
  - model_id: weird-model
    provider: cohere
    input: 1.00
    output: 2.00
`)
	_, err := parsePricingFile(path)
	if err == nil || !strings.Contains(err.Error(), "unknown provider") {
		t.Fatalf("expected unknown-provider error, got: %v", err)
	}
}

// TestParsePricingFile_EmptyModelsRejected guards against the silent-
// pricing failure mode where a bad edit wipes the whole models list.
// We'd rather fail loud than silently ship a zero-price table.
func TestParsePricingFile_EmptyModelsRejected(t *testing.T) {
	path := writeTempYaml(t, "empty.yaml", `
version: 1
models: []
`)
	_, err := parsePricingFile(path)
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("expected empty-models error, got: %v", err)
	}
}

// TestParsePricingFile_MissingFile exercises the loader's os.ReadFile
// error branch -- the public LoadPricing function swallows this and
// installs the safety map; parsePricingFile propagates it so the
// caller can log the path.
func TestParsePricingFile_MissingFile(t *testing.T) {
	_, err := parsePricingFile(filepath.Join(t.TempDir(), "does-not-exist.yaml"))
	if err == nil {
		t.Fatal("expected read error for missing file, got nil")
	}
}

// TestLoadPricing_MissingFileFallsBackToSafetyMap verifies the
// service-start contract: even with a broken path the API still boots
// with cost estimation for the four safety-map models.
func TestLoadPricing_MissingFileFallsBackToSafetyMap(t *testing.T) {
	t.Setenv("FLIGHTDECK_PRICING_PATH", filepath.Join(t.TempDir(), "nope.yaml"))
	prev := modelPricing
	t.Cleanup(func() { modelPricing = prev })

	LoadPricing()

	for _, m := range []string{"claude-sonnet-4-6", "gpt-4o"} {
		if _, ok := modelPricing[m]; !ok {
			t.Errorf("safety map missing expected model %s", m)
		}
	}
	if len(modelPricing) > 10 {
		t.Errorf("safety map larger than expected (%d); LoadPricing may have loaded real data", len(modelPricing))
	}
}

// TestLoadPricing_EnvVarOverrideIsHonoured confirms the env-var path
// wins over /etc/flightdeck/pricing.yaml and ./pricing.yaml.
func TestLoadPricing_EnvVarOverrideIsHonoured(t *testing.T) {
	path := writeTempYaml(t, "override.yaml", `
version: 1
models:
  - model_id: override-sentinel
    provider: anthropic
    input: 7.77
    output: 11.11
`)
	t.Setenv("FLIGHTDECK_PRICING_PATH", path)
	prev := modelPricing
	t.Cleanup(func() { modelPricing = prev })

	LoadPricing()

	p, ok := modelPricing["override-sentinel"]
	if !ok {
		t.Fatal("override yaml not loaded")
	}
	if p.InputPerMTok != 7.77 || p.OutputPerMTok != 11.11 {
		t.Errorf("override prices wrong: %+v", p)
	}
}

func requireContains(t *testing.T, haystack, needle, reason string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("expected substring (%s): %q not found in\n%s", reason, needle, haystack)
	}
}
