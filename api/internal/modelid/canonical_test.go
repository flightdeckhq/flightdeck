package modelid

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// vectors are the test vectors the workers twin of this package keeps in
// workers/internal/modelid/testdata/vectors.json; both packages test
// against that one file, so the two cannot drift.
type vectors struct {
	Canonicalize []struct {
		Raw   string `json:"raw"`
		Model string `json:"model"`
		Scope string `json:"scope"`
	} `json:"canonicalize"`
	Idempotent []string          `json:"idempotent"`
	Provider   map[string]string `json:"provider"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../workers/internal/modelid/testdata/vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Canonicalize) == 0 || len(v.Provider) == 0 {
		t.Fatal("vectors file is empty")
	}
	return v
}

func TestCanonicalize(t *testing.T) {
	for _, tc := range loadVectors(t).Canonicalize {
		got := Canonicalize(tc.Raw)
		if got.Model != tc.Model || got.InferenceScope != tc.Scope {
			t.Errorf("Canonicalize(%q) = {%q, %q}, want {%q, %q}",
				tc.Raw, got.Model, got.InferenceScope, tc.Model, tc.Scope)
		}
	}
}

func TestCanonicalize_IsIdempotent(t *testing.T) {
	for _, raw := range loadVectors(t).Idempotent {
		once := Canonicalize(raw).Model
		if twice := Canonicalize(once).Model; twice != once {
			t.Errorf("Canonicalize not idempotent for %q: %q then %q", raw, once, twice)
		}
	}
}

func TestProvider(t *testing.T) {
	for model, want := range loadVectors(t).Provider {
		if got := Provider(model); got != want {
			t.Errorf("Provider(%q) = %q, want %q", model, got, want)
		}
	}
}

// The two twins share their code as well as their vectors: everything
// after the package clause must be identical.
func TestTwinMatchesWorkers(t *testing.T) {
	body := func(path string) string {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		s := string(raw)
		i := strings.Index(s, "package modelid")
		if i < 0 {
			t.Fatalf("%s has no package clause", path)
		}
		return s[i:]
	}
	if body("canonical.go") != body("../../../workers/internal/modelid/canonical.go") {
		t.Error("api/internal/modelid/canonical.go has drifted from workers/internal/modelid/canonical.go")
	}
}
