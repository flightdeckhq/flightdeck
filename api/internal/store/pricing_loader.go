// Package store -- pricing_loader.go
//
// Builds the price list estimated cost uses (ARCHITECTURE.md, Cost
// estimation > Pricing table) from two layers:
//
//  1. The vendored litellm catalogue embedded in the binary
//     (pricing_catalogue.go).
//  2. pricing.yaml, the operator's overrides: per-model rates that
//     replace the catalogue's field by field, deployment-name aliases,
//     and the flat multipliers and server-tool fees.
//
// pricing.yaml path resolution order:
//
//  1. “FLIGHTDECK_PRICING_PATH“ env var, if set and non-empty
//  2. “/etc/flightdeck/pricing.yaml“  (production container default;
//     the api Dockerfile COPYs pricing.yaml to this path)
//  3. “./pricing.yaml“                (dev default, relative to the
//     process working directory)
//
// LoadPricing merges the layers at startup; SyncPricingTable then
// writes the result into the model_pricing table. A pricing.yaml that
// cannot be read or fails validation is logged and ignored, so the
// catalogue alone prices calls; the service never exits over prices --
// cost estimation is a display feature, not a correctness feature.
package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"gopkg.in/yaml.v3"

	"github.com/flightdeckhq/flightdeck/api/internal/modelid"
)

// pricingFile is the pricing.yaml document. Version 2 holds overrides,
// aliases, multipliers and server-tool fees; a version 1 file's
// `models` list (the format before the catalogue existed) is read as
// direct-platform overrides, so an operator's existing file keeps
// working.
type pricingFile struct {
	Version     int                           `yaml:"version"`
	Updated     string                        `yaml:"updated"`
	Overrides   []pricingOverride             `yaml:"overrides"`
	Models      []pricingOverride             `yaml:"models"`
	Aliases     []pricingAlias                `yaml:"aliases"`
	Multipliers map[string]map[string]float64 `yaml:"multipliers"`
	ServerTools map[string]float64            `yaml:"server_tools"`
}

// pricingOverride sets some or all of one model's rates (USD per
// million tokens) on one platform family. A model the catalogue does
// not list needs provider, input and output.
type pricingOverride struct {
	ModelID            string   `yaml:"model_id"`
	Platform           string   `yaml:"platform"`
	Provider           string   `yaml:"provider"`
	Input              *float64 `yaml:"input"`
	Output             *float64 `yaml:"output"`
	CacheRead          *float64 `yaml:"cache_read"`
	CacheWrite5m       *float64 `yaml:"cache_write_5m"`
	CacheWrite1h       *float64 `yaml:"cache_write_1h"`
	Reasoning          *float64 `yaml:"reasoning"`
	PriorityMultiplier *float64 `yaml:"priority_multiplier"`
	FastMultiplier     *float64 `yaml:"fast_multiplier"`
	Notes              string   `yaml:"notes,omitempty"`
}

// pricingAlias maps a deployment or route name to a priced model.
type pricingAlias struct {
	Alias    string `yaml:"alias"`
	ModelID  string `yaml:"model_id"`
	Platform string `yaml:"platform"`
}

// PricingSettings holds the flat multipliers and server-tool fees the
// cost query applies on top of the per-model rates.
type PricingSettings struct {
	// Multipliers maps a payload field (service_tier, speed,
	// inference_geo, inference_scope) to the multiplier of each value.
	// A value not listed multiplies by 1.
	Multipliers map[string]map[string]float64
	// ServerTools maps a server_tool_use counter to its USD fee per
	// request.
	ServerTools map[string]float64
}

// defaultPricingSettings are the multipliers and fees in force when
// pricing.yaml sets none: batch and flex at half price, Anthropic's
// US-only inference and regional cloud endpoints at their 10% premium,
// and web search at USD 10 per 1,000 requests.
func defaultPricingSettings() PricingSettings {
	return PricingSettings{
		Multipliers: map[string]map[string]float64{
			"service_tier":    {"batch": 0.5, "flex": 0.5},
			"inference_geo":   {"us": 1.1},
			"inference_scope": {"regional": 1.1},
		},
		ServerTools: map[string]float64{"web_search_requests": 0.01},
	}
}

// validProviders is the provider vocabulary of events.provider.
var validProviders = map[string]bool{
	"anthropic": true, "openai": true, "google": true, "xai": true,
	"mistral": true, "meta": true, "deepseek": true, "other": true,
}

var validPlatforms = map[string]bool{
	platformDirect: true, platformBedrock: true, platformVertex: true,
	platformAzure: true, platformFoundry: true,
}

// multiplierFields are the payload fields a multiplier may key on.
var multiplierFields = map[string]bool{
	"service_tier": true, "speed": true, "inference_geo": true, "inference_scope": true,
}

// Live pricing state, replaced as a whole by LoadPricing.
var (
	pricingRows     []PriceRow
	pricingSettings = defaultPricingSettings()
)

// PricingRows returns the merged price list LoadPricing built.
func PricingRows() []PriceRow { return pricingRows }

// CurrentPricingSettings returns the multipliers and fees in force.
func CurrentPricingSettings() PricingSettings { return pricingSettings }

// resolvePricingPath returns the first candidate path that exists on
// disk, or "" if none match. The env-var override skips the existence
// check (a set-but-missing path should surface as a load error, not
// silently fall through to the next candidate).
func resolvePricingPath() string {
	if p := os.Getenv("FLIGHTDECK_PRICING_PATH"); p != "" {
		return p
	}
	for _, candidate := range []string{
		"/etc/flightdeck/pricing.yaml",
		"pricing.yaml",
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// LoadPricing builds the price list from the embedded catalogue and
// pricing.yaml and makes it live. Call once at service startup, before
// SyncPricingTable and any analytics query.
func LoadPricing() {
	rows, err := catalogueRows()
	if err != nil {
		// The catalogue is embedded at build time and covered by
		// tests; failing to parse it means a broken build.
		slog.Error("pricing catalogue is unreadable; estimated cost will be zero", "err", err)
		rows = nil
	}
	settings := defaultPricingSettings()

	path := resolvePricingPath()
	if path == "" {
		slog.Info("no pricing.yaml found; pricing from the catalogue only",
			"candidates", "$FLIGHTDECK_PRICING_PATH, /etc/flightdeck/pricing.yaml, ./pricing.yaml")
	} else if file, err := readPricingFile(path); err != nil {
		slog.Warn("pricing.yaml ignored; pricing from the catalogue only", "path", path, "err", err)
	} else if merged, mergedSettings, err := applyPricingFile(rows, file); err != nil {
		slog.Warn("pricing.yaml ignored; pricing from the catalogue only", "path", path, "err", err)
	} else {
		rows, settings = merged, mergedSettings
	}

	pricingRows = rows
	pricingSettings = settings
	modelPricing = legacyPricingMap(rows)
	slog.Info("pricing loaded", "rows", len(rows), "overrides_path", path)
}

// readPricingFile reads and parses pricing.yaml. An unknown key (a
// misspelt rate) is an error rather than silently ignored, and the file
// must declare version 1 or 2.
func readPricingFile(path string) (pricingFile, error) {
	var file pricingFile
	data, err := os.ReadFile(path)
	if err != nil {
		return file, fmt.Errorf("read %s: %w", path, err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&file); err != nil && !errors.Is(err, io.EOF) {
		return file, fmt.Errorf("parse %s: %w", path, err)
	}
	if file.Version != 1 && file.Version != 2 {
		return file, fmt.Errorf("%s: version must be 1 or 2 (got %d)", path, file.Version)
	}
	return file, nil
}

// validRate reports whether v is a usable rate or multiplier input: a
// finite number at or above zero.
func validRate(v float64) bool {
	return v >= 0 && !math.IsNaN(v) && !math.IsInf(v, 0)
}

// applyPricingFile lays pricing.yaml over the catalogue rows: overrides
// replace a row's rates field by field (or add a row the catalogue does
// not have), aliases become rows carrying their target's rates, and the
// multipliers and fees replace the defaults they name. Any invalid entry
// fails the whole file, naming the entry.
func applyPricingFile(catalogue []PriceRow, file pricingFile) ([]PriceRow, PricingSettings, error) {
	settings := defaultPricingSettings()
	byKey := make(map[rowKey]PriceRow, len(catalogue))
	for _, r := range catalogue {
		byKey[rowKey{r.ModelID, r.Platform}] = r
	}

	overrides := append(append([]pricingOverride{}, file.Models...), file.Overrides...)
	seen := map[rowKey]bool{}
	for i, o := range overrides {
		key, err := overrideKey(o, i)
		if err != nil {
			return nil, settings, err
		}
		if seen[key] {
			return nil, settings, fmt.Errorf("override %d: duplicate model_id %q on platform %q", i, o.ModelID, key.platform)
		}
		seen[key] = true
		row, exists := byKey[key]
		if !exists {
			if o.Input == nil || o.Output == nil {
				return nil, settings, fmt.Errorf("override %d (%s): a model the catalogue does not list needs input and output", i, o.ModelID)
			}
			row = PriceRow{ModelID: key.model, Platform: key.platform, Provider: modelid.Provider(key.model)}
			row.CacheRead, row.CacheWrite5m, row.CacheWrite1h = *o.Input, *o.Input, *o.Input
		}
		if err := applyOverride(&row, o, i); err != nil {
			return nil, settings, err
		}
		row.Source = sourceOverride
		byKey[key] = row
	}

	// An alias must not reuse any priced model id, catalogue or
	// override, on any platform: one id would then mean two models.
	pricedIDs := make(map[string]bool, len(byKey))
	for k := range byKey {
		pricedIDs[k.model] = true
	}
	for i, a := range file.Aliases {
		alias := modelid.Canonicalize(a.Alias).Model
		target := modelid.Canonicalize(a.ModelID).Model
		platform := a.Platform
		if platform == "" {
			platform = platformDirect
		}
		switch {
		case alias == "" || target == "":
			return nil, settings, fmt.Errorf("alias %d: alias and model_id are required", i)
		case !validPlatforms[platform]:
			return nil, settings, fmt.Errorf("alias %d (%s): unknown platform %q", i, a.Alias, platform)
		case pricedIDs[alias]:
			return nil, settings, fmt.Errorf("alias %d: %q is a priced model id; an alias must not shadow one", i, a.Alias)
		}
		row, ok := byKey[rowKey{target, platform}]
		if !ok {
			row, ok = byKey[rowKey{target, platformDirect}]
		}
		if !ok {
			return nil, settings, fmt.Errorf("alias %d (%s): target model %q has no price", i, a.Alias, a.ModelID)
		}
		row.ModelID, row.Platform, row.Source = alias, platform, sourceAlias
		if _, dup := byKey[rowKey{alias, platform}]; dup {
			return nil, settings, fmt.Errorf("alias %d: %q is defined twice on platform %q", i, a.Alias, platform)
		}
		byKey[rowKey{alias, platform}] = row
	}

	for field, values := range file.Multipliers {
		if !multiplierFields[field] {
			return nil, settings, fmt.Errorf("multipliers: unknown field %q", field)
		}
		if settings.Multipliers[field] == nil {
			settings.Multipliers[field] = map[string]float64{}
		}
		// Merged value by value: a file that sets batch keeps the
		// default flex; setting a value to 1 removes its effect.
		for value, m := range values {
			if !validRate(m) || m == 0 {
				return nil, settings, fmt.Errorf("multipliers.%s.%s must be > 0 (got %v)", field, value, m)
			}
			settings.Multipliers[field][value] = m
		}
	}
	for tool, fee := range file.ServerTools {
		if !validRate(fee) {
			return nil, settings, fmt.Errorf("server_tools.%s must be >= 0 (got %v)", tool, fee)
		}
		settings.ServerTools[tool] = fee
	}

	rows := make([]PriceRow, 0, len(byKey))
	for _, r := range byKey {
		rows = append(rows, r)
	}
	sortRows(rows)
	return rows, settings, nil
}

// overrideKey validates an override's identity and returns its row key.
func overrideKey(o pricingOverride, i int) (rowKey, error) {
	model := modelid.Canonicalize(o.ModelID).Model
	if model == "" {
		return rowKey{}, fmt.Errorf("override %d: model_id is required", i)
	}
	platform := o.Platform
	if platform == "" {
		platform = platformDirect
	}
	if !validPlatforms[platform] {
		return rowKey{}, fmt.Errorf("override %d (%s): unknown platform %q", i, o.ModelID, platform)
	}
	if o.Provider != "" && !validProviders[o.Provider] {
		return rowKey{}, fmt.Errorf("override %d (%s): unknown provider %q", i, o.ModelID, o.Provider)
	}
	return rowKey{model, platform}, nil
}

// applyOverride copies the rates an override sets onto a row.
func applyOverride(row *PriceRow, o pricingOverride, i int) error {
	set := func(name string, src *float64, dst *float64) error {
		if src == nil {
			return nil
		}
		if !validRate(*src) {
			return fmt.Errorf("override %d (%s): %s must be >= 0 (got %v)", i, o.ModelID, name, *src)
		}
		*dst = *src
		return nil
	}
	// The long-context tier's rates belong to the catalogue's base
	// rates; an override of any base rate (a negotiated price) drops
	// the tier, so calls above the threshold are priced at the
	// override's rates rather than a mix of the two.
	if o.Input != nil || o.Output != nil || o.CacheRead != nil || o.CacheWrite5m != nil || o.CacheWrite1h != nil {
		row.TierThreshold, row.TierInput, row.TierOutput = nil, nil, nil
		row.TierCacheRead, row.TierCacheWrite5m, row.TierCacheWrite1h = nil, nil, nil
	}
	for _, f := range []struct {
		name string
		src  *float64
		dst  *float64
	}{
		{"input", o.Input, &row.Input},
		{"output", o.Output, &row.Output},
		{"cache_read", o.CacheRead, &row.CacheRead},
		{"cache_write_5m", o.CacheWrite5m, &row.CacheWrite5m},
		{"cache_write_1h", o.CacheWrite1h, &row.CacheWrite1h},
	} {
		if err := set(f.name, f.src, f.dst); err != nil {
			return err
		}
	}
	for _, f := range []struct {
		name string
		src  *float64
		dst  **float64
	}{
		{"reasoning", o.Reasoning, &row.Reasoning},
		{"priority_multiplier", o.PriorityMultiplier, &row.PriorityMultiplier},
		{"fast_multiplier", o.FastMultiplier, &row.FastMultiplier},
	} {
		if f.src == nil {
			continue
		}
		if !validRate(*f.src) {
			return fmt.Errorf("override %d (%s): %s must be >= 0 (got %v)", i, o.ModelID, f.name, *f.src)
		}
		*f.dst = ptr(*f.src)
	}
	if o.Provider != "" {
		row.Provider = o.Provider
	}
	return nil
}

// legacyPricingMap is the input / output rate of every direct-platform
// row, the shape the per-model CASE cost expression in pricing.go reads.
func legacyPricingMap(rows []PriceRow) map[string]ModelPricing {
	out := make(map[string]ModelPricing, len(rows))
	for _, r := range rows {
		if r.Platform == platformDirect {
			out[r.ModelID] = ModelPricing{InputPerMTok: r.Input, OutputPerMTok: r.Output}
		}
	}
	return out
}

// pricingSchemaTag names the model_pricing column set the rows are
// written in. It is part of the content hash, so a release that adds a
// column rewrites the table even when no price changed; bump it with
// every migration that changes model_pricing.
const pricingSchemaTag = "model_pricing/000031"

// pricingContentHash is a digest of the rows and the table schema,
// stored beside the table so a start whose prices are unchanged skips
// the rewrite.
func pricingContentHash(rows []PriceRow) string {
	encoded, _ := json.Marshal(rows)
	sum := sha256.Sum256(append([]byte(pricingSchemaTag+"\n"), encoded...))
	return hex.EncodeToString(sum[:])
}

// pricingSyncLockKey is the transaction-scoped advisory lock the table
// rebuild takes, so API replicas starting together write it one at a
// time and every one after the first finds the hash already current.
const pricingSyncLockKey = 0x70726963 // "pric"

// pricingSyncTimeout bounds the startup rebuild; the table holds a few
// thousand rows, so this is generous, and a start that exceeds it logs
// and carries on with the table as it was.
const pricingSyncTimeout = 30 * time.Second

// SyncPricingTable writes the live price list into model_pricing in one
// transaction, skipping the write when model_pricing_meta already holds
// the same content hash. Errors are returned for the caller to log; the
// table keeps its previous content.
func SyncPricingTable(ctx context.Context, pool *pgxpool.Pool) error {
	ctx, cancel := context.WithTimeout(ctx, pricingSyncTimeout)
	defer cancel()
	rows := pricingRows
	hash := pricingContentHash(rows)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin pricing sync: %w", err)
	}
	// A no-op once Commit has succeeded.
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, pricingSyncLockKey); err != nil {
		return fmt.Errorf("lock pricing sync: %w", err)
	}
	var current string
	err = tx.QueryRow(ctx, `SELECT content_hash FROM model_pricing_meta`).Scan(&current)
	if err == nil && current == hash {
		return nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("read pricing hash: %w", err)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM model_pricing`); err != nil {
		return fmt.Errorf("clear model_pricing: %w", err)
	}
	columns := []string{
		"model_id", "platform", "provider", "input", "output", "cache_read",
		"cache_write_5m", "cache_write_1h", "reasoning", "tier_threshold_tokens",
		"tier_input", "tier_output", "tier_cache_read", "tier_cache_write_5m",
		"tier_cache_write_1h", "priority_multiplier", "fast_multiplier", "source",
		"deprecated_on",
	}
	values := make([][]any, 0, len(rows))
	for _, r := range rows {
		var deprecated any
		if r.DeprecatedOn != nil {
			if d, err := time.Parse(time.DateOnly, *r.DeprecatedOn); err == nil {
				deprecated = d
			}
		}
		values = append(values, []any{
			r.ModelID, r.Platform, r.Provider, r.Input, r.Output, r.CacheRead,
			r.CacheWrite5m, r.CacheWrite1h, r.Reasoning, r.TierThreshold,
			r.TierInput, r.TierOutput, r.TierCacheRead, r.TierCacheWrite5m,
			r.TierCacheWrite1h, r.PriorityMultiplier, r.FastMultiplier, r.Source,
			deprecated,
		})
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"model_pricing"}, columns, pgx.CopyFromRows(values)); err != nil {
		return fmt.Errorf("write model_pricing: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_pricing_meta (id, content_hash, loaded_at) VALUES (TRUE, $1, NOW())
		ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash, loaded_at = EXCLUDED.loaded_at
	`, hash); err != nil {
		return fmt.Errorf("write pricing hash: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit pricing sync: %w", err)
	}
	slog.Info("model_pricing rebuilt", "rows", len(rows))
	return nil
}
