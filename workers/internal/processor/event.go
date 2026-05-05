package processor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BuildEventExtra projects per-event-type metadata fields from a NATS
// payload into the events.payload JSONB column. Returns nil for events
// that have no extra metadata to persist (e.g. session_start, post_call,
// tool_call). Returns a JSON-encoded map for directive_result events
// containing directive_name, directive_action, directive_status,
// result, error, duration_ms -- omitting any field that is empty/nil.
//
// This is an exported helper so it can be unit-tested directly without
// needing to wire a mock writer through the Processor.
func BuildEventExtra(e consumer.EventPayload) ([]byte, error) {
	// Pre-Phase-4 this function only produced payload for
	// directive_result events. Phase 4 opens it up to any event that
	// carries structured extras -- llm_error events populate
	// ``error`` with the Phase 4 taxonomy object, streaming post_call
	// events populate ``streaming`` with TTFT + chunk stats. The
	// per-field guards below skip any field the event doesn't carry,
	// so non-directive events that also have no Phase 4 extras
	// short-circuit out via ``if len(extra) == 0`` at the bottom and
	// the payload column stays NULL -- matching the prior behaviour
	// for those events exactly.
	extra := make(map[string]interface{})
	if e.DirectiveName != "" {
		extra["directive_name"] = e.DirectiveName
	}
	if e.DirectiveAction != "" {
		extra["directive_action"] = e.DirectiveAction
	}
	if e.DirectiveStatus != "" {
		extra["directive_status"] = e.DirectiveStatus
	}
	if len(e.Result) > 0 {
		// Result is a json.RawMessage -- decode and re-attach so the
		// final encoded payload is a single document, not a string.
		var v interface{}
		if err := json.Unmarshal(e.Result, &v); err == nil {
			extra["result"] = v
		}
	}
	if len(e.Error) > 0 {
		// ``Error`` is json.RawMessage (Phase 4) to carry either the
		// legacy directive_result string OR the structured llm_error
		// object. Unmarshal back to an interface so the encoded
		// payload is one document.
		var v interface{}
		if err := json.Unmarshal(e.Error, &v); err == nil {
			extra["error"] = v
		}
	}
	if e.DurationMs != nil {
		extra["duration_ms"] = *e.DurationMs
	}
	if len(e.Streaming) > 0 {
		// Phase 4 streaming sub-object. Same shape handling as Error
		// above: decode + re-attach so the final payload is a single
		// JSON document.
		var v interface{}
		if err := json.Unmarshal(e.Streaming, &v); err == nil {
			extra["streaming"] = v
		}
	}
	// Policy enforcement fields (policy_warn / policy_degrade /
	// policy_block). Emit only when populated so non-policy events keep
	// their existing payload shape.
	if e.Source != "" {
		extra["source"] = e.Source
	}
	if e.ThresholdPct != nil {
		extra["threshold_pct"] = *e.ThresholdPct
	}
	if e.TokensUsed != nil {
		extra["tokens_used"] = *e.TokensUsed
	}
	if e.TokenLimit != nil {
		extra["token_limit"] = *e.TokenLimit
	}
	if e.FromModel != "" {
		extra["from_model"] = e.FromModel
	}
	if e.ToModel != "" {
		extra["to_model"] = e.ToModel
	}
	if e.IntendedModel != "" {
		extra["intended_model"] = e.IntendedModel
	}
	// Phase 5 MCP fields. Project unconditionally when the sensor sent
	// them — only MCP_* events carry these on the wire. The dashboard's
	// MCPEventDetails component reads them directly from events.payload.
	if e.ServerName != "" {
		extra["server_name"] = e.ServerName
	}
	if e.Transport != "" {
		extra["transport"] = e.Transport
	}
	if e.Count != nil {
		extra["count"] = *e.Count
	}
	if len(e.Arguments) > 0 {
		var v interface{}
		if err := json.Unmarshal(e.Arguments, &v); err == nil {
			extra["arguments"] = v
		}
	}
	if e.ResourceURI != "" {
		extra["resource_uri"] = e.ResourceURI
	}
	if e.ContentBytes != nil {
		extra["content_bytes"] = *e.ContentBytes
	}
	if e.MimeType != "" {
		extra["mime_type"] = e.MimeType
	}
	if e.PromptName != "" {
		extra["prompt_name"] = e.PromptName
	}
	if len(e.Rendered) > 0 {
		var v interface{}
		if err := json.Unmarshal(e.Rendered, &v); err == nil {
			extra["rendered"] = v
		}
	}
	// D131 — MCP Protection Policy event fields. Projects onto
	// events.payload for policy_mcp_warn / policy_mcp_block /
	// mcp_server_name_changed events; non-policy events skip via
	// the omitempty guards because the sensor doesn't populate
	// these fields outside the policy event paths.
	if e.ServerURL != "" {
		extra["server_url"] = e.ServerURL
	}
	if e.Fingerprint != "" {
		extra["fingerprint"] = e.Fingerprint
	}
	if e.PolicyID != "" {
		extra["policy_id"] = e.PolicyID
	}
	if e.Scope != "" {
		extra["scope"] = e.Scope
	}
	if e.DecisionPath != "" {
		extra["decision_path"] = e.DecisionPath
	}
	if e.BlockOnUncertainty != nil {
		extra["block_on_uncertainty"] = *e.BlockOnUncertainty
	}
	if e.WouldHaveBlocked != nil {
		extra["would_have_blocked"] = *e.WouldHaveBlocked
	}
	if e.ServerURLCanonical != "" {
		extra["server_url_canonical"] = e.ServerURLCanonical
	}
	if e.FingerprintOld != "" {
		extra["fingerprint_old"] = e.FingerprintOld
	}
	if e.FingerprintNew != "" {
		extra["fingerprint_new"] = e.FingerprintNew
	}
	if e.NameOld != "" {
		extra["name_old"] = e.NameOld
	}
	if e.NameNew != "" {
		extra["name_new"] = e.NameNew
	}
	// Phase 5 MCP_RESOURCE_READ content. The sensor's lean MCP payload
	// drops the ``has_content`` flag entirely, so the existing
	// HasContent gate (which routes LLM PromptContent into the
	// event_content table) never fires for MCP. Instead the MCP wrapper
	// puts the captured ReadResourceResult JSON into the wire ``content``
	// field, which arrives here in EventPayload.Content as a json.RawMessage.
	// We project it into events.payload JSONB inline — MCP content is
	// small (KB at most), high-cardinality, and dashboards render it
	// inline without an extra fetch round-trip. See dashboard contract
	// in dashboard/tests/e2e/fixtures/README.md.
	if !e.HasContent && len(e.Content) > 0 && isMCPEventType(e.EventType) {
		var v interface{}
		if err := json.Unmarshal(e.Content, &v); err == nil {
			extra["content"] = v
		}
	}

	// D126 — sub-agent observability fields. Project per-event when
	// present so the dashboard reads them from events.payload (same
	// inline-render path the MCP family uses). The wider sub-agent
	// linkage (parent_session_id, agent_role) lands in the sessions
	// table via UpsertSession; persisting them into events.payload
	// too lets the live-feed envelope and the per-event drilldown
	// surface the relationship without a sessions-table join. Small
	// bodies route inline here per D126 § 6's v1 contract; the 8 KiB
	// → event_content overflow path is deferred.
	if e.ParentSessionID != "" {
		extra["parent_session_id"] = e.ParentSessionID
	}
	if e.AgentRole != "" {
		extra["agent_role"] = e.AgentRole
	}
	if e.IncomingMessage != nil {
		extra["incoming_message"] = subagentMessageToMap(e.IncomingMessage)
	}
	if e.OutgoingMessage != nil {
		extra["outgoing_message"] = subagentMessageToMap(e.OutgoingMessage)
	}
	if e.State != "" {
		extra["state"] = e.State
	}
	if len(extra) == 0 {
		return nil, nil
	}
	return json.Marshal(extra)
}

// subagentMessageToMap projects a typed SubagentMessage into the
// shape BuildEventExtra writes into events.payload per D126 § 6 +
// Rule 20. Two shapes land here:
//
//   * Inline (body ≤ 8 KiB): ``{body, captured_at}`` — body is
//     decoded back into the framework's source shape (string /
//     dict / list / scalar / null).
//   * Overflow (body > 8 KiB): ``{has_content, content_bytes,
//     captured_at}`` — body lives in event_content; the dashboard
//     fetches via ``GET /v1/events/{id}/content``. The stub here
//     lets the dashboard render a size-aware "load full message"
//     affordance without an extra round-trip.
//
// Returns the map even when one of the fields is missing so the
// dashboard's MESSAGES sub-section can render a partial envelope
// cleanly rather than treat-as-absent. json.Unmarshal failure on
// Body falls back to nil — the wire shape was technically valid
// (Body is json.RawMessage so it's already byte-validated), so
// this branch is theoretical and keeps the projection panic-free.
func subagentMessageToMap(m *consumer.SubagentMessage) map[string]interface{} {
	out := make(map[string]interface{}, 4)
	if len(m.Body) > 0 {
		var v interface{}
		if err := json.Unmarshal(m.Body, &v); err == nil {
			out["body"] = v
		}
	}
	if m.HasContent {
		out["has_content"] = true
	}
	if m.ContentBytes != nil {
		out["content_bytes"] = *m.ContentBytes
	}
	if m.CapturedAt != "" {
		out["captured_at"] = m.CapturedAt
	}
	return out
}

// isMCPEventType reports whether ``eventType`` is one of the six Phase 5
// MCP event types. Used by BuildEventExtra to gate the MCP-content
// projection: ``content`` on MCP_RESOURCE_READ goes inline into
// events.payload (small, render-inline), whereas ``content`` on LLM
// events routes via HasContent into the event_content table (large,
// fetch-on-demand). Centralising the membership test keeps every
// MCP-specific branch in BuildEventExtra and Process self-consistent.
func isMCPEventType(eventType string) bool {
	switch eventType {
	case "mcp_tool_list", "mcp_tool_call",
		"mcp_resource_list", "mcp_resource_read",
		"mcp_prompt_list", "mcp_prompt_get":
		return true
	}
	return false
}

// Processor routes incoming events to the session processor, writer,
// and policy evaluator.
type Processor struct {
	session *SessionProcessor
	policy  *PolicyEvaluator
	w       *writer.Writer
	pool    *pgxpool.Pool
}

// NewProcessor creates a fully wired Processor.
func NewProcessor(pool *pgxpool.Pool) *Processor {
	w := writer.New(pool)
	return &Processor{
		session: NewSessionProcessor(w, pool),
		policy:  NewPolicyEvaluator(pool),
		w:       w,
		pool:    pool,
	}
}

// Process handles a single event from NATS.
func (p *Processor) Process(ctx context.Context, e consumer.EventPayload) error {
	// Route to the correct session handler
	switch e.EventType {
	case "session_start":
		if err := p.session.HandleSessionStart(ctx, e); err != nil {
			return err
		}
	case "session_end":
		if err := p.session.HandleSessionEnd(ctx, e); err != nil {
			return err
		}
	case "heartbeat":
		if err := p.session.HandleHeartbeat(ctx, e); err != nil {
			return err
		}
	case "post_call", "pre_call", "tool_call":
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "embeddings":
		// Phase 4 addition. Embeddings are a post_call-shaped event
		// with no completion tokens; the ingestion layer validated
		// the schema so we route through the same last-seen + tokens
		// update path. Policy does not evaluate (separate budget
		// surface if ever added; out of scope for Phase 4).
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "llm_error":
		// Phase 4 addition. Structured LLM API error. Route through
		// the same last-seen update path so the session's freshness
		// advances on failed calls too -- otherwise a session that
		// only ever produces errors would age to stale.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "directive_result":
		// Insert event but do NOT evaluate policy. Just update last_seen.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "policy_warn", "policy_degrade", "policy_block",
		"policy_mcp_warn", "policy_mcp_block":
		// Policy enforcement events emitted by the sensor's _pre_call
		// (WARN, BLOCK) and _apply_directive(DEGRADE). Route through
		// HandlePostCall so last_seen_at advances on enforcement
		// activity. Policy is NOT re-evaluated — these events ARE the
		// evaluation outcome; the worker would otherwise emit a
		// duplicate directive.
		//
		// Step 4 (D131): policy_mcp_warn / policy_mcp_block ride the
		// same routing — they're the MCP Protection Policy's
		// equivalent of the LLM-budget enforcement events. The lean
		// payload (server_url / server_name / fingerprint / tool_name
		// / policy_id / scope / decision_path) lands directly in
		// events.payload; no token / model fields fire HandlePostCall's
		// budget-evaluation path because they're nil on the wire.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "mcp_tool_list", "mcp_tool_call",
		"mcp_resource_list", "mcp_resource_read",
		"mcp_prompt_list", "mcp_prompt_get",
		"mcp_server_name_changed":
		// Phase 5 MCP events. Route through HandlePostCall: the lean
		// MCP payload (override 2) carries no token deltas (TokensTotal
		// is nil) and no model field, so HandlePostCall's branch logic
		// short-circuits the token / model UPDATEs and just advances
		// last_seen_at via the no-delta else branch. Policy evaluation
		// stays gated on event_type=="post_call" below so MCP traffic
		// does not trigger LLM-budget directives.
		//
		// MCP_RESOURCE_READ content + MCP_TOOL_CALL/PROMPT_GET arguments
		// + result + rendered survive into events.payload via
		// BuildEventExtra above; server_name + transport land there too
		// for the dashboard MCPEventDetails component to read inline.
		// See dashboard/tests/e2e/fixtures/README.md for the contract.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown event_type: %s", e.EventType)
	}

	// Insert the event record
	ts, err := time.Parse(time.RFC3339, e.Timestamp)
	if err != nil {
		ts = time.Now().UTC()
	}
	extra, extraErr := BuildEventExtra(e)
	if extraErr != nil {
		// Non-fatal: log and proceed without payload metadata.
		slog.Warn("build event extra error", "err", extraErr, "event_type", e.EventType)
	}
	eventID, err := p.w.InsertEvent(
		ctx, e.SessionID, e.Flavor, e.EventType, e.Model,
		e.TokensInput, e.TokensOutput, e.TokensTotal,
		e.TokensCacheRead, e.TokensCacheCreation,
		e.LatencyMs, e.ToolName, e.HasContent, ts, extra,
	)
	if err != nil {
		return err
	}

	// Store prompt content when capture is enabled
	if e.HasContent && len(e.Content) > 0 {
		if err := p.w.InsertEventContent(ctx, eventID, e.SessionID, e.Content); err != nil {
			slog.Warn("insert event content error", "err", err)
		}
	}

	// NOTIFY for real-time dashboard push. eventID is the one just
	// returned by InsertEvent above -- the hub fetches exactly this
	// row by primary key, avoiding the NOTIFY->SELECT race where
	// GetSessionEvents + tail would return a later event under
	// tight paired writes.
	if err := writer.NotifyFleetChange(ctx, p.pool, e.SessionID, e.EventType, eventID); err != nil {
		// Non-fatal: log but don't fail the event
		slog.Warn("notify error", "err", err)
	}

	// Evaluate policy after post_call events
	if e.EventType == "post_call" {
		if err := p.policy.Evaluate(ctx, e.SessionID); err != nil {
			// Non-fatal: log but don't fail the event
			slog.Warn("policy eval error", "err", err)
		}
	}

	return nil
}

// StartReconciler delegates to the session processor's background reconciler.
func (p *Processor) StartReconciler(ctx context.Context) {
	p.session.StartReconciler(ctx)
}
