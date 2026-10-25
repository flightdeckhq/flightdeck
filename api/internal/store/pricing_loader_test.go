package store

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func writeTempYaml(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func sampleRows(t *testing.T) []PriceRow {
	t.Helper()
	rows, err := parseCatalogue([]byte(sampleCatalogue))
	if err != nil {
		t.Fatalf("parseCatalogue: %v", err)
	}
	return rows
}

func applyYaml(t *testing.T, body string) ([]PriceRow, PricingSettings, error) {
	t.Helper()
	file, err := readPricingFile(writeTempYaml(t, "pricing.yaml", body))
	if err != nil {
		t.Fatalf("readPricingFile: %v", err)
	}
	return applyPricingFile(sampleRows(t), file)
}

func TestApplyPricingFile_OverrideReplacesFieldByField(t *testing.T) {
	rows, _, err := applyYaml(t, `
version: 2
overrides:
  - model_id: claude-sonnet-4-5
    input: 2.40
`)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	r := rowsByKey(t, rows)[rowKey{"claude-sonnet-4-5", platformDirect}]
	if !approx(r.Input, 2.4) || !approx(r.Output, 15) || !approx(r.CacheWrite1h, 6) {
		t.Errorf("only input should change: %+v", r)
	}
	if r.Source != sourceOverride {
		t.Errorf("source = %q, want override", r.Source)
	}
}

func TestApplyPricingFile_AddsAModelTheCatalogueLacks(t *testing.T) {
	rows, _, err := applyYaml(t, `
version: 2
overrides:
  - model_id: claude-3-opus-20240229
    provider: anthropic
    input: 15
    output: 75
`)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	r, ok := rowsByKey(t, rows)[rowKey{"claude-3-opus-20240229", platformDirect}]
	if !ok || !approx(r.Input, 15) || !approx(r.CacheRead, 15) || r.Provider != "anthropic" {
		t.Errorf("new row wrong: %+v", r)
	}
}

func TestApplyPricingFile_ReadsAVersion1ModelsList(t *testing.T) {
	rows, _, err := applyYaml(t, `
version: 1
models:
  - model_id: claude-sonnet-4-5
    provider: anthropic
    input: 2.00
    output: 10.00
`)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	r := rowsByKey(t, rows)[rowKey{"claude-sonnet-4-5", platformDirect}]
	if !approx(r.Input, 2) || !approx(r.Output, 10) {
		t.Errorf("version 1 entry not applied: %+v", r)
	}
}

func TestApplyPricingFile_AliasCopiesItsTarget(t *testing.T) {
	rows, _, err := applyYaml(t, `
version: 2
aliases:
  - alias: Prod-GPT4o
    model_id: gpt-4o
    platform: azure
`)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	r, ok := rowsByKey(t, rows)[rowKey{"prod-gpt4o", platformAzure}]
	if !ok || !approx(r.Input, 2.5) || r.Source != sourceAlias {
		t.Errorf("alias row wrong: %+v", r)
	}
}

func TestApplyPricingFile_RejectsInvalidEntries(t *testing.T) {
	cases := map[string]string{
		"new model without rates": `
overrides:
  - model_id: brand-new
    provider: other
    input: 1`,
		"negative rate": `
overrides:
  - model_id: claude-sonnet-4-5
    output: -1`,
		"unknown platform": `
overrides:
  - model_id: claude-sonnet-4-5
    platform: moon
    input: 1`,
		"unknown provider": `
overrides:
  - model_id: claude-sonnet-4-5
    provider: litellm
    input: 1`,
		"duplicate override": `
overrides:
  - model_id: claude-sonnet-4-5
    input: 1
  - model_id: claude-sonnet-4-5
    input: 2`,
		"alias shadowing a catalogue id": `
aliases:
  - alias: gpt-5.1
    model_id: gpt-4o`,
		"alias to an unpriced model": `
aliases:
  - alias: my-route
    model_id: not-a-model`,
		"unknown multiplier field": `
multipliers:
  weather:
    sunny: 2`,
		"non-positive multiplier": `
multipliers:
  service_tier:
    batch: 0`,
		"negative server-tool fee": `
server_tools:
  web_search_requests: -0.01`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := applyYaml(t, "version: 2\n"+strings.TrimPrefix(body, "\n")); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

func TestApplyPricingFile_MultipliersAndFees(t *testing.T) {
	_, settings, err := applyYaml(t, `
version: 2
multipliers:
  service_tier:
    batch: 0.4
server_tools:
  web_fetch_requests: 0.002
`)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := settings.Multipliers["service_tier"]; got["batch"] != 0.4 || len(got) != 1 {
		t.Errorf("service_tier multipliers = %v, want only batch 0.4", got)
	}
	if settings.Multipliers["inference_geo"]["us"] != 1.1 {
		t.Error("a field the file does not list keeps its default")
	}
	if settings.ServerTools["web_fetch_requests"] != 0.002 || settings.ServerTools["web_search_requests"] != 0.01 {
		t.Errorf("server tools = %v", settings.ServerTools)
	}
}

func TestRepoPricingYamlIsValid(t *testing.T) {
	file, err := readPricingFile("../../../pricing.yaml")
	if err != nil {
		t.Fatalf("read repo pricing.yaml: %v", err)
	}
	rows, err := catalogueRows()
	if err != nil {
		t.Fatalf("catalogue: %v", err)
	}
	if _, _, err := applyPricingFile(rows, file); err != nil {
		t.Fatalf("repo pricing.yaml does not apply: %v", err)
	}
}

func TestLoadPricing_IgnoresAnInvalidFile(t *testing.T) {
	t.Setenv("FLIGHTDECK_PRICING_PATH", writeTempYaml(t, "bad.yaml", "overrides:\n  - model_id: x\n    input: -1\n"))
	prevRows, prevMap := pricingRows, modelPricing
	t.Cleanup(func() { pricingRows, modelPricing = prevRows, prevMap })

	LoadPricing()

	if len(pricingRows) < 500 {
		t.Fatalf("the catalogue alone should price calls; got %d rows", len(pricingRows))
	}
	if _, ok := modelPricing["claude-haiku-4-5"]; !ok {
		t.Error("the legacy cost map should hold the catalogue's direct rows")
	}
}

func TestLoadPricing_AppliesTheEnvFile(t *testing.T) {
	t.Setenv("FLIGHTDECK_PRICING_PATH", writeTempYaml(t, "ok.yaml", `
version: 2
overrides:
  - model_id: override-sentinel
    provider: other
    input: 7.77
    output: 11.11
`))
	prevRows, prevMap := pricingRows, modelPricing
	t.Cleanup(func() { pricingRows, modelPricing = prevRows, prevMap })

	LoadPricing()

	if p := modelPricing["override-sentinel"]; p.InputPerMTok != 7.77 || p.OutputPerMTok != 11.11 {
		t.Errorf("override not applied: %+v", p)
	}
}

func TestPricingContentHash_IsStable(t *testing.T) {
	a, b := sampleRows(t), sampleRows(t)
	if pricingContentHash(a) != pricingContentHash(b) {
		t.Error("the same rows must hash the same")
	}
	b[0].Input++
	if pricingContentHash(a) == pricingContentHash(b) {
		t.Error("a changed rate must change the hash")
	}
}

// ---- Postgres ------------------------------------------------------------

// pricingTestPool connects to the dev database when FLIGHTDECK_POSTGRES_URL
// or TEST_POSTGRES_URL is set; the test is skipped otherwise.
func pricingTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		dsn = os.Getenv("FLIGHTDECK_POSTGRES_URL")
	}
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL or FLIGHTDECK_POSTGRES_URL set; skipping DB test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestSyncPricingTable_WritesOnceThenSkips(t *testing.T) {
	pool := pricingTestPool(t)
	ctx := context.Background()
	prevRows, prevMap := pricingRows, modelPricing
	t.Cleanup(func() {
		// Leave the dev table holding the real price list again: the
		// catalogue plus the repo's pricing.yaml, as the API loads it.
		t.Setenv("FLIGHTDECK_PRICING_PATH", "../../../pricing.yaml")
		LoadPricing()
		if err := SyncPricingTable(ctx, pool); err != nil {
			t.Errorf("restore model_pricing: %v", err)
		}
		pricingRows, modelPricing = prevRows, prevMap
	})

	pricingRows = sampleRows(t)
	if err := SyncPricingTable(ctx, pool); err != nil {
		t.Fatalf("sync: %v", err)
	}
	var count int
	var input, tierInput, fast float64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM model_pricing`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != len(pricingRows) {
		t.Errorf("model_pricing has %d rows, want %d", count, len(pricingRows))
	}
	if err := pool.QueryRow(ctx, `
		SELECT input::float8, tier_input::float8, fast_multiplier::float8 FROM model_pricing
		WHERE model_id = 'claude-sonnet-4-5' AND platform = 'direct'`).Scan(&input, &tierInput, &fast); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if !approx(input, 3) || !approx(tierInput, 6) || fast != 2 {
		t.Errorf("row values wrong: input %v tier %v fast %v", input, tierInput, fast)
	}

	var loadedAt1, loadedAt2 string
	if err := pool.QueryRow(ctx, `SELECT loaded_at::text FROM model_pricing_meta`).Scan(&loadedAt1); err != nil {
		t.Fatalf("meta: %v", err)
	}
	if err := SyncPricingTable(ctx, pool); err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT loaded_at::text FROM model_pricing_meta`).Scan(&loadedAt2); err != nil {
		t.Fatalf("meta: %v", err)
	}
	if loadedAt1 != loadedAt2 {
		t.Error("an unchanged price list must not rewrite the table")
	}
}
