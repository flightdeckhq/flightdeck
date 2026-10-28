package handlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
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
