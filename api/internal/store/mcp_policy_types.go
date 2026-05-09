// MCP Protection Policy types — Go structs mirroring the live schema
// (migration 000018 minus what 000020 dropped per D142) and the API
// DTOs. See ARCHITECTURE.md "MCP Protection Policy" → "Storage
// schema" for the canonical contract and D128 for the rationale
// behind the table split.

package store

import (
	"encoding/json"
	"time"
)

// MCPPolicy is the live state of one policy row. The Entries slice
// is populated only by the detail-fetch path (GetGlobalMCPPolicy /
// GetMCPPolicy); the listing path leaves it nil.
type MCPPolicy struct {
	ID                 string           `json:"id"`
	Scope              string           `json:"scope"`                 // "global" | "flavor"
	ScopeValue         *string          `json:"scope_value,omitempty"` // NULL for global
	Mode               *string          `json:"mode,omitempty"`        // global only — D134
	BlockOnUncertainty bool             `json:"block_on_uncertainty"`
	CreatedAt          time.Time        `json:"created_at"`
	UpdatedAt          time.Time        `json:"updated_at"`
	Entries            []MCPPolicyEntry `json:"entries,omitempty"`
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
// Carries both the time-bucketed series (Buckets, used by the
// dashboard sparklines) and the aggregate per-server counts
// (BlocksPerServer / WarnsPerServer, used by the panel header
// summary table). Step 6.5 added the bucketed shape; the
// aggregates are computed server-side from the same data so the
// header stays single-fetch.
//
// Granularity is 'hour' for period=24h and 'day' for period=7d /
// 30d. The bucket array zero-fills empty time slots via SQL
// generate_series so the sparkline renders honest "no events"
// valleys — sparse data on a security dashboard would render a
// flat-then-spike pattern as a gradual ramp, which is misleading.
type MCPPolicyMetrics struct {
	Period          string                   `json:"period"`
	Granularity     string                   `json:"granularity"` // "hour" | "day"
	Buckets         []MCPPolicyMetricsBucket `json:"buckets"`
	BlocksPerServer []ServerCountBucket      `json:"blocks_per_server"`
	WarnsPerServer  []ServerCountBucket      `json:"warns_per_server"`
}

// MCPPolicyMetricsBucket is one time slot in the metrics series.
// Timestamp is the bucket-start instant (date_trunc'd to the
// granularity); Blocks / Warns carry per-server counts inside
// that bucket. Empty slots ship through with empty arrays.
type MCPPolicyMetricsBucket struct {
	Timestamp time.Time           `json:"timestamp"`
	Blocks    []ServerCountBucket `json:"blocks"`
	Warns     []ServerCountBucket `json:"warns"`
}

// ServerCountBucket carries one row of the metrics aggregate.
type ServerCountBucket struct {
	Fingerprint string `json:"fingerprint"`
	ServerName  string `json:"server_name"`
	Count       int    `json:"count"`
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
