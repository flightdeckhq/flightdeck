package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// clientTypeEntry is the part of a client type registry entry the
// store reads: the cost query's billing default and the directive
// targeting defaults.
type clientTypeEntry struct {
	ID                   string `json:"id"`
	BillingMode          string `json:"billing_mode"`
	SupportsDirectives   bool   `json:"supports_directives"`
	RunsCustomDirectives bool   `json:"runs_custom_directives"`
}

// readClientTypeRegistry reads the client type registry's one source.
// It fails, not skips, when the file is missing: the copies in
// pricing.go and directives.go must stay pinned.
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

func TestDirectiveClientTypes_MatchTheRegistry(t *testing.T) {
	var want []string
	for _, c := range readClientTypeRegistry(t) {
		if c.SupportsDirectives {
			want = append(want, c.ID)
		}
	}
	if !slices.Equal(directiveClientTypes, want) {
		t.Fatalf("directiveClientTypes = %v, the registry marks %v", directiveClientTypes, want)
	}
}

func TestCustomDirectiveClientTypes_MatchTheRegistry(t *testing.T) {
	var want []string
	for _, c := range readClientTypeRegistry(t) {
		if c.RunsCustomDirectives {
			want = append(want, c.ID)
		}
	}
	if !slices.Equal(customDirectiveClientTypes, want) {
		t.Fatalf("customDirectiveClientTypes = %v, the registry marks %v", customDirectiveClientTypes, want)
	}
}
