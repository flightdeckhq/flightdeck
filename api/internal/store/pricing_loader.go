// Package store -- pricing_loader.go
//
// Loads the model pricing table from ``pricing.yaml`` at service
// startup. Replaces the previous hard-coded Go map so a pricing
// refresh is a YAML edit and a PR rather than a Go edit and a
// release (D102).
//
// Path resolution order:
//
//  1. ``FLIGHTDECK_PRICING_PATH`` env var, if set and non-empty
//  2. ``/etc/flightdeck/pricing.yaml``  (production container default;
//     the api Dockerfile COPYs pricing.yaml to this path)
//  3. ``./pricing.yaml``                (dev default, relative to the
//     process working directory)
//
// On any load failure (file missing, YAML parse error, validation
// error) the loader logs the error at WARN and populates a minimal
// safety map covering the handful of models that are common enough
// that a bare dev stack still produces sensible cost numbers. The
// service never exits on a bad pricing file -- cost estimation is a
// display feature, not a correctness feature.
package store

import (
	"fmt"
	"log/slog"
	"os"

	"gopkg.in/yaml.v3"
)

// pricingFile mirrors the YAML top-level shape. Loaded by LoadPricing
// and immediately discarded in favour of the flat modelPricing map --
// nothing downstream cares about file version or updated date today.
type pricingFile struct {
	Version int             `yaml:"version"`
	Updated string          `yaml:"updated"`
	Models  []pricingEntry  `yaml:"models"`
}

// pricingEntry is one row in the YAML models list.
type pricingEntry struct {
	ModelID  string  `yaml:"model_id"`
	Provider string  `yaml:"provider"`
	Input    float64 `yaml:"input"`
	Output   float64 `yaml:"output"`
	Notes    string  `yaml:"notes,omitempty"`
}

// validProviders is the closed set of provider strings the YAML may
// contain. Mirrors the CASE expression in ProviderCaseSQL (pricing.go).
// "unknown" is deliberately not accepted -- a model the loader cannot
// attribute to a provider is a data-quality error, not a valid entry.
var validProviders = map[string]bool{
	"anthropic": true,
	"openai":    true,
	"google":    true,
	"xai":       true,
	"mistral":   true,
	"meta":      true,
	"other":     true,
}

// safetyPricing is the last-resort map used when pricing.yaml cannot be
// read or parsed. Covers the four models that show up in smoke tests
// so a misconfigured dev stack still emits non-zero cost numbers. The
// full table lives in pricing.yaml -- do not add entries here.
var safetyPricing = map[string]ModelPricing{
	"claude-sonnet-4-6": {3.00, 15.00},
	"claude-haiku-4-5":  {1.00, 5.00},
	"gpt-4o":            {2.50, 10.00},
	"gpt-4o-mini":       {0.15, 0.60},
}

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

// LoadPricing loads pricing.yaml from the resolved path and replaces
// the package-level modelPricing map. Call once at service startup,
// before any analytics query. Safe to call repeatedly; the last call
// wins.
//
// On success, logs the loaded model count and source path at INFO.
// On failure, logs the error at WARN and replaces modelPricing with
// the safety map so the service still starts.
func LoadPricing() {
	path := resolvePricingPath()
	if path == "" {
		slog.Warn(
			"pricing.yaml not found on any known path; falling back to safety map",
			"candidates", "$FLIGHTDECK_PRICING_PATH, /etc/flightdeck/pricing.yaml, ./pricing.yaml",
			"safety_model_count", len(safetyPricing),
		)
		modelPricing = cloneMap(safetyPricing)
		return
	}

	loaded, err := parsePricingFile(path)
	if err != nil {
		slog.Warn(
			"pricing.yaml load failed; falling back to safety map",
			"path", path,
			"err", err,
			"safety_model_count", len(safetyPricing),
		)
		modelPricing = cloneMap(safetyPricing)
		return
	}

	slog.Info(
		"loaded pricing.yaml",
		"path", path,
		"model_count", len(loaded),
	)
	modelPricing = loaded
}

// parsePricingFile reads, parses, and validates a pricing YAML file.
// Returns the resulting map (never nil on success) or an error. Pulled
// out of LoadPricing so tests can exercise load / validate paths
// directly without touching package-level state.
func parsePricingFile(path string) (map[string]ModelPricing, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	var file pricingFile
	if err := yaml.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	if len(file.Models) == 0 {
		return nil, fmt.Errorf("%s: models list is empty", path)
	}

	out := make(map[string]ModelPricing, len(file.Models))
	for i, entry := range file.Models {
		if err := validatePricingEntry(entry, i); err != nil {
			return nil, err
		}
		if _, dup := out[entry.ModelID]; dup {
			return nil, fmt.Errorf("duplicate model_id %q", entry.ModelID)
		}
		out[entry.ModelID] = ModelPricing{
			InputPerMTok:  entry.Input,
			OutputPerMTok: entry.Output,
		}
	}
	return out, nil
}

// validatePricingEntry enforces the rules documented at the top of
// pricing.yaml. Errors mention the index so a malformed file points
// at the offending entry without the user having to count rows.
func validatePricingEntry(e pricingEntry, idx int) error {
	if e.ModelID == "" {
		return fmt.Errorf("entry %d: model_id is required", idx)
	}
	if e.Provider == "" {
		return fmt.Errorf("entry %d (%s): provider is required", idx, e.ModelID)
	}
	if !validProviders[e.Provider] {
		return fmt.Errorf(
			"entry %d (%s): unknown provider %q -- must be one of anthropic, openai, google, xai, mistral, meta, other",
			idx, e.ModelID, e.Provider,
		)
	}
	if e.Input < 0 {
		return fmt.Errorf("entry %d (%s): input must be >= 0 (got %v)", idx, e.ModelID, e.Input)
	}
	if e.Output < 0 {
		return fmt.Errorf("entry %d (%s): output must be >= 0 (got %v)", idx, e.ModelID, e.Output)
	}
	return nil
}

// cloneMap defensively copies a ModelPricing map so callers who later
// mutate the returned map via modelPricing can't leak changes back
// into the safetyPricing literal.
func cloneMap(src map[string]ModelPricing) map[string]ModelPricing {
	out := make(map[string]ModelPricing, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}
