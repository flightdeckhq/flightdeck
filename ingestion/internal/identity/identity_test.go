package identity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// identityVectors is contracts/identity_vectors.json, generated from the
// Python sensor; the plugin's tests read the same file.
type identityVectors struct {
	Namespace string `json:"namespace_flightdeck"`
	UUID5     []struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		UUID      string `json:"uuid"`
	} `json:"uuid5"`
	AgentID []struct {
		AgentType  string  `json:"agent_type"`
		User       string  `json:"user"`
		Hostname   string  `json:"hostname"`
		ClientType string  `json:"client_type"`
		AgentName  string  `json:"agent_name"`
		AgentRole  *string `json:"agent_role"`
		Want       string  `json:"agent_id"`
	} `json:"agent_id"`
	RoleTrim []rune `json:"role_trim_code_points"`
}

// TrimRole removes exactly the characters the sensor's str.strip()
// removes, over every code point.
func TestTrimRoleIsStrStrip(t *testing.T) {
	want := map[rune]bool{}
	for _, r := range loadVectors(t).RoleTrim {
		want[r] = true
	}
	if len(want) == 0 {
		t.Fatal("no role_trim_code_points in the vectors")
	}
	for r := rune(0); r <= 0x10FFFF; r++ {
		if r >= 0xD800 && r <= 0xDFFF {
			continue
		}
		if got := TrimRole("a"+string(r)) == "a"; got != want[r] {
			t.Errorf("U+%04X trimmed=%v, str.strip() trims=%v", r, got, want[r])
		}
	}
}

func loadVectors(t *testing.T) identityVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "identity_vectors.json"))
	if err != nil {
		t.Fatalf("read contracts/identity_vectors.json: %v", err)
	}
	var v identityVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse identity vectors: %v", err)
	}
	if len(v.UUID5) == 0 || len(v.AgentID) == 0 {
		t.Fatal("identity vectors are empty")
	}
	return v
}

func TestNamespaceMatchesTheVectors(t *testing.T) {
	if got := loadVectors(t).Namespace; got != NamespaceFlightdeck {
		t.Fatalf("namespace %s, vectors say %s", NamespaceFlightdeck, got)
	}
}

func TestUUID5MatchesTheSensor(t *testing.T) {
	for _, v := range loadVectors(t).UUID5 {
		if got := UUID5(v.Namespace, v.Name); got != v.UUID {
			t.Errorf("UUID5(%s, %q) = %s, want %s", v.Namespace, v.Name, got, v.UUID)
		}
	}
}

func TestAgentIDMatchesTheSensor(t *testing.T) {
	for _, v := range loadVectors(t).AgentID {
		role := ""
		if v.AgentRole != nil {
			role = *v.AgentRole
		}
		got := AgentID(v.AgentType, v.User, v.Hostname, v.ClientType, v.AgentName, role)
		if got != v.Want {
			t.Errorf("AgentID(%s, %s, %s, %s, %s, %q) = %s, want %s",
				v.AgentType, v.User, v.Hostname, v.ClientType, v.AgentName, role, got, v.Want)
		}
	}
}

// The role is the sixth segment only when it is not blank, so a blank
// role and no role are the same agent and a real role is another.
func TestAgentIDRoleSegment(t *testing.T) {
	root := AgentID("coding", "u", "h", "claude_code", "u@h", "")
	if AgentID("coding", "u", "h", "claude_code", "u@h", " \t ") != root {
		t.Error("a blank role must collapse to the five-segment id")
	}
	if AgentID("coding", "u", "h", "claude_code", "u@h", "Explore") == root {
		t.Error("a role must change the id")
	}
	if AgentID("coding", "u", "h", "claude_code", "u@h", " Explore ") !=
		AgentID("coding", "u", "h", "claude_code", "u@h", "Explore") {
		t.Error("the role is trimmed")
	}
}

func TestUUID5PanicsOnABadNamespace(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("UUID5 accepted a namespace that is not a UUID")
		}
	}()
	UUID5("not-a-uuid", "x")
}
