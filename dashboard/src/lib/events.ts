import { formatCost } from "./agents-format";
import type { AgentEvent, EventPayloadFields, ServerToolUse } from "./types";

/* ---- Directive activity color helper ---- */

/**
 * Resolve a CSS color variable for a directive activity entry.
 *
 * Used by the FleetPanel DIRECTIVE ACTIVITY sidebar and any other
 * surface that needs to color-code directive events. Single source
 * of truth for the directive color mapping -- do not inline these
 * colors anywhere else.
 *
 * - directive_result success/acknowledged → green
 * - directive_result error/timeout → red
 * - directive (sent, no result yet) → purple
 */
export function getDirectiveResultColor(
  eventType: string,
  status: string | undefined,
): string {
  if (eventType === "directive_result") {
    if (status === "success" || status === "acknowledged") {
      return "var(--status-active)";
    }
    if (status === "error" || status === "timeout") {
      return "var(--status-lost)";
    }
    return "var(--event-result)";
  }
  // event_type === "directive" or anything else falls back to purple
  return "var(--event-directive)";
}

/**
 * Build the inline status badge text+color for a directive activity row.
 * Returns null when the event is a sent directive (no badge), or when
 * the status is unknown.
 */
export function getDirectiveBadge(
  payload: EventPayloadFields | undefined,
): { label: string; color: string } | null {
  const status = payload?.directive_status;
  if (!status) return null;
  if (status === "success") return { label: "✓ success", color: "var(--status-active)" };
  if (status === "acknowledged") return { label: "✓ acknowledged", color: "var(--status-active)" };
  if (status === "error") return { label: "✗ error", color: "var(--status-lost)" };
  if (status === "timeout") return { label: "✗ timeout", color: "var(--status-lost)" };
  return null;
}

/* ---- Event type badge config ---- */

export interface BadgeConfig {
  cssVar: string;
  label: string;
  /**
   * MCP badge variants. ``filled`` defaults to ``true`` (solid
   * fill, the existing single-style behaviour for every non-MCP
   * event type). The list-style MCP badges set ``filled: false`` to
   * render as outline-only — operators distinguish "the agent
   * discovered N MCP tools" (outline) from "the agent invoked an MCP
   * tool" (solid) at a glance.
   */
  filled?: boolean;
}

export const eventBadgeConfig: Record<string, BadgeConfig> = {
  post_call: { cssVar: "var(--event-llm)", label: "LLM CALL" },
  pre_call: { cssVar: "var(--event-llm)", label: "PRE CALL" },
  tool_call: { cssVar: "var(--event-tool)", label: "TOOL" },
  policy_warn: { cssVar: "var(--event-warn)", label: "WARN" },
  policy_block: { cssVar: "var(--event-block)", label: "BLOCK" },
  policy_degrade: { cssVar: "var(--event-degrade)", label: "DEGRADE" },
  directive: { cssVar: "var(--event-directive)", label: "DIRECTIVE" },
  directive_result: { cssVar: "var(--event-result)", label: "RESULT" },
  session_start: { cssVar: "var(--event-lifecycle)", label: "START" },
  session_end: { cssVar: "var(--event-lifecycle)", label: "END" },
  // EMBED uses the cyan RAG family;
  // ERROR uses the danger red so it reads as alarming without being
  // confused with a policy BLOCK (which is also red but stylistically
  // distinct via its badge family).
  embeddings: { cssVar: "var(--event-embeddings)", label: "EMBED" },
  llm_error: { cssVar: "var(--event-error)", label: "ERROR" },
  // MCP observability. Verb-based labels distinguish
  // "agent invoked" vs "agent discovered" at a glance — the
  // singular/plural-only pairs we considered (MCP TOOL / MCP TOOLS)
  // put a single 's' between two fundamentally different operations.
  // Verbs (CALL / READ / FETCHED / DISCOVERED) carry the
  // operation distinction.
  //
  // The "MCP " prefix is kept on every label. Rationale: the Fleet live
  // feed table renders badges in a tabular row WITHOUT hexagons
  // (hexagon clip-paths are swimlane-only), right next to the
  // non-MCP TOOL badge. In that context "TOOL CALL" vs "TOOL" is
  // verb-tense disambiguation, not category disambiguation, and
  // operators new to Flightdeck shouldn't have to learn the verb
  // convention to read category off the label. The prefix puts
  // category back in the label where shape would carry it in the
  // swimlane. The EventType enum strings (mcp_tool_call etc.) are
  // unchanged; this is display text only.
  //
  // Three colour families × two variants (filled = invoked, outline
  // = discovered):
  //   tool family       cyan    Wrench / ListChecks
  //   resource family   green   FileText / Folder
  //   prompt family     purple  MessageSquare / List
  mcp_tool_call: {
    cssVar: "var(--event-mcp-tool)",
    label: "MCP TOOL CALL",
  },
  mcp_tool_list: {
    cssVar: "var(--event-mcp-tool)",
    label: "MCP TOOLS DISCOVERED",
    filled: false,
  },
  mcp_resource_read: {
    cssVar: "var(--event-mcp-resource)",
    label: "MCP RESOURCE READ",
  },
  mcp_resource_list: {
    cssVar: "var(--event-mcp-resource)",
    label: "MCP RESOURCES DISCOVERED",
    filled: false,
  },
  mcp_prompt_get: {
    cssVar: "var(--event-mcp-prompt)",
    label: "MCP PROMPT FETCHED",
  },
  mcp_prompt_list: {
    cssVar: "var(--event-mcp-prompt)",
    label: "MCP PROMPTS DISCOVERED",
    filled: false,
  },
  // MCP Protection Policy events. The chroma map is locked in
  // ARCHITECTURE.md →
  // "Adjacent surfaces": amber/red carry the enforcement axis (warn
  // and block — same chromas as policy_warn / policy_block) and
  // purple-info carries the FYI axis (name drift and the plugin's
  // user-remembered decision — same chroma as directive_result).
  // Rule 15 lock: no new theme tokens, every CSS variable below is
  // already declared in themes.css.
  policy_mcp_warn: {
    cssVar: "var(--event-warn)",
    label: "MCP POLICY WARN",
  },
  policy_mcp_block: {
    cssVar: "var(--event-block)",
    label: "MCP POLICY BLOCK",
  },
  mcp_server_name_changed: {
    cssVar: "var(--event-result)",
    label: "MCP NAME CHANGED",
  },
  mcp_policy_user_remembered: {
    cssVar: "var(--event-result)",
    label: "MCP SERVER APPROVED",
  },
  // MCP server attached events ride the same FYI
  // chroma family as name-changed and user-remembered (info-purple
  // via --event-result) — they're informational, not enforcement,
  // and operators reading the timeline want them to read as the
  // same axis at a glance. Without an entry the type falls through
  // to the grey defaultBadge.
  mcp_server_attached: {
    cssVar: "var(--event-result)",
    label: "MCP SERVER ATTACHED",
  },
  // A change in the session (compaction, model switch) rides the run
  // lifecycle chroma; the feed line names the signal.
  session_signal: {
    cssVar: "var(--event-lifecycle)",
    label: "SIGNAL",
  },
};

export const defaultBadge: BadgeConfig = { cssVar: "var(--event-lifecycle)", label: "EVENT" };

/**
 * Badge for a session_start event whose timestamp lines up with an
 * entry in the session's attachments array. Amber, distinct
 * from the default lifecycle blue, not alarming. Used by the drawer
 * EventFeed and surfaced as the swimlane circle colour via EventNode's
 * isAttachment prop.
 *
 * Uses var(--warning), which is the actual amber token defined in
 * themes.css -- the earlier iteration pointed at var(--status-warn)
 * (no such token), so color-mix silently resolved to transparent and
 * the pill lost its background. --warning is #eab308 in neon dark
 * and #ca8a04 in clean light; both themes give enough contrast for a
 * 15% background tint against the drawer surface.
 */
export const attachBadge: BadgeConfig = {
  cssVar: "var(--warning)",
  label: "ATTACH",
};

export function getBadge(eventType: string): BadgeConfig {
  return eventBadgeConfig[eventType] ?? defaultBadge;
}

/**
 * Match window in milliseconds for deciding whether a session_start
 * event is an attachment. The ingestion API records the attachment
 * timestamp at NOW() when the HTTP request hits the attach store, and
 * the session_start event itself carries the sensor-side
 * `timestamp` field which is set before the request leaves the
 * sensor's process. Network latency + clock skew between the two
 * fits comfortably inside ±2 s.
 */
export const ATTACH_MATCH_WINDOW_MS = 2000;

/**
 * Decide whether `event` is a session_start that corresponds to a
 * recorded re-attachment in `attachments`.
 *
 * - Only session_start events are eligible; anything else returns
 *   false trivially.
 * - An event matches an attachment when |occurred_at - attached_at|
 *   ≤ ATTACH_MATCH_WINDOW_MS.
 * - The very first session_start (the original) has no matching
 *   attachment row and therefore returns false unchanged.
 *
 * Linear scan against `attachments` is fine -- sessions typically
 * have 0..10 attachments even for aggressive orchestrators.
 */
export function isAttachmentStartEvent(
  event: { event_type: string; occurred_at: string },
  attachments: string[] | undefined,
): boolean {
  if (event.event_type !== "session_start") return false;
  if (!attachments || attachments.length === 0) return false;
  const eventMs = new Date(event.occurred_at).getTime();
  if (Number.isNaN(eventMs)) return false;
  for (const att of attachments) {
    const attMs = new Date(att).getTime();
    if (Number.isNaN(attMs)) continue;
    if (Math.abs(attMs - eventMs) <= ATTACH_MATCH_WINDOW_MS) {
      return true;
    }
  }
  return false;
}

/* ---- Event detail text ---- */

export function getEventDetail(event: AgentEvent): string {
  switch (event.event_type) {
    case "post_call": {
      const parts = [event.model ?? "unknown"];
      // Streaming post_calls surface TTFT inline
      // ahead of the token + total-latency segments so an operator
      // scanning the timeline sees first-token latency on the same
      // row as the response. Non-streaming calls keep the original
      // ``model · tokens · latency`` shape unchanged.
      const stream = event.payload?.streaming;
      if (stream && stream.ttft_ms != null) {
        parts.push(`TTFT ${stream.ttft_ms.toLocaleString()}ms`);
      }
      if (event.tokens_total != null) parts.push(`${event.tokens_total.toLocaleString()} tok`);
      if (event.latency_ms != null) parts.push(`${event.latency_ms}ms`);
      // estimated_via chip: only surface when the estimator fell back
      // off tiktoken — operationally interesting for post-call delta
      // attribution. tiktoken paths stay quiet so the row isn't
      // cluttered.
      const via = event.payload?.estimated_via;
      if (via && via !== "tiktoken") parts.push(`est:${via}`);
      // policy_decision_post chip: surface when the cumulative usage
      // crossed a threshold this call.
      const pdp = event.payload?.policy_decision_post;
      if (pdp) parts.push(`policy:${pdp.decision}`);
      // Rate-limit pressure chip: <10% remaining tokens.
      const pm = event.payload?.provider_metadata;
      if (
        pm?.ratelimit_remaining_tokens != null &&
        pm?.ratelimit_limit_tokens != null &&
        pm.ratelimit_remaining_tokens / pm.ratelimit_limit_tokens < 0.1
      ) {
        parts.push(`rate-limit ${pm.ratelimit_remaining_tokens.toLocaleString()} left`);
      }
      return parts.join(" · ");
    }
    case "pre_call": {
      const parts = [event.model ?? "unknown"];
      const via = event.payload?.estimated_via;
      if (via && via !== "tiktoken") parts.push(`est:${via}`);
      const pdp = event.payload?.policy_decision_pre;
      if (pdp) parts.push(`policy:${pdp.decision}`);
      return parts.join(" · ");
    }
    case "embeddings": {
      const parts = [event.model ?? "unknown"];
      const dims = event.payload?.output_dimensions;
      if (dims) parts.push(`${dims.dimension}-d × ${dims.count} vec`);
      if (event.tokens_input != null) parts.push(`${event.tokens_input.toLocaleString()} tok in`);
      if (event.latency_ms != null) parts.push(`${event.latency_ms}ms`);
      const via = event.payload?.estimated_via;
      if (via && via !== "tiktoken") parts.push(`est:${via}`);
      return parts.join(" · ");
    }
    case "llm_error": {
      const err = event.payload?.error;
      const parts: string[] = [];
      if (err && typeof err !== "string") {
        parts.push(err.error_type);
        if (err.provider_error_code) parts.push(err.provider_error_code);
        else if (err.provider) parts.push(err.provider);
      } else {
        parts.push("llm error");
      }
      const attempt = event.payload?.retry_attempt;
      if (attempt != null && attempt > 1) parts.push(`attempt ${attempt}`);
      if (event.payload?.terminal) parts.push("terminal");
      return parts.join(" · ");
    }
    case "tool_call":
      return event.tool_name ?? "unknown tool";
    case "policy_warn": {
      const p = event.payload;
      if (p && p.threshold_pct != null && p.tokens_used != null && p.token_limit != null) {
        return `warn at ${p.threshold_pct}% · ${p.tokens_used.toLocaleString()} of ${p.token_limit.toLocaleString()} tokens`;
      }
      return "warned at threshold";
    }
    case "policy_block": {
      const p = event.payload;
      if (p && p.tokens_used != null && p.token_limit != null) {
        return `blocked at ${p.tokens_used.toLocaleString()} of ${p.token_limit.toLocaleString()} tokens`;
      }
      return "blocked at threshold";
    }
    case "policy_degrade": {
      const p = event.payload;
      if (p && p.from_model && p.to_model) {
        return `degraded from ${p.from_model} to ${p.to_model}`;
      }
      return "degraded model";
    }
    case "session_start":
      return "run started";
    case "session_end": {
      // close_reason chip — operator sees
      // why the session ended without opening the drawer.
      const reason = event.payload?.close_reason;
      if (reason && reason !== "normal_exit") {
        return `run ended · ${reason}`;
      }
      return "run ended";
    }
    case "mcp_server_name_changed": {
      // Without a case for this type rows would render as the
      // untyped fallback. The
      // drift-detection workflow needs to see the rename + the
      // orphaned-entries count inline so the operator can act on
      // it without opening the drawer.
      const p = event.payload as Record<string, unknown> | undefined;
      const oldName = (p?.name_old as string | undefined) ?? "?";
      const newName = (p?.name_new as string | undefined) ?? "?";
      const orphaned = p?.policy_entries_orphaned as
        | { count?: number }
        | undefined;
      const orphanCount = orphaned?.count ?? 0;
      const base = `name drift: ${oldName} → ${newName}`;
      return orphanCount > 0
        ? `${base} (${orphanCount} entries orphaned)`
        : base;
    }
    case "mcp_policy_user_remembered": {
      // ``<server> approved · <permission mode>``: the operator reading
      // the feed sees which server a user let through, and in which
      // Claude Code mode, without opening the drawer.
      const server = event.payload?.server_name ?? "MCP server";
      const mode = event.payload?.permission_mode;
      return mode ? `${server} approved · ${mode}` : `${server} approved`;
    }
    case "session_signal":
      return signalDetail(event.payload?.signal, event.payload?.signal_data);
    case "directive_result": {
      const name = event.payload?.directive_name;
      const status = event.payload?.directive_status;
      if (name && status) return `${name} · ${status}`;
      if (name) return name;
      if (status) return status;
      return "directive result";
    }
    case "mcp_tool_call": {
      // ``<server> · <tool> · <duration>``. The server is
      // useful enough at scan-time (multi-server agents are common)
      // that it earns the leading position; the tool name comes from
      // events.tool_name (top-level) for filter compatibility. The
      // arguments / result detail lives in <MCPEventDetails/>.
      const parts: string[] = [];
      if (event.payload?.server_name) parts.push(event.payload.server_name);
      if (event.tool_name) parts.push(event.tool_name);
      const dur = event.payload?.duration_ms;
      if (typeof dur === "number") parts.push(`${dur}ms`);
      if (parts.length === 0) return "mcp tool call";
      return parts.join(" · ");
    }
    case "mcp_resource_read": {
      const parts: string[] = [];
      if (event.payload?.server_name) parts.push(event.payload.server_name);
      if (event.payload?.resource_uri) parts.push(event.payload.resource_uri);
      const bytes = event.payload?.content_bytes;
      if (typeof bytes === "number") {
        parts.push(`${bytes.toLocaleString()} bytes`);
      }
      if (parts.length === 0) return "mcp resource read";
      return parts.join(" · ");
    }
    case "mcp_prompt_get": {
      const parts: string[] = [];
      if (event.payload?.server_name) parts.push(event.payload.server_name);
      if (event.payload?.prompt_name) parts.push(event.payload.prompt_name);
      const dur = event.payload?.duration_ms;
      if (typeof dur === "number") parts.push(`${dur}ms`);
      if (parts.length === 0) return "mcp prompt get";
      return parts.join(" · ");
    }
    case "mcp_tool_list":
    case "mcp_resource_list":
    case "mcp_prompt_list": {
      const parts: string[] = [];
      if (event.payload?.server_name) parts.push(event.payload.server_name);
      const count = event.payload?.count;
      if (typeof count === "number") parts.push(`${count} discovered`);
      if (parts.length === 0) {
        return event.event_type === "mcp_tool_list"
          ? "mcp tool list"
          : event.event_type === "mcp_resource_list"
            ? "mcp resource list"
            : "mcp prompt list";
      }
      return parts.join(" · ");
    }
    default:
      return event.event_type;
  }
}

/* ---- Event summary rows for expanded detail ---- */

const BILLING_MODE_LABEL: Record<string, string> = {
  metered: "Metered",
  subscription: "Subscription",
  local: "Local",
};

const COST_SOURCE_LABEL: Record<string, string> = {
  provider: "reported by the provider",
  agent: "computed by the client",
};

/** Server-side tool counters as `2 web searches · 1 code execution`. */
function formatServerToolUse(use: ServerToolUse): string | null {
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string) => {
    if (n && n > 0) parts.push(`${n.toLocaleString()} ${n === 1 ? one : many}`);
  };
  add(use.web_search_requests, "web search", "web searches");
  add(use.web_fetch_requests, "web fetch", "web fetches");
  add(use.code_execution_requests, "code execution", "code executions");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The generation detail of one LLM call: cache reads and writes,
 *  reasoning tokens, stop reason and server tool counts. A row appears
 *  only when the client reported the field with a value above zero. */
function generationRows(event: AgentEvent): [string, string][] {
  const p = event.payload;
  const rows: [string, string][] = [];
  if (event.tokens_cache_read) {
    rows.push(["Cache read", event.tokens_cache_read.toLocaleString()]);
  }
  if (event.tokens_cache_creation) {
    const oneHour = p?.tokens_cache_creation_1h;
    rows.push([
      "Cache write",
      oneHour
        ? `${event.tokens_cache_creation.toLocaleString()} · ${oneHour.toLocaleString()} for 1h`
        : event.tokens_cache_creation.toLocaleString(),
    ]);
  }
  if (event.tokens_reasoning) {
    rows.push(["Reasoning tokens", event.tokens_reasoning.toLocaleString()]);
  }
  if (p?.stop_reason) rows.push(["Stop reason", p.stop_reason]);
  const serverTools = p?.server_tool_use ? formatServerToolUse(p.server_tool_use) : null;
  if (serverTools) rows.push(["Server tools", serverTools]);
  return rows;
}

/** The serving, billing and cost detail of an LLM call or an
 *  embeddings call. A row appears only when the client reported the
 *  field, so a call from a client that reports none of them keeps the
 *  base rows alone. */
function servingRows(event: AgentEvent): [string, string][] {
  const p = event.payload;
  const rows: [string, string][] = [];
  // The verbatim ids, each only when it differs from the Model row.
  // `model` is the canonical form of the served id (else the requested
  // one), so the requested id shows when the request named an alias or
  // a gateway-prefixed id, and the served id shows only when
  // canonicalising changed it (a cloud prefix or version suffix).
  if (event.model_requested && event.model_requested !== event.model) {
    rows.push(["Model requested", event.model_requested]);
  }
  if (event.model_served && event.model_served !== event.model) {
    rows.push(["Model served", event.model_served]);
  }
  if (event.billing_mode) {
    rows.push(["Billing", BILLING_MODE_LABEL[event.billing_mode] ?? event.billing_mode]);
  }
  if (event.platform) rows.push(["Platform", event.platform]);
  if (p?.service_tier) rows.push(["Service tier", p.service_tier]);
  if (p?.speed) rows.push(["Speed", p.speed]);
  if (p?.effort) rows.push(["Effort", p.effort]);
  if (p?.inference_geo) rows.push(["Inference geo", p.inference_geo]);
  if (p?.inference_scope) rows.push(["Inference scope", p.inference_scope]);
  if (event.cost_reported != null) {
    const source = event.cost_source
      ? ` · ${COST_SOURCE_LABEL[event.cost_source] ?? event.cost_source}`
      : "";
    rows.push(["Reported cost", `${formatCost(event.cost_reported)}${source}`]);
  }
  return rows;
}

export function getSummaryRows(event: AgentEvent): [string, string][] {
  switch (event.event_type) {
    case "post_call": {
      const rows: [string, string][] = [
        ["Model", event.model ?? "unknown"],
        ["Tokens input", event.tokens_input?.toLocaleString() ?? "—"],
        ["Tokens output", event.tokens_output?.toLocaleString() ?? "—"],
        ["Total tokens", event.tokens_total?.toLocaleString() ?? "—"],
        ["Latency", event.latency_ms != null ? `${event.latency_ms.toLocaleString()}ms` : "—"],
        ...generationRows(event),
        ...servingRows(event),
      ];
      // Surface the streaming sub-object inline so
      // the expanded row shows everything the sensor recorded
      // without a separate PromptViewer round-trip.
      const stream = event.payload?.streaming;
      if (stream) {
        if (stream.ttft_ms != null) {
          rows.push(["TTFT", `${stream.ttft_ms.toLocaleString()}ms`]);
        }
        rows.push(["Chunks", stream.chunk_count.toLocaleString()]);
        if (stream.inter_chunk_ms) {
          const ic = stream.inter_chunk_ms;
          rows.push([
            "Inter-chunk",
            `p50 ${ic.p50}ms · p95 ${ic.p95}ms · max ${ic.max}ms`,
          ]);
        }
        rows.push([
          "Stream outcome",
          stream.final_outcome === "aborted" && stream.abort_reason
            ? `aborted · ${stream.abort_reason}`
            : stream.final_outcome,
        ]);
      }
      return rows;
    }
    case "pre_call":
      return [["Model", event.model ?? "unknown"]];
    case "tool_call":
      return [["Tool", event.tool_name ?? "unknown"]];
    case "policy_warn":
    case "policy_block":
    case "policy_degrade": {
      // Lay out the common (source, threshold, tokens) shape plus the
      // type-specific extras (from/to model on degrade,
      // intended_model on block) so the operator sees the full
      // enforcement decision in the expanded row. The detailed
      // accordion (request-style metadata) lives in
      // <PolicyEventDetails/> so this list stays scannable.
      const p = event.payload;
      const rows: [string, string][] = [
        ["Type", event.event_type.replace("policy_", "")],
      ];
      if (p?.source) rows.push(["Source", p.source]);
      if (p?.threshold_pct != null) {
        rows.push(["Threshold", `${p.threshold_pct}%`]);
      }
      if (p?.tokens_used != null) {
        rows.push(["Tokens used", p.tokens_used.toLocaleString()]);
      }
      if (p?.token_limit != null) {
        rows.push(["Token limit", p.token_limit.toLocaleString()]);
      }
      if (event.event_type === "policy_degrade") {
        if (p?.from_model) rows.push(["From model", p.from_model]);
        if (p?.to_model) rows.push(["To model", p.to_model]);
      }
      if (event.event_type === "policy_block" && p?.intended_model) {
        rows.push(["Intended model", p.intended_model]);
      }
      return rows;
    }
    case "session_start":
      return [["Event", "run started"]];
    case "session_end":
      return [["Event", "run ended"]];
    case "mcp_server_name_changed": {
      // Drawer view for the name-drift
      // event. Worker enriches policy_entries_orphaned when any
      // mcp_policy_entries row matched the OLD fingerprint;
      // operator-actionable signal that policy entries silently
      // stopped binding to this server.
      const p = event.payload as Record<string, unknown> | undefined;
      const rows: [string, string][] = [];
      const oldName = p?.name_old as string | undefined;
      const newName = p?.name_new as string | undefined;
      if (oldName) rows.push(["Old name", oldName]);
      if (newName) rows.push(["New name", newName]);
      const orphaned = p?.policy_entries_orphaned as
        | { count?: number; affected_policies?: string[] }
        | undefined;
      if (orphaned?.count != null) {
        rows.push(["Entries orphaned", String(orphaned.count)]);
      }
      if (orphaned?.affected_policies?.length) {
        rows.push([
          "Affected policies",
          orphaned.affected_policies.join(", "),
        ]);
      }
      if (rows.length === 0) {
        return [["Event", "MCP server name changed"]];
      }
      return rows;
    }
    case "directive_result": {
      const rows: [string, string][] = [];
      if (event.payload?.directive_name) {
        rows.push(["Name", event.payload.directive_name]);
      }
      if (event.payload?.directive_action) {
        rows.push(["Action", event.payload.directive_action]);
      }
      if (event.payload?.directive_status) {
        rows.push(["Status", event.payload.directive_status]);
      }
      if (event.payload?.duration_ms != null) {
        rows.push(["Duration", `${event.payload.duration_ms}ms`]);
      }
      if (event.payload?.error) {
        // directive_result events emit ``error`` as a plain string;
        // the ``llm_error`` event type uses the same payload
        // slot for a structured object. Narrow here so a future
        // directive_result that accidentally carries the structured
        // shape still renders instead of blowing up.
        const err = event.payload.error;
        rows.push(["Error", typeof err === "string" ? err : err.error_type]);
      }
      if (rows.length === 0) {
        rows.push(["Event", "directive result"]);
      }
      return rows;
    }
    case "embeddings": {
      // No tokens_output column for embeddings -- the provider call
      // has no generation step. Surface input tokens + latency only
      // so the expanded row doesn't render an empty "tokens output"
      // cell that would mislead a reader.
      return [
        ["Model", event.model ?? "unknown"],
        ["Tokens input", event.tokens_input?.toLocaleString() ?? "—"],
        ["Latency", event.latency_ms != null ? `${event.latency_ms.toLocaleString()}ms` : "—"],
        ...servingRows(event),
      ];
    }
    case "llm_error": {
      // Pull the structured taxonomy fields off ``payload.error``
      // and lay them out in the same key/value grid the rest of
      // the event types use. Narrows against the directive_result
      // string overload first so a misshaped payload can't blow
      // up the row. Detailed accordion fields (request_id,
      // retry_after, is_retryable) live in <ErrorEventDetails/>
      // so this list stays scannable.
      const err = event.payload?.error;
      const rows: [string, string][] = [
        ["Model", event.model ?? "unknown"],
      ];
      if (err && typeof err !== "string") {
        rows.push(["Error type", err.error_type]);
        rows.push(["Provider", err.provider || "unknown"]);
        if (err.http_status != null) {
          rows.push(["HTTP status", String(err.http_status)]);
        }
        if (err.provider_error_code) {
          rows.push(["Provider code", err.provider_error_code]);
        }
        if (err.error_message) {
          rows.push(["Message", err.error_message]);
        }
      }
      return rows;
    }
    case "session_signal":
      return signalRows(event.payload?.signal, event.payload?.signal_data);
    case "mcp_policy_user_remembered": {
      const p = event.payload;
      const rows: [string, string][] = [];
      if (p?.server_name) rows.push(["Server", p.server_name]);
      if (p?.server_url_canonical) rows.push(["Server URL", p.server_url_canonical]);
      if (p?.decided_at) rows.push(["Approved at", p.decided_at]);
      if (p?.permission_mode) rows.push(["Permission mode", p.permission_mode]);
      if (p?.fingerprint) rows.push(["Fingerprint", p.fingerprint]);
      if (rows.length === 0) return [["Event", "MCP server approved"]];
      return rows;
    }
    // MCP rows. The MCPEventDetails component renders the
    // bulk of the structured detail (arguments / result / rendered /
    // resource content); these summary rows are the at-a-glance
    // metadata the swimlane drawer surfaces above the accordion.
    case "mcp_tool_call":
    case "mcp_tool_list":
    case "mcp_resource_read":
    case "mcp_resource_list":
    case "mcp_prompt_get":
    case "mcp_prompt_list": {
      const p = event.payload;
      const rows: [string, string][] = [];
      if (p?.server_name) rows.push(["Server", p.server_name]);
      if (p?.transport) rows.push(["Transport", p.transport]);
      if (event.event_type === "mcp_tool_call" && event.tool_name) {
        rows.push(["Tool", event.tool_name]);
      }
      if (event.event_type === "mcp_resource_read" && p?.resource_uri) {
        rows.push(["URI", p.resource_uri]);
      }
      if (event.event_type === "mcp_prompt_get" && p?.prompt_name) {
        rows.push(["Prompt", p.prompt_name]);
      }
      if (typeof p?.count === "number") {
        rows.push(["Count", p.count.toLocaleString()]);
      }
      if (event.event_type === "mcp_resource_read" && typeof p?.content_bytes === "number") {
        rows.push(["Size", `${p.content_bytes.toLocaleString()} bytes`]);
      }
      if (event.event_type === "mcp_resource_read" && p?.mime_type) {
        rows.push(["MIME", p.mime_type]);
      }
      if (typeof p?.duration_ms === "number") {
        rows.push(["Duration", `${p.duration_ms.toLocaleString()}ms`]);
      }
      // Failed MCP op: surface the taxonomy classification in the
      // summary row so a glance at the row tells the operator what
      // failed without expanding.
      const err = p?.error;
      if (err && typeof err !== "string") {
        rows.push(["Error", err.error_type]);
      }
      return rows;
    }
    default:
      return [["Type", event.event_type]];
  }
}

/* ---- session_signal ---- */

type SignalData = Record<string, string | number | boolean | null> | undefined;

/** A signal name as words: ``context_compacted`` -> ``context compacted``. */
function signalWords(signal: string): string {
  return signal.replace(/_/g, " ");
}

// The user's answer to an MCP server's request for input, as the feed
// line words it.
const ELICITATION_OUTCOMES: Record<string, string> = {
  accept: "submitted",
  decline: "declined",
  cancel: "cancelled",
};

/** The feed line of a session_signal event. */
function signalDetail(signal: string | undefined, data: SignalData): string {
  if (!signal) return "session signal";
  const trigger = typeof data?.trigger === "string" ? data.trigger : null;
  switch (signal) {
    case "context_compaction_started":
      return trigger ? `compaction started · ${trigger}` : "compaction started";
    case "context_compacted":
      return trigger ? `context compacted · ${trigger}` : "context compacted";
    case "model_switched": {
      const from = typeof data?.from_model === "string" ? data.from_model : "?";
      const to = typeof data?.to_model === "string" ? data.to_model : "?";
      const source = typeof data?.source === "string" ? ` · ${data.source}` : "";
      return `model ${from} → ${to}${source}`;
    }
    case "notification": {
      const kind = typeof data?.notification_type === "string" ? data.notification_type : null;
      return kind ? `notification · ${signalWords(kind)}` : "notification";
    }
    case "permission_requested":
    case "permission_denied": {
      const verb = signal === "permission_denied" ? "permission denied" : "permission requested";
      const tool = typeof data?.tool_name === "string" ? ` · ${data.tool_name}` : "";
      const reason = signal === "permission_denied" && typeof data?.reason === "string" ? ` · ${data.reason}` : "";
      return `${verb}${tool}${reason}`;
    }
    case "command_expanded": {
      const name = typeof data?.command_name === "string" ? data.command_name : null;
      const label = data?.expansion_type === "mcp_prompt" ? "MCP prompt" : "command";
      return name ? `${label} · /${name.replace(/^\//, "")}` : label;
    }
    case "task_created":
    case "task_completed": {
      const verb = signal === "task_created" ? "task created" : "task completed";
      const teammate = typeof data?.teammate_name === "string" ? ` · ${data.teammate_name}` : "";
      return `${verb}${teammate}`;
    }
    case "cwd_changed":
      return typeof data?.new_cwd === "string" ? `cwd → ${data.new_cwd}` : "cwd changed";
    case "config_changed":
      return typeof data?.source === "string" ? `settings changed · ${signalWords(data.source)}` : "settings changed";
    case "elicitation_requested":
    case "elicitation_responded": {
      const server = typeof data?.mcp_server === "string" ? ` · ${data.mcp_server}` : "";
      if (signal === "elicitation_requested") return `MCP input requested${server}`;
      const outcome =
        ELICITATION_OUTCOMES[typeof data?.action === "string" ? data.action : ""] ?? "answered";
      return `MCP input ${outcome}${server}`;
    }
    default:
      return signalWords(signal);
  }
}

// The labels and formats of the signal_data keys the dashboard knows;
// any other key is listed under its own name.
const SIGNAL_DATA_LABELS: Record<string, string> = {
  trigger: "Trigger",
  from_model: "From model",
  to_model: "To model",
  requested_model: "Requested",
  source: "Source",
  context_tokens: "Context tokens",
  prompt_cache_warm: "Prompt cache warm",
  cache_ttl: "Cache TTL",
  estimated_cache_write_usd: "Est. cache write",
  pricing: "Pricing",
  notification_type: "Type",
  tool_name: "Tool",
  tool_use_id: "Tool use id",
  mcp_server: "MCP server",
  reason: "Reason",
  expansion_type: "Expansion",
  command_name: "Command name",
  command_source: "Command source",
  task_id: "Task id",
  teammate_name: "Teammate",
  old_cwd: "From directory",
  new_cwd: "To directory",
  mode: "Mode",
  elicitation_id: "Elicitation id",
  action: "Response",
  file_path: "File",
  command: "Command",
  query: "Query",
  pattern: "Pattern",
  prompt: "Prompt",
};

function signalValue(key: string, value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (key === "estimated_cache_write_usd" && typeof value === "number") return `$${value.toFixed(4)}`;
  if (typeof value === "number") return value.toLocaleString();
  return value;
}

/** The summary rows of a session_signal event. */
function signalRows(signal: string | undefined, data: SignalData): [string, string][] {
  const rows: [string, string][] = [["Signal", signal ? signalWords(signal) : "session signal"]];
  for (const [key, value] of Object.entries(data ?? {})) {
    rows.push([SIGNAL_DATA_LABELS[key] ?? key, signalValue(key, value)]);
  }
  return rows;
}

/* ---- Event type filter groups ---- */

export const EVENT_TYPE_GROUPS: Record<string, string[]> = {
  "LLM Calls": ["post_call", "pre_call"],
  "Tools": ["tool_call"],
  "Embeddings": ["embeddings"],
  "Errors": ["llm_error"],
  "Policy": ["policy_warn", "policy_block", "policy_degrade"],
  // MCP Protection Policy event types live in their own facet
  // group so token-budget policy filtering and MCP-server access
  // policy filtering stay distinct in the operator's mental model.
  // Kept apart from the "Policy" group because mixing
  // token-budget chips with MCP-server-access
  // chips made "show me all sessions where MCP enforcement fired"
  // require checking-and-unchecking sibling chips. Filterable but
  // not group-by-able on analytics (Rule 25 lock).
  "MCP Policy": [
    "policy_mcp_warn",
    "policy_mcp_block",
    "mcp_server_name_changed",
    "mcp_policy_user_remembered",
  ],
  "Directives": ["directive", "directive_result"],
  "Run": ["session_start", "session_end", "session_signal"],
  // MCP filter group spans all six MCP event types. The
  // filter pill colour is the tool family's cyan (rather than the
  // resource green or prompt purple) because tool calls are the
  // dominant traffic shape; the per-event-type badge family is what
  // distinguishes them once visible. See README "MCP Observability
  // by Source" for the per-source coverage matrix.
  "MCP": [
    "mcp_tool_list",
    "mcp_tool_call",
    "mcp_resource_list",
    "mcp_resource_read",
    "mcp_prompt_list",
    "mcp_prompt_get",
  ],
};

export const EVENT_FILTER_PILLS = [
  { label: "All", color: null },
  { label: "LLM Calls", color: "var(--event-llm)" },
  { label: "Tools", color: "var(--event-tool)" },
  { label: "Embeddings", color: "var(--event-embeddings)" },
  { label: "MCP", color: "var(--event-mcp-tool)" },
  { label: "Errors", color: "var(--event-error)" },
  { label: "Policy", color: "var(--event-warn)" },
  { label: "Directives", color: "var(--event-directive)" },
  { label: "Run", color: "var(--event-lifecycle)" },
] as const;

export function isEventVisible(eventType: string, activeFilter: string | null | undefined): boolean {
  if (!activeFilter) return true;
  const group = EVENT_TYPE_GROUPS[activeFilter];
  return group ? group.includes(eventType) : true;
}

/**
 * The three MCP "list/discovery" event types. These represent
 * the agent ASKING the server "what's available" rather than actually
 * USING something (call_tool / read_resource / get_prompt). They tend
 * to fire in bursts at session start and again whenever the agent
 * needs to refresh its capability picture, which is operationally
 * useful for audit but visually noisy in the Fleet live feed when
 * an MCP-heavy session is active. They are hidden by default in the
 * Fleet surfaces with a toggle to restore.
 *
 * The list is closed — the six MCP event types are pinned by the
 * lean wire payload contract and only the three ``_list`` / ``_get?`` no,
 * the three ``_list``-style event types qualify as discovery. The
 * three ``_call`` / ``_read`` / ``_get`` event types represent
 * actual MCP usage and are never discovery.
 */
export const MCP_DISCOVERY_EVENT_TYPES = [
  "mcp_tool_list",
  "mcp_resource_list",
  "mcp_prompt_list",
] as const;

const MCP_DISCOVERY_EVENT_TYPE_SET = new Set<string>(MCP_DISCOVERY_EVENT_TYPES);

/**
 * True when ``eventType`` is one of the three MCP discovery event
 * types (``mcp_tool_list`` / ``mcp_resource_list`` /
 * ``mcp_prompt_list``). Returns false for the three MCP usage event
 * types and for every non-MCP event_type. Safe to call with
 * arbitrary strings — anything not in the closed set returns false.
 */
export function isDiscoveryEvent(eventType: string): boolean {
  return MCP_DISCOVERY_EVENT_TYPE_SET.has(eventType);
}

/* ---- Session ID truncation ---- */

export function truncateSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/* ---- Flavor color hash ---- */

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function flavorColor(flavor: string): string {
  const hash = flavor.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % CHART_COLORS.length;
  // hash is mod CHART_COLORS.length, so the index is always in
  // bounds; the ?? fallback satisfies noUncheckedIndexedAccess
  // without a non-null assertion.
  return CHART_COLORS[hash] ?? CHART_COLORS[0] ?? "var(--chart-1)";
}
