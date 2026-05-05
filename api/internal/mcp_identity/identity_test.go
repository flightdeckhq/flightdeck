// Cross-language fixture parity tests for the Go identity helper.
// Loads tests/fixtures/mcp_identity_vectors.json (the same file the
// Python and Node suites load) and asserts that CanonicalizeURL,
// Fingerprint, and FingerprintShort produce byte-identical output
// for every vector.
//
// If this suite passes alongside the sensor pytest and the plugin
// node --test suites, all three implementations are locked against
// drift.

package mcp_identity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type fixtureVector struct {
	ID               string `json:"id"`
	RawURL           string `json:"raw_url"`
	Name             string `json:"name"`
	CanonicalURL     string `json:"canonical_url"`
	FingerprintFull  string `json:"fingerprint_full"`
	FingerprintShort string `json:"fingerprint_short"`
}

type fixtureDoc struct {
	Version       int                `json:"version"`
	Namespace     string             `json:"namespace"`
	EnvOverrides  map[string]string  `json:"env_overrides"`
	Vectors       []fixtureVector    `json:"vectors"`
}

// fixturePath resolves tests/fixtures/mcp_identity_vectors.json from
// this test file's location. The file lives at
// <repo>/tests/fixtures/mcp_identity_vectors.json; this test file
// lives at <repo>/api/internal/mcp_identity/identity_test.go, so go
// up three levels to reach the repo root.
func fixturePath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	repo := filepath.Join(dir, "..", "..", "..")
	return filepath.Join(repo, "tests", "fixtures", "mcp_identity_vectors.json")
}

func loadFixture(t *testing.T) fixtureDoc {
	t.Helper()
	data, err := os.ReadFile(fixturePath(t))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var doc fixtureDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return doc
}

// applyEnvOverrides sets the env vars the env-var-resolution vectors
// expect, and explicitly unsets the missing-var vector's variable so
// the "stays literal" assertion is deterministic. Uses t.Setenv so
// values revert at test end.
func applyEnvOverrides(t *testing.T, overrides map[string]string) {
	t.Helper()
	for k, v := range overrides {
		t.Setenv(k, v)
	}
	// FLIGHTDECK_TEST_MISSING is asserted-unset by the
	// stdio-env-var-missing-stays-literal vector. t.Setenv with an
	// empty value is NOT the same as unset (LookupEnv returns
	// ok=true with ""), so we use os.Unsetenv directly and rely on
	// the test not running concurrently with code that re-sets it.
	_ = os.Unsetenv("FLIGHTDECK_TEST_MISSING")
}

func TestCrossLanguageFixtureVectors(t *testing.T) {
	doc := loadFixture(t)
	applyEnvOverrides(t, doc.EnvOverrides)

	if len(doc.Vectors) == 0 {
		t.Fatal("fixture has no vectors")
	}

	for _, vec := range doc.Vectors {
		vec := vec // capture
		t.Run(vec.ID, func(t *testing.T) {
			canonical, err := CanonicalizeURL(vec.RawURL)
			if err != nil {
				t.Fatalf("CanonicalizeURL(%q): %v", vec.RawURL, err)
			}
			if canonical != vec.CanonicalURL {
				t.Errorf("CanonicalizeURL(%q) = %q, want %q",
					vec.RawURL, canonical, vec.CanonicalURL)
			}

			full := Fingerprint(vec.CanonicalURL, vec.Name)
			if full != vec.FingerprintFull {
				t.Errorf("Fingerprint(%q, %q) = %q, want %q",
					vec.CanonicalURL, vec.Name, full, vec.FingerprintFull)
			}

			short := FingerprintShort(vec.CanonicalURL, vec.Name)
			if short != vec.FingerprintShort {
				t.Errorf("FingerprintShort(%q, %q) = %q, want %q",
					vec.CanonicalURL, vec.Name, short, vec.FingerprintShort)
			}
		})
	}
}

// ----- Standalone edge cases (mirror the Python and JS suites) ---

func TestCanonicalizeEmptyStringIsStdioEmpty(t *testing.T) {
	got, err := CanonicalizeURL("")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "stdio://" {
		t.Errorf("got %q, want stdio://", got)
	}
}

func TestCanonicalizeWhitespaceOnlyIsStdioEmpty(t *testing.T) {
	got, err := CanonicalizeURL("   \t  \n ")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "stdio://" {
		t.Errorf("got %q, want stdio://", got)
	}
}

func TestCanonicalizeExplicitStdioPrefix(t *testing.T) {
	got, err := CanonicalizeURL("stdio://npx package")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "stdio://npx package" {
		t.Errorf("got %q, want stdio://npx package", got)
	}
}

func TestFingerprintSeparatorPreventsCollision(t *testing.T) {
	a := Fingerprint("https://a.com", "bservice")
	b := Fingerprint("https://a.combservice", "")
	if a == b {
		t.Error("fingerprints collided despite distinct (url, name) pairs")
	}
}

func TestFingerprintUnicodeName(t *testing.T) {
	one := Fingerprint("https://example.com", "ñame")
	two := Fingerprint("https://example.com", "ñame")
	if one != two {
		t.Errorf("non-deterministic Unicode fingerprint")
	}
	if len(one) != 64 {
		t.Errorf("fingerprint length = %d, want 64", len(one))
	}
}

func TestFingerprintShortIsPrefixOfFull(t *testing.T) {
	full := Fingerprint("https://example.com/api", "test")
	short := FingerprintShort("https://example.com/api", "test")
	if full[:16] != short {
		t.Errorf("FingerprintShort = %q, want %q", short, full[:16])
	}
}

func TestCanonicalizeHTTPDefaultPort80Stripped(t *testing.T) {
	got, err := CanonicalizeURL("http://example.com:80/api")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "http://example.com/api" {
		t.Errorf("got %q, want http://example.com/api", got)
	}
}

func TestCanonicalizeStdioEnvVarBareForm(t *testing.T) {
	t.Setenv("FLIGHTDECK_TEST_DOLLAR_FORM", "/x")
	got, err := CanonicalizeURL("cmd $FLIGHTDECK_TEST_DOLLAR_FORM/data")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "stdio://cmd /x/data" {
		t.Errorf("got %q, want stdio://cmd /x/data", got)
	}
}
