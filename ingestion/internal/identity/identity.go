// Package identity derives Flightdeck's deterministic identifiers: the
// RFC 4122 version 5 UUIDs the sensor and the Claude Code plugin mint
// for agents, sessions and events. It is the Go twin of
// sensor/flightdeck_sensor/core/agent_id.py and
// plugin/hooks/scripts/agent_id.mjs; all three must produce identical
// ids for identical inputs, which contracts/identity_vectors.json pins
// for each of them.
package identity

import (
	"crypto/sha1" //nolint:gosec // RFC 4122 version 5 is defined over SHA-1; it is an id, not a digest of secrets.
	"encoding/hex"
	"strings"
)

// NamespaceFlightdeck is the namespace every Flightdeck UUID5 is minted
// in: uuid5(NAMESPACE_DNS, "flightdeck.dev"). Frozen: changing it
// orphans every agent_id already stored.
const NamespaceFlightdeck = "ee22ab58-26fc-54ef-91b4-b5c0a97f9b61"

// UUID5 is the RFC 4122 version 5 UUID of name in namespace, in the
// canonical lower-case 8-4-4-4-12 form. namespace must be a canonical
// UUID; UUID5 panics otherwise, since every caller passes a constant.
func UUID5(namespace, name string) string {
	ns, err := hex.DecodeString(strings.ReplaceAll(namespace, "-", ""))
	if err != nil || len(ns) != 16 {
		panic("identity: namespace is not a canonical UUID: " + namespace)
	}
	h := sha1.New() //nolint:gosec // see the import comment
	h.Write(ns)
	h.Write([]byte(name))
	sum := h.Sum(nil)[:16]
	sum[6] = (sum[6] & 0x0f) | 0x50 // version 5
	sum[8] = (sum[8] & 0x3f) | 0x80 // RFC 4122 variant
	var b strings.Builder
	b.Grow(36)
	for i, c := range sum {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			b.WriteByte('-')
		}
		b.WriteString(hex.EncodeToString([]byte{c}))
	}
	return b.String()
}

// AgentID derives an agent's id from its identity tuple:
//
//	flightdeck://{agent_type}/{user}@{hostname}/{client_type}/{agent_name}
//
// with the trimmed agent_role appended as a sixth segment when it is not
// empty, so a root agent and the sub-agents it runs under one role are
// separate agents. Callers pass "unknown" for a component they cannot
// determine.
func AgentID(agentType, user, hostname, clientType, agentName, agentRole string) string {
	path := "flightdeck://" + agentType + "/" + user + "@" + hostname + "/" + clientType + "/" + agentName
	if role := strings.TrimSpace(agentRole); role != "" {
		path += "/" + role
	}
	return UUID5(NamespaceFlightdeck, path)
}
