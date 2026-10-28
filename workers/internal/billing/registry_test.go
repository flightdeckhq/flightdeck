package billing

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// registryEntry is the part of a client type registry entry the billing
// default reads.
type registryEntry struct {
	ID          string `json:"id"`
	BillingMode string `json:"billing_mode"`
}

// readRegistry reads the client type registry's one source. It fails,
// not skips, when the file is missing: the copy here must stay pinned.
func readRegistry(t *testing.T) []registryEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "client_types.json"))
	if err != nil {
		t.Fatalf("read contracts/client_types.json: %v", err)
	}
	var reg struct {
		ClientTypes []registryEntry `json:"client_types"`
	}
	if err := json.Unmarshal(raw, &reg); err != nil {
		t.Fatalf("parse contracts/client_types.json: %v", err)
	}
	return reg.ClientTypes
}

func TestSubscriptionClientTypes_MatchTheRegistry(t *testing.T) {
	var want []string
	for _, c := range readRegistry(t) {
		if c.BillingMode == Subscription {
			want = append(want, c.ID)
		}
	}
	if !slices.Equal(SubscriptionClientTypes, want) {
		t.Fatalf("SubscriptionClientTypes = %v, the registry marks %v", SubscriptionClientTypes, want)
	}
}

func TestDefaultMode_IsTheRegistryDefault(t *testing.T) {
	for _, c := range readRegistry(t) {
		if got := DefaultMode(c.ID); got != c.BillingMode {
			t.Errorf("DefaultMode(%q) = %q, the registry default is %q", c.ID, got, c.BillingMode)
		}
	}
}
