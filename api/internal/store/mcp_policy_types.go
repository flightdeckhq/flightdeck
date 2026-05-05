// MCP Protection Policy types — Go structs mirroring the migration
// 000018 schema and the API DTOs. See ARCHITECTURE.md "MCP Protection
// Policy" → "Storage schema" for the canonical contract and D128 for
// the rationale behind the four-table split.

package store

import (
	"encoding/json"
	"time"
)

// MCPPolicy is the live state of one policy row. The Entries slice
// is populated only by the detail-fetch path (GetGlobalMCPPolicy /
// GetMCPPolicy); the listing path leaves it nil.
type MCPPolicy struct {
	ID                 string             `json:"id"`
	Scope              string             `json:"scope"`                 // "global" | "flavor"
	ScopeValue         *string            `json:"scope_value,omitempty"` // NULL for global
	Mode               *string            `json:"mode,omitempty"`        // global only — D134
	BlockOnUncertainty bool               `json:"block_on_uncertainty"`
	Version            int                `json:"version"`
	CreatedAt          time.Time          `json:"created_at"`
	UpdatedAt          time.Time          `json:"updated_at"`
	Entries            []MCPPolicyEntry   `json:"entries,omitempty"`
}

// MCPPolicyEntry is one allow / deny entry on a policy. server_url
// is stored canonical (per D127); fingerprint is the first 16 hex
// chars of sha256(canonical_url + 0x00 + name).
type MCPPolicyEntry struct {
	ID                 string    `json:"id"`
	PolicyID           string    `json:"policy_id"`
	ServerURLCanonical string    `json:"server_url"`
	ServerName         string    `json:"server_name"`
	Fingerprint        string    `json:"fingerprint"`
	EntryKind          string    `json:"entry_kind"` // "allow" | "deny"
	Enforcement        *string   `json:"enforcement,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

// MCPPolicyVersion is one historical snapshot. Snapshot is the full
// policy + entries serialised as JSON at the time of the PUT.
type MCPPolicyVersion struct {
	ID        string          `json:"id"`
	PolicyID  string          `json:"policy_id"`
	Version   int             `json:"version"`
	Snapshot  json.RawMessage `json:"snapshot" swaggertype:"object"`
	CreatedAt time.Time       `json:"created_at"`
	CreatedBy *string         `json:"created_by,omitempty"`
}

// MCPPolicyVersionMeta is the listing-level shape (no full snapshot).
type MCPPolicyVersionMeta struct {
	ID        string    `json:"id"`
	PolicyID  string    `json:"policy_id"`
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	CreatedBy *string   `json:"created_by,omitempty"`
}

// MCPPolicyAuditLog is one operator-initiated mutation record.
// Sensor-observed system state (decision events, name drift) lives
// in the events pipeline, NOT here (D131).
type MCPPolicyAuditLog struct {
	ID         string          `json:"id"`
	PolicyID   *string         `json:"policy_id,omitempty"` // NULL after policy deletion
	EventType  string          `json:"event_type"`
	Actor      *string         `json:"actor,omitempty"`
	Payload    json.RawMessage `json:"payload" swaggertype:"object"`
	OccurredAt time.Time       `json:"occurred_at"`
}

// MCPPolicyResolveResult is the response shape for GET /resolve.
// decision_path tells the caller which step in the D135 algorithm
// produced the decision.
type MCPPolicyResolveResult struct {
	Decision     string `json:"decision"`      // "allow" | "warn" | "block"
	DecisionPath string `json:"decision_path"` // "flavor_entry" | "global_entry" | "mode_default"
	PolicyID     string `json:"policy_id"`
	Scope        string `json:"scope"` // "global" | "flavor:<value>"
	Fingerprint  string `json:"fingerprint"`
}

// MCPPolicyMetrics is the response shape for GET /:flavor/metrics.
// The buckets stay empty until step 4 ships the policy_mcp_warn /
// policy_mcp_block events.
type MCPPolicyMetrics struct {
	Period          string              `json:"period"`
	BlocksPerServer []ServerCountBucket `json:"blocks_per_server"`
	WarnsPerServer  []ServerCountBucket `json:"warns_per_server"`
}

// ServerCountBucket carries one row of the metrics aggregate.
type ServerCountBucket struct {
	Fingerprint string `json:"fingerprint"`
	ServerName  string `json:"server_name"`
	Count       int    `json:"count"`
}

// MCPPolicyDryRunResult is the response shape for POST /:flavor/dry_run.
// UnresolvableCount captures events whose session lacks
// context.mcp_servers and so cannot be replayed against the proposed
// policy (D137).
type MCPPolicyDryRunResult struct {
	Hours             int                  `json:"hours"`
	EventsReplayed    int                  `json:"events_replayed"`
	PerServer         []DryRunServerCount  `json:"per_server"`
	UnresolvableCount int                  `json:"unresolvable_count"`
}

// DryRunServerCount carries the per-server preview of what enforcement
// would have done for the server's traffic in the replay window.
type DryRunServerCount struct {
	Fingerprint string `json:"fingerprint"`
	ServerName  string `json:"server_name"`
	WouldAllow  int    `json:"would_allow"`
	WouldWarn   int    `json:"would_warn"`
	WouldBlock  int    `json:"would_block"`
}

// MCPPolicyDiff is the response shape for GET /:flavor/diff.
// Server-side computation keeps the diff logic in one place. The
// full snapshots are included so consumers can render their own
// diff if they prefer.
type MCPPolicyDiff struct {
	FromVersion               int              `json:"from_version"`
	ToVersion                 int              `json:"to_version"`
	FromSnapshot              json.RawMessage  `json:"from_snapshot" swaggertype:"object"`
	ToSnapshot                json.RawMessage  `json:"to_snapshot" swaggertype:"object"`
	ModeChanged               *DiffString      `json:"mode_changed,omitempty"`
	BlockOnUncertaintyChanged *DiffBool        `json:"block_on_uncertainty_changed,omitempty"`
	EntriesAdded              []MCPPolicyEntry `json:"entries_added"`
	EntriesRemoved            []MCPPolicyEntry `json:"entries_removed"`
	EntriesChanged            []EntryDiff      `json:"entries_changed"`
}

// DiffString is a from/to pair for string fields.
type DiffString struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// DiffBool is a from/to pair for boolean fields.
type DiffBool struct {
	From bool `json:"from"`
	To   bool `json:"to"`
}

// EntryDiff captures a same-fingerprint entry whose other fields
// (entry_kind, enforcement, server_name) changed across the two
// versions being diffed.
type EntryDiff struct {
	Fingerprint string         `json:"fingerprint"`
	Before      MCPPolicyEntry `json:"before"`
	After       MCPPolicyEntry `json:"after"`
}

// MCPPolicyMutation is the input shape accepted by Create / Update
// handlers. Mode is ignored on flavor-policy operations (storage
// CHECK enforces D134 at the SQL boundary).
type MCPPolicyMutation struct {
	Mode               *string                  `json:"mode,omitempty"`
	BlockOnUncertainty bool                     `json:"block_on_uncertainty"`
	Entries            []MCPPolicyEntryMutation `json:"entries"`
}

// MCPPolicyEntryMutation is the input shape for one entry inside a
// Create / Update payload. ServerURLCanonical is computed server-
// side from ServerURL + ServerName via the Go identity helper; the
// caller passes the raw URL.
type MCPPolicyEntryMutation struct {
	ServerURL   string  `json:"server_url"`
	ServerName  string  `json:"server_name"`
	EntryKind   string  `json:"entry_kind"`
	Enforcement *string `json:"enforcement,omitempty"`
}
