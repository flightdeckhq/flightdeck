package processor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RedactedToolErrorMessage replaces a plugin tool failure's error text
// when the session's stored capture posture is off. The same
// placeholder the plugin uses when its own capture knobs are off, so a
// dashboard reader sees one marker either way.
const RedactedToolErrorMessage = "<redacted>"

// ToolErrorStrippingClientTypes are the client types whose tool error
// text the worker withholds on a session with capture off: every type
// the client type registry (contracts/client_types.json) marks
// strips_tool_error_text. They are hook-based or remote clients that
// cannot be relied on to withhold the text themselves; the sensor and
// the Agent SDK interceptor apply capture in the agent's own process.
// A parity test pins this list to the registry.
var ToolErrorStrippingClientTypes = []string{
	"claude_code", "codex", "copilot", "opencode", "gemini_cli", "cursor", "otlp",
}

// ToolErrorNeedsCaptureCheck reports whether the event carries a tool
// failure whose error.message is content: a tool_call or mcp_tool_call
// with an error block from one of ToolErrorStrippingClientTypes. Sensor
// llm_error / MCP error blocks are provider metadata and are not gated.
func ToolErrorNeedsCaptureCheck(e consumer.EventPayload) bool {
	if !slices.Contains(ToolErrorStrippingClientTypes, e.ClientType) || len(e.Error) == 0 {
		return false
	}
	return e.EventType == "tool_call" || e.EventType == "mcp_tool_call"
}

// StripToolErrorMessage replaces error.message in an already-marshaled
// extra blob with RedactedToolErrorMessage, keeping error_type,
// error_class, interrupted and every other key. Returns the input
// unchanged when there is no error object or no message, or when the
// blob cannot be parsed (the caller's event_content gate is the
// fail-closed side for content proper).
func StripToolErrorMessage(extra []byte) []byte {
	if len(extra) == 0 {
		return extra
	}
	var m map[string]interface{}
	if err := json.Unmarshal(extra, &m); err != nil {
		return extra
	}
	errObj, ok := m["error"].(map[string]interface{})
	if !ok {
		return extra
	}
	if _, has := errObj["message"]; !has {
		return extra
	}
	errObj["message"] = RedactedToolErrorMessage
	m["error"] = errObj
	out, err := json.Marshal(m)
	if err != nil {
		return extra
	}
	return out
}

// stripExtraContent removes the inline "content" key (the MCP
// argument/result/resource projection that BuildEventExtra places in
// events.payload) from an already-marshaled extra blob. It is the
// capture-posture guard for the inline content sink: called only when
// the session's stored capture posture is off. Returns nil when the
// blob becomes empty so the payload column stays NULL, and returns the
// input unchanged if it cannot be parsed (fail-closed is handled by the
// caller's separate event_content gate).
func stripExtraContent(extra []byte) []byte {
	if len(extra) == 0 {
		return extra
	}
	var m map[string]interface{}
	if err := json.Unmarshal(extra, &m); err != nil {
		return extra
	}
	if _, ok := m["content"]; !ok {
		return extra
	}
	delete(m, "content")
	if len(m) == 0 {
		return nil
	}
	out, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return out
}

// BuildEventExtra projects per-event-type metadata fields from a NATS
// payload into the events.payload JSONB column. Returns nil for events
// that carry no extra metadata to persist (a plain session_start or
// post_call) and otherwise a JSON-encoded map of the fields present:
// directive_name / directive_action / directive_status / result /
// error / duration_ms on directive_result, the policy, MCP, sub-agent
// and enrichment fields on their event types, and the Claude Code
// plugin's tool_use_id / mcp_server / end_reason -- omitting any field
// that is empty/nil.
//
// This is an exported helper so it can be unit-tested directly without
// needing to wire a mock writer through the Processor.
func BuildEventExtra(e consumer.EventPayload) ([]byte, error) {
	// This function produces payload for any event that
	// carries structured extras -- llm_error events populate
	// ``error`` with the error taxonomy object, streaming post_call
	// events populate ``streaming`` with TTFT + chunk stats. The
	// per-field guards below skip any field the event doesn't carry,
	// so non-directive events that also have no structured extras
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
		// ``Error`` is json.RawMessage to carry either the
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
	// Claude Code's tool_use_id, sent by the plugin on tool_call and
	// mcp_tool_call so an event maps back to the exact tool invocation
	// in the transcript. Sensor events never carry it.
	if e.ToolUseID != "" {
		extra["tool_use_id"] = e.ToolUseID
	}
	// MCP server identity as Claude Code reports it ({name, source}),
	// decoded and re-attached so the stored payload is one document.
	// Only an object is projected: ingestion rejects any other shape,
	// and a direct publisher on the bus gets the same treatment here.
	if len(e.MCPServer) > 0 {
		var v map[string]interface{}
		if err := json.Unmarshal(e.MCPServer, &v); err == nil && v != nil {
			extra["mcp_server"] = v
		}
	}
	if len(e.Streaming) > 0 {
		// Streaming sub-object. Same shape handling as Error
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
	// Operator-actionable enrichment.
	// Project policy_decision (shared block on the 5 policy event
	// types) + originating_event_id (chain) + originating_call_context
	// (MCP-policy events) through to events.payload unchanged. Always
	// included when present; capture_prompts does not gate state
	// metadata.
	if len(e.PolicyDecision) > 0 {
		var v interface{}
		if err := json.Unmarshal(e.PolicyDecision, &v); err == nil {
			extra["policy_decision"] = v
		}
	}
	if e.OriginatingEventID != "" {
		extra["originating_event_id"] = e.OriginatingEventID
	}
	if e.OriginatingCallContext != "" {
		extra["originating_call_context"] = e.OriginatingCallContext
	}
	// MCP discovery item_names. Always
	// project (possibly empty []) on the three list event types
	// so the dashboard's drift-detection workflow can compare
	// inventories week-over-week without a separate query.
	if e.ItemNames != nil {
		extra["item_names"] = e.ItemNames
	}
	if e.Truncated {
		extra["truncated"] = true
	}
	// Session lifecycle + MCP server attach
	// enrichment passthrough. Always project when present.
	if e.SensorVersion != "" {
		extra["sensor_version"] = e.SensorVersion
	}
	if len(e.InterceptorVersions) > 0 {
		extra["interceptor_versions"] = e.InterceptorVersions
	}
	if len(e.PolicySnapshot) > 0 {
		extra["policy_snapshot"] = e.PolicySnapshot
	}
	if e.CloseReason != "" {
		extra["close_reason"] = e.CloseReason
	}
	// Claude Code's own exit reason (clear, resume, logout,
	// prompt_input_exit, other) next to the coarse close_reason enum.
	if e.EndReason != "" {
		extra["end_reason"] = e.EndReason
	}
	if len(e.PolicyActionsSummary) > 0 {
		extra["policy_actions_summary"] = e.PolicyActionsSummary
	}
	if e.LastEventID != "" {
		extra["last_event_id"] = e.LastEventID
	}
	if len(e.PolicyDecisionAtAttach) > 0 {
		var v interface{}
		if err := json.Unmarshal(e.PolicyDecisionAtAttach, &v); err == nil {
			extra["policy_decision_at_attach"] = v
		}
	}
	if len(e.PolicyEntriesOrphaned) > 0 {
		extra["policy_entries_orphaned"] = e.PolicyEntriesOrphaned
	}
	// LLM family enrichment passthrough (pre_call / post_call /
	// embeddings / llm_error).
	if e.EstimatedVia != "" {
		extra["estimated_via"] = e.EstimatedVia
	}
	if len(e.ProviderMetadata) > 0 {
		extra["provider_metadata"] = e.ProviderMetadata
	}
	// Token and cost fields that are not events columns (the columns
	// are written by InsertEvent from the same payload).
	if e.TokensCacheCreation1h != nil {
		extra["tokens_cache_creation_1h"] = *e.TokensCacheCreation1h
	}
	if e.ServiceTier != "" {
		extra["service_tier"] = e.ServiceTier
	}
	if e.Speed != "" {
		extra["speed"] = e.Speed
	}
	if e.InferenceGeo != "" {
		extra["inference_geo"] = e.InferenceGeo
	}
	if e.InferenceScope != "" {
		extra["inference_scope"] = e.InferenceScope
	}
	if len(e.ServerToolUse) > 0 {
		extra["server_tool_use"] = e.ServerToolUse
	}
	if e.StopReason != "" {
		extra["stop_reason"] = e.StopReason
	}
	if len(e.PolicyDecisionPre) > 0 {
		var v interface{}
		if err := json.Unmarshal(e.PolicyDecisionPre, &v); err == nil {
			extra["policy_decision_pre"] = v
		}
	}
	if len(e.PolicyDecisionPost) > 0 {
		var v interface{}
		if err := json.Unmarshal(e.PolicyDecisionPost, &v); err == nil {
			extra["policy_decision_post"] = v
		}
	}
	if len(e.OutputDimensions) > 0 {
		extra["output_dimensions"] = e.OutputDimensions
	}
	if e.RetryAttempt != nil {
		extra["retry_attempt"] = *e.RetryAttempt
	}
	if e.Terminal != nil {
		extra["terminal"] = *e.Terminal
	}
	// MCP fields. Project unconditionally when the sensor sent
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
	// MCP Protection Policy event fields. Projects onto
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
	// mcp_policy_user_remembered field (the others overlap
	// with the policy_mcp_warn / policy_mcp_block / name_changed
	// events handled above).
	if e.DecidedAt != "" {
		extra["decided_at"] = e.DecidedAt
	}
	if e.PermissionMode != "" {
		extra["permission_mode"] = e.PermissionMode
	}
	// Ingestion bounds signal_data only on session_signal, so another
	// event type's copy is not stored.
	if e.EventType == "session_signal" {
		if e.Signal != "" {
			extra["signal"] = e.Signal
		}
		if len(e.SignalData) > 0 && string(e.SignalData) != "null" {
			extra["signal_data"] = e.SignalData
		}
	}
	// MCP_RESOURCE_READ content. The sensor's lean MCP payload
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

	// Sub-agent observability fields. Project per-event when
	// present so the dashboard reads them from events.payload (same
	// inline-render path the MCP family uses). The wider sub-agent
	// linkage (parent_session_id, agent_role) lands in the sessions
	// table via UpsertSession; persisting them into events.payload
	// too lets the live-feed envelope and the per-event drilldown
	// surface the relationship without a sessions-table join. Small
	// bodies route inline here; the 8 KiB
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
// shape BuildEventExtra writes into events.payload (Rule 20 keeps
// the body verbatim). Two shapes land here:
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

// isMCPEventType reports whether ``eventType`` is one of the six
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
	// clearSequences is the database touch point of StreamReady; nil
	// means the writer's own, and tests substitute a scripted one.
	clearSequences func(ctx context.Context, lastSeq uint64) (int64, error)
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

// StreamReady runs once the consumer has the FLIGHTDECK stream: stored
// session sequences above the stream's last sequence cannot have come
// from this incarnation of the stream and are forgotten, so the
// ordering rules stand down for those rows instead of misreading every
// new event as older.
func (p *Processor) StreamReady(ctx context.Context, lastSeq uint64) error {
	cleared, err := p.forgetSequencesAbove(ctx, lastSeq)
	if err != nil {
		return err
	}
	if cleared > 0 {
		slog.Warn("forgot session sequences from a previous stream incarnation",
			"rows", cleared, "stream_last_seq", lastSeq)
	}
	return nil
}

func (p *Processor) forgetSequencesAbove(ctx context.Context, lastSeq uint64) (int64, error) {
	if p.clearSequences != nil {
		return p.clearSequences(ctx, lastSeq)
	}
	return p.w.ClearSequencesAbove(ctx, lastSeq)
}

// afterSessionEnd releases the per-session policy-evaluator state once
// a session_end has closed the session, so the cache and fired-directive
// maps stay bounded. A session_end that closed nothing (a duplicate, or
// one superseded by a re-attachment) leaves the live session's state
// alone: forgetting it would let its once-only directives fire again.
func (p *Processor) afterSessionEnd(sessionID string, closed bool) {
	if closed {
		p.policy.ForgetSession(sessionID)
	}
}

// Process handles a single event from NATS.
func (p *Processor) Process(ctx context.Context, e consumer.EventPayload) error {
	// Canonical model id, provider and billing defaults first, so the
	// session's model and the stored event agree.
	normalizeModelFields(&e)
	// An event whose client-supplied id is already stored is a copy of
	// one the worker has processed: a re-sent model call (the plugin
	// re-reads a transcript after a reboot cleared its sent-markers), a
	// retried POST or a NATS redelivery. Drop it before
	// any side effect, so its tokens are not added twice and its session
	// is not touched.
	if e.ID != "" {
		dup, err := p.w.EventExists(ctx, e.ID)
		if err != nil {
			return err
		}
		if dup {
			metrics.IncrDropped(metrics.ReasonDuplicateEvent)
			slog.Debug("dropping duplicate event", "event_id", e.ID, "event_type", e.EventType, "session_id", e.SessionID)
			return nil
		}
	}
	// Route to the correct session handler
	switch e.EventType {
	case "session_start":
		if err := p.session.HandleSessionStart(ctx, e); err != nil {
			return err
		}
	case "session_end":
		closed, err := p.session.HandleSessionEnd(ctx, e)
		if err != nil {
			if errors.Is(err, ErrEventDropped) {
				// The handler discarded the event (orphan
				// session_end): nothing to insert, and the
				// consumer ACKs on a nil return.
				return nil
			}
			// Includes consumer.ErrRetryLater, which the consumer
			// turns into a delayed redelivery.
			return err
		}
		p.afterSessionEnd(e.SessionID, closed)
	case "heartbeat":
		if err := p.session.HandleHeartbeat(ctx, e); err != nil {
			return err
		}
	case "post_call", "pre_call", "tool_call":
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "embeddings":
		// Embeddings are a post_call-shaped event
		// with no completion tokens; the ingestion layer validated
		// the schema so we route through the same last-seen + tokens
		// update path. Policy does not evaluate (separate budget
		// surface if ever added).
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "llm_error":
		// Structured LLM API error. Route through
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
	case "session_signal":
		// A session change that is not a call (compaction, model
		// switch): it advances last_seen_at and changes no token
		// count; a model_switched signal's model becomes the
		// session's model.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "policy_warn", "policy_degrade", "policy_block",
		"policy_mcp_warn", "policy_mcp_block",
		"mcp_policy_user_remembered":
		// Policy enforcement events emitted by the sensor's _pre_call
		// (WARN, BLOCK) and _apply_directive(DEGRADE). Route through
		// HandlePostCall so last_seen_at advances on enforcement
		// activity. Policy is NOT re-evaluated — these events ARE the
		// evaluation outcome; the worker would otherwise emit a
		// duplicate directive.
		//
		// policy_mcp_warn / policy_mcp_block ride the
		// same routing — they're the MCP Protection Policy's
		// equivalent of the LLM-budget enforcement events. The lean
		// payload (server_url / server_name / fingerprint / tool_name
		// / policy_id / scope / decision_path) lands directly in
		// events.payload; no token / model fields fire HandlePostCall's
		// budget-evaluation path because they're nil on the wire.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "mcp_server_attached":
		// UPSERT sessions.context.mcp_servers
		// from the event payload so the dashboard's SessionDrawer
		// panel populates live (within ~2-3 s of attach) for
		// in-flight sessions. HandlePostCall advances last_seen_at;
		// the AppendMCPServerToContext call writes the per-server
		// dict atomically with idempotent (name, server_url) dedup.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
		if err := p.session.HandleMCPServerAttached(ctx, e); err != nil {
			return err
		}
	case "mcp_tool_list", "mcp_tool_call",
		"mcp_resource_list", "mcp_resource_read",
		"mcp_prompt_list", "mcp_prompt_get",
		"mcp_server_name_changed":
		// MCP events. Route through HandlePostCall: the lean
		// MCP payload carries no token deltas (TokensTotal
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
		slog.Warn("event timestamp not RFC3339; using receive time",
			"event_type", e.EventType, "raw_timestamp", e.Timestamp)
		ts = time.Now().UTC()
	}
	extra, extraErr := BuildEventExtra(e)
	if extraErr != nil {
		// Non-fatal: log and proceed without payload metadata.
		slog.Warn("build event extra error", "err", extraErr, "event_type", e.EventType)
	}
	// Server-authoritative capture gate. Prompt/MCP content may be
	// persisted only when the session's stored capture posture permits
	// it -- never on the per-event HasContent flag, which an attacker
	// on the message bus can forge. This covers BOTH content sinks:
	// the event_content table (below) and the MCP inline projection
	// that BuildEventExtra places in extra["content"]. Look the flag up
	// only for content-bearing events; drop content fail-safe when
	// capture is off or the session's posture is not yet known.
	captureOn := true
	if e.HasContent || len(e.Content) > 0 || ToolErrorNeedsCaptureCheck(e) {
		captureOn = p.w.SessionCaptureEnabled(ctx, e.SessionID)
		if !captureOn {
			extra = stripExtraContent(extra)
			// A hook-based client's tool error text is content too (a
			// command's stderr, an Edit failure quoting its
			// old_string); the Claude Code plugin withholds it when its
			// own capture knobs are off, and the stored posture is
			// enforced here so a forged per-event flag cannot smuggle
			// it in.
			if ToolErrorNeedsCaptureCheck(e) {
				extra = StripToolErrorMessage(extra)
			}
		}
	}
	// Worker-side enrichment for session_end (policy_actions_summary +
	// last_event_id), computed here because the data lives in tables
	// the sensor can't query efficiently. Best-effort; failures log +
	// drop the enrichment rather than block event ingestion.
	if e.EventType == "session_end" {
		extra = p.enrichSessionEnd(ctx, e, extra)
	}
	// Pass the sensor-minted event id (from
	// payload.id) into InsertEvent. Empty string → DB-side
	// gen_random_uuid() fallback via COALESCE.
	// Keep the persisted has_content flag consistent with the capture
	// gate: if content is not permitted for this session, the event row
	// must not advertise content the /content endpoint can never serve.
	hasContent := e.HasContent && captureOn
	row := eventRow(e, ts, extra)
	insert := func(hasContent bool) (string, error) {
		row.HasContent = hasContent
		return p.w.InsertEvent(ctx, row)
	}
	var eventID string
	// Store prompt content only when the session's server-authoritative
	// capture posture permits it (captureOn), not merely when the event
	// claims has_content. This is the core capture-posture contract.
	// The event and its content go in one transaction, so the event is
	// never visible claiming content the /content endpoint cannot serve
	// yet. Content that can never be stored (it does not parse, or
	// Postgres rejects it as invalid data) is dropped and the event is
	// stored without it, with has_content false, rather than retried
	// into the same failure; any other error is returned, so the event
	// is redelivered and retried whole. An event that claims content but
	// carries none is stored with has_content false: there is nothing
	// for /content to serve.
	// A JSON null content field carries no content.
	contentBlob := len(e.Content) > 0 && string(e.Content) != "null"
	if hasContent && contentBlob {
		row.HasContent = hasContent
		eventID, err = p.w.InsertEventWithContent(ctx, row, e.Content)
		if errors.Is(err, writer.ErrEventContent) {
			slog.Warn("event content could not be stored; storing the event without it",
				"err", err, "event_type", e.EventType, "session_id", e.SessionID)
			eventID, err = insert(false)
		}
	} else {
		eventID, err = insert(false)
	}
	if err != nil {
		return err
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

// StartReconciler delegates to the session processor's background
// reconciler. interval is the tick period and orphanTimeout controls
// the lost → closed transition (see SessionProcessor.StartReconciler).
func (p *Processor) StartReconciler(ctx context.Context, interval, orphanTimeout time.Duration) {
	p.session.StartReconciler(ctx, interval, orphanTimeout)
}

// Worker-side enrichment for session_end +
// mcp_server_name_changed. Both helpers run after BuildEventExtra
// produces the base extra blob and before InsertEvent persists.
// Failures log + return the unmodified extra rather than block
// ingestion — operator-actionable enrichment is best-effort.

// enrichSessionEnd adds policy_actions_summary + last_event_id to
// the session_end event's payload. policy_actions_summary counts
// every policy enforcement event the worker has seen for this
// session; last_event_id is the immediately-prior event's UUID for
// the dashboard's incident-triage time-skip affordance.
func (p *Processor) enrichSessionEnd(
	ctx context.Context, e consumer.EventPayload, extra []byte,
) []byte {
	merged := map[string]interface{}{}
	if len(extra) > 0 {
		if err := json.Unmarshal(extra, &merged); err != nil {
			slog.Warn("enrichSessionEnd: parse extra error",
				"err", err, "session_id", e.SessionID)
			return extra
		}
	}
	// policy_actions_summary — GROUP BY against the events table.
	rows, err := p.pool.Query(ctx, `
		SELECT event_type, count(*)
		FROM events
		WHERE session_id = $1::uuid AND event_type IN (
			'policy_warn', 'policy_degrade', 'policy_block',
			'policy_mcp_warn', 'policy_mcp_block'
		)
		GROUP BY 1
	`, e.SessionID)
	if err == nil {
		summary := map[string]int{}
		for rows.Next() {
			var et string
			var n int
			if scanErr := rows.Scan(&et, &n); scanErr == nil {
				summary[et] = n
			}
		}
		rows.Close()
		if len(summary) > 0 {
			merged["policy_actions_summary"] = summary
		}
	} else {
		slog.Warn("enrichSessionEnd: policy_actions_summary query error",
			"err", err, "session_id", e.SessionID)
	}
	// last_event_id — the immediately-prior event's UUID for the
	// dashboard's "what fired right before close" triage chip.
	var lastID string
	err = p.pool.QueryRow(ctx, `
		SELECT id::text FROM events
		WHERE session_id = $1::uuid
		ORDER BY occurred_at DESC LIMIT 1
	`, e.SessionID).Scan(&lastID)
	if err == nil && lastID != "" {
		merged["last_event_id"] = lastID
	}
	out, err := json.Marshal(merged)
	if err != nil {
		slog.Warn("enrichSessionEnd: re-marshal error",
			"err", err, "session_id", e.SessionID)
		return extra
	}
	return out
}

// eventRow maps an event payload onto the events row the writer
// inserts, with extra as its encoded payload column. HasContent is left
// for the caller, which decides it from the session's capture posture.
func eventRow(e consumer.EventPayload, occurredAt time.Time, extra []byte) writer.EventRow {
	return writer.EventRow{
		SensorEventID:       e.ID,
		SessionID:           e.SessionID,
		Flavor:              e.Flavor,
		EventType:           e.EventType,
		Model:               e.Model,
		TokensInput:         e.TokensInput,
		TokensOutput:        e.TokensOutput,
		TokensTotal:         e.TokensTotal,
		TokensCacheRead:     e.TokensCacheRead,
		TokensCacheCreation: e.TokensCacheCreation,
		TokensReasoning:     e.TokensReasoning,
		ModelRequested:      e.ModelRequested,
		ModelServed:         e.ModelServed,
		Provider:            e.Provider,
		BillingMode:         e.BillingMode,
		Platform:            platformOf(e),
		CostReported:        e.CostReported,
		CostSource:          e.CostSource,
		LatencyMs:           e.LatencyMs,
		ToolName:            e.ToolName,
		OccurredAt:          occurredAt,
		Payload:             extra,
	}
}

// platformOf returns the endpoint that served an LLM call, as the
// client reported it in provider_metadata.platform, or "" when it sent
// none. The events.platform column carries it so the cost query does
// not read JSON per row.
func platformOf(e consumer.EventPayload) string {
	platform, _ := e.ProviderMetadata["platform"].(string)
	return platform
}
