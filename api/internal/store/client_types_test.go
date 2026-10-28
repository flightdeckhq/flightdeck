package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// clientTypeEntry is the part of a client type registry entry the cost
// query reads.
type clientTypeEntry struct {
	ID          string `json:"id"`
	BillingMode string `json:"billing_mode"`
}

// readClientTypeRegistry reads the client type registry's one source.
// It fails, not skips, when the file is missing: the copy in pricing.go
// must stay pinned.
func readClientTypeRegistry(t *testing.T) []clientTypeEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "client_types.json"))
	if err != nil {
		t.Fatalf("read contracts/client_types.json: %v", err)
	}
	var reg struct {
		ClientTypes []clientTypeEntry `json:"client_types"`
	}
	if err := json.Unmarshal(raw, &reg); err != nil {
		t.Fatalf("parse contracts/client_types.json: %v", err)
	}
	return reg.ClientTypes
}

func TestSubscriptionClientTypes_MatchTheRegistry(t *testing.T) {
	var want []string
	for _, c := range readClientTypeRegistry(t) {
		if c.BillingMode == "subscription" {
			want = append(want, c.ID)
		}
	}
	if !slices.Equal(subscriptionClientTypes, want) {
		t.Fatalf("subscriptionClientTypes = %v, the registry marks %v", subscriptionClientTypes, want)
	}
}
