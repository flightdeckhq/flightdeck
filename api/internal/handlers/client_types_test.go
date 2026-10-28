package handlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// registryIDs reads the client type registry's one source. It fails, not
// skips, when the file is missing: the copies below must stay pinned.
func registryIDs(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "client_types.json"))
	if err != nil {
		t.Fatalf("read contracts/client_types.json: %v", err)
	}
	var reg struct {
		ClientTypes []struct {
			ID string `json:"id"`
		} `json:"client_types"`
	}
	if err := json.Unmarshal(raw, &reg); err != nil {
		t.Fatalf("parse contracts/client_types.json: %v", err)
	}
	ids := make([]string, 0, len(reg.ClientTypes))
	for _, c := range reg.ClientTypes {
		ids = append(ids, c.ID)
	}
	return ids
}

func TestClientTypes_MatchTheRegistry(t *testing.T) {
	want := registryIDs(t)
	if !slices.Equal(registryClientTypes, want) {
		t.Fatalf("registryClientTypes = %v, the registry lists %v", registryClientTypes, want)
	}
	for _, c := range want {
		if !validClientTypes[c] {
			t.Errorf("validClientTypes does not accept %q", c)
		}
	}
	if len(validClientTypes) != len(want) {
		t.Errorf("validClientTypes has %d values, the registry %d", len(validClientTypes), len(want))
	}
}

// The client_type filters' Swagger text names every accepted value.
func TestClientTypeFilterDocs_NameEveryRegistryValue(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "docs", "swagger.json"))
	if err != nil {
		t.Fatalf("read docs/swagger.json: %v", err)
	}
	var spec struct {
		Paths map[string]map[string]struct {
			Parameters []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"parameters"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatalf("parse docs/swagger.json: %v", err)
	}
	ids := registryIDs(t)
	found := 0
	for path, ops := range spec.Paths {
		for method, op := range ops {
			for _, p := range op.Parameters {
				if p.Name != "client_type" {
					continue
				}
				found++
				for _, id := range ids {
					if !strings.Contains(p.Description, id) {
						t.Errorf("%s %s client_type param does not name %q", method, path, id)
					}
				}
			}
		}
	}
	if found == 0 {
		t.Fatal("no client_type parameter found in docs/swagger.json")
	}
}
