package tests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
)

// registryEntry is the part of a client type registry entry the tool
// error gate reads.
type registryEntry struct {
	ID                  string `json:"id"`
	StripsToolErrorText bool   `json:"strips_tool_error_text"`
}

// readRegistry reads the client type registry's one source. It fails,
// not skips, when the file is missing: the copy in the processor must
// stay pinned.
func readRegistry(t *testing.T) []registryEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "client_types.json"))
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

func TestToolErrorStrippingClientTypes_MatchTheRegistry(t *testing.T) {
	var want []string
	for _, c := range readRegistry(t) {
		if c.StripsToolErrorText {
			want = append(want, c.ID)
		}
	}
	if !slices.Equal(processor.ToolErrorStrippingClientTypes, want) {
		t.Fatalf("ToolErrorStrippingClientTypes = %v, the registry marks %v",
			processor.ToolErrorStrippingClientTypes, want)
	}
}

// Every registry type's failed tool call is gated exactly when the
// registry says the worker strips its error text.
func TestToolErrorCaptureGate_FollowsTheRegistry(t *testing.T) {
	errBlock := json.RawMessage(`{"error_type":"other","message":"Exit code 2: secret"}`)
	for _, c := range readRegistry(t) {
		for _, eventType := range []string{"tool_call", "mcp_tool_call"} {
			e := consumer.EventPayload{ClientType: c.ID, EventType: eventType, Error: errBlock}
			if got := processor.ToolErrorNeedsCaptureCheck(e); got != c.StripsToolErrorText {
				t.Errorf("%s %s: ToolErrorNeedsCaptureCheck = %v, registry strips_tool_error_text = %v",
					c.ID, eventType, got, c.StripsToolErrorText)
			}
		}
	}
}
