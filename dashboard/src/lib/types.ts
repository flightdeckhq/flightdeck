import type { AgentType, ClientType } from "./agent-identity";

/** Lifecycle state of a sensor session. */
export type SessionState = "active" | "idle" | "stale" | "closed" | "lost";

/** All event types the sensor can emit. */
export type EventType =
  | "session_start"
  | "session_end"
  | "heartbeat"
  | "pre_call"
  | "post_call"
  | "tool_call"
  | "policy_warn"
  | "policy_block"
  | "policy_degrade"
  | "directive"
  | "directive_result"
  // Phase 4 additions (v0.5.0):
  | "embeddings"
  | "llm_error"
  // Phase 5 (v0.6.0) — MCP observability. The Python sensor emits all
  // six; the Claude Code plugin emits MCP_TOOL_CALL only (asymmetric
  // by design — see README "MCP Observability by Source"). All six
  // share the same wire schema regardless of source.
  | "mcp_tool_list"
  | "mcp_tool_call"
  | "mcp_resource_list"
  | "mcp_resource_read"
  | "mcp_prompt_list"
  | "mcp_prompt_get";

/** 14-entry structured LLM API error taxonomy. Mirrors
 *  ``sensor/flightdeck_sensor/core/errors.py::ErrorType``. */
export type LLMErrorType =
  | "rate_limit"
  | "quota_exceeded"
  | "context_overflow"
  | "content_filter"
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "request_too_large"
  | "api_error"
  | "overloaded"
  | "timeout"
  | "stream_error"
  | "other";

/** Structured ``error`` sub-object attached to an ``llm_error`` event.
 *  Carries the Phase 4 taxonomy classification plus provider-side
 *  fields (http_status, provider_error_code, request_id, retry_after)
 *  so the dashboard can render a precise, actionable view without a
 *  second fetch. Optional ``partial_*`` fields appear when the error
 *  aborted a stream mid-way. */
export interface LLMErrorPayload {
  error_type: LLMErrorType;
  provider: string;
  http_status: number | null;
  provider_error_code: string | null;
  error_message: string;
  request_id: string | null;
  retry_after: number | null;
  is_retryable: boolean;
  abort_reason?: string;
  partial_chunks?: number;
  partial_tokens_input?: number;
  partial_tokens_output?: number;
}

/** Per-chunk latency summary attached to a streaming ``post_call`` event.
 *  Populated only when the call was made with ``stream=true`` -- the
 *  field is omitted on non-streaming calls to keep the wire shape
 *  identical to pre-Phase-4 behaviour. */
export interface StreamingMetrics {
  ttft_ms: number | null;
  chunk_count: number;
  inter_chunk_ms: { p50: number; p95: number; max: number } | null;
  final_outcome: "completed" | "aborted";
  abort_reason: string | null;
}

/** MCP transport used to talk to a server. ``stdio`` for local
 *  subprocess servers, ``http`` for streamable-http, ``sse`` for
 *  Server-Sent Events, ``websocket`` for WS. ``null`` when the
 *  sensor could not detect (e.g. caller built ClientSession with
 *  hand-built streams). The dashboard renders the label as-is. */
export type MCPTransport = "stdio" | "http" | "sse" | "websocket" | null;

/** Identity record for an MCP server a session connected to.
 *
 *  Captured exactly once per server during ``ClientSession.initialize()``
 *  by the Python sensor's MCP interceptor. Stored in
 *  ``sessions.context.mcp_servers`` JSONB and surfaced on the session
 *  detail response. The listing surfaces only the names array
 *  (``mcp_server_names[]``); the full fingerprint rides the detail
 *  endpoint.
 *
 *  ``protocol_version`` is intentionally typed ``string | number`` to
 *  match the SDK's ``InitializeResult.protocolVersion``. Recent MCP
 *  spec drafts ship integer-coded versions; older releases ship date
 *  strings (``"2025-11-25"``). The dashboard handles both with a
 *  one-line type guard at render time -- see ``MCPServersPanel``.
 */
export interface MCPServerFingerprint {
  name: string;
  transport: MCPTransport;
  protocol_version: string | number;
  version: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  capabilities: Record<string, any>;
  instructions: string | null;
}

/** Structured ``error`` taxonomy emitted by the sensor's MCP
 *  interceptor on any failed MCP operation. Mirrors the shape of
 *  ``LLMErrorPayload`` so the dashboard can reuse the
 *  ``ErrorEventDetails`` accordion pattern, but error codes here are
 *  JSON-RPC error codes (-32600/-32602/-32000/-32601/408 plus
 *  ``other``) rather than provider HTTP statuses. */
export interface MCPErrorPayload {
  error_type: string;
  error_class: string;
  message: string;
  code?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

/** A single MCP rendered prompt message. Mirrors the SDK's
 *  ``GetPromptResult.messages[]`` shape after pydantic ``model_dump``.
 *  ``content`` is provider-specific (text block, tool result, image,
 *  etc.) so we keep it untyped. */
export interface MCPRenderedMessage {
  role: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
}

/** Agent flavor (persistent identity). */
export interface Agent {
  flavor: string;
  agent_type: string;
  first_seen: string;
  last_seen: string;
  session_count: number;
}

/** Session (ephemeral identity). */
export interface Session {
  session_id: string;
  flavor: string;
  agent_type: string;
  /** D115 identity columns. Nullable for sessions lazy-created
   *  before the authoritative session_start arrived. */
  agent_id?: string | null;
  agent_name?: string | null;
  client_type?: ClientType | null;
  host: string | null;
  framework: string | null;
  model: string | null;
  state: SessionState;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  tokens_used: number;
  token_limit: number | null;
  /**
   * Runtime context dict captured by the sensor at init() time.
   * Stored once in sessions.context (JSONB) and never updated.
   * See dashboard/src/types/context.ts for the facet types.
   */
  context?: Record<string, unknown>;
  has_pending_directive?: boolean;
  warn_at_pct?: number | null;
  degrade_at_pct?: number | null;
  degrade_to?: string | null;
  block_at_pct?: number | null;
  /**
   * True when at least one event in this session has has_content=true.
   * Computed by the API via EXISTS subquery; no schema change required.
   */
  capture_enabled?: boolean;
  /**
   * Name of the access_tokens row that opened this session (D095).
   * Null for tok_dev-authenticated sessions and pre-Phase-5 rows.
   * Preserved across token revocation so historical sessions keep
   * their attribution snapshot.
   */
  token_name?: string | null;
}

/**
 * Per-event-type metadata that does not fit the canonical schema columns.
 *
 * Currently only populated for `directive_result` events, where the
 * sensor sends directive_name / directive_action / directive_status /
 * result / error / duration_ms. The dashboard reads these fields from
 * `event.payload` to render directive status without a separate
 * /v1/events/:id/content fetch.
 */
export interface EventPayloadFields {
  directive_name?: string;
  directive_action?: string;
  directive_status?: string;
  // result is provider-specific JSON -- intentionally untyped
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  // Phase 4: ``error`` is overloaded. Legacy directive_result events
  // emit a plain string here; the new llm_error events emit a
  // structured LLMErrorPayload. Components that read ``payload.error``
  // must narrow via ``typeof`` before accessing taxonomy fields.
  error?: string | LLMErrorPayload;
  duration_ms?: number;
  // Phase 4 streaming sub-object; populated only on post_call events
  // emitted from a ``stream=true`` call.
  streaming?: StreamingMetrics;
  // Policy enforcement fields. Populated on ``policy_warn`` /
  // ``policy_degrade`` / ``policy_block`` events. ``source`` is
  // ``"local"`` (init() limit) or ``"server"`` (server policy);
  // BLOCK is always ``"server"`` per D035.
  source?: "local" | "server";
  threshold_pct?: number | null;
  tokens_used?: number;
  token_limit?: number | null;
  // policy_degrade additions: the model swap.
  from_model?: string;
  to_model?: string;
  // policy_block addition: the model the blocked call was going to use.
  intended_model?: string;

  // Phase 5 MCP fields. Populated on the six MCP_* event types by the
  // sensor's MCP interceptor (and on MCP_TOOL_CALL by the Claude Code
  // plugin). Absent on every other event type — the lean payload
  // shape (Phase 5 override 2) means non-MCP events do not carry
  // these fields at all. Field semantics by event type:
  //
  //   mcp_tool_list / mcp_resource_list / mcp_prompt_list:
  //     server_name, transport, count, duration_ms.
  //   mcp_tool_call:
  //     server_name, transport, duration_ms, plus arguments + result
  //     when capture_prompts=true. ``tool_name`` rides the canonical
  //     events.tool_name column at the AgentEvent top level for
  //     filter compatibility.
  //   mcp_resource_read:
  //     server_name, transport, resource_uri, content_bytes (always),
  //     duration_ms, plus mime_type + content when capture_prompts=true.
  //   mcp_prompt_get:
  //     server_name, transport, prompt_name, duration_ms, plus
  //     arguments + rendered when capture_prompts=true.
  //   any failure path:
  //     ``error`` carries the structured MCP taxonomy (overload of
  //     the LLMErrorPayload union). Components that read
  //     ``payload.error`` on MCP events must narrow via ``error_class``
  //     or by checking the parent event_type.
  server_name?: string;
  transport?: MCPTransport;
  count?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments?: Record<string, any>;
  resource_uri?: string;
  content_bytes?: number;
  mime_type?: string;
  prompt_name?: string;
  rendered?: MCPRenderedMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any;
}

/** Event metadata (no prompt content inline). */
export interface AgentEvent {
  id: string;
  session_id: string;
  flavor: string;
  event_type: EventType;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  latency_ms: number | null;
  tool_name: string | null;
  has_content: boolean;
  payload?: EventPayloadFields;
  occurred_at: string;
}

/** A feed event wraps an AgentEvent with a client-side arrival timestamp. */
export interface FeedEvent {
  arrivedAt: number;
  event: AgentEvent;
}

/**
 * v0.4.0 Phase 1 (D115): the swimlane still renders ``FlavorSummary``
 * rows but each row now represents an **agent** rather than a flavor
 * string. The ``flavor`` field carries the agent_id (kept under the
 * old name so the existing swimlane code does not need to be
 * retyped); optional ``agent_id`` / ``agent_name`` / ``client_type``
 * fields carry the D115 identity tuple the label renders. Sessions
 * inside are the sessions belonging to that agent_id.
 *
 * Populated by the fleet store by fetching the agents roster plus a
 * recent-sessions window and grouping client-side. The policy /
 * directive flavor pickers still consume the string ``flavor`` field
 * (now usually the agent_id) through ``fetchFlavors``.
 */
export interface FlavorSummary {
  flavor: string;
  agent_type: string;
  session_count: number;
  active_count: number;
  tokens_used_total: number;
  sessions: Session[];
  /** D115 identity fields. Populated when the summary was built from
   *  agent-grouped data; absent for legacy consumers. */
  agent_id?: string;
  agent_name?: string;
  client_type?: ClientType;
  user?: string;
  hostname?: string;
  last_seen_at?: string;
}

/**
 * Agent (persistent fleet entity) as returned by GET /v1/fleet in
 * the v0.4.0 Phase 1 shape (D115). Each row aggregates multiple
 * sessions under one agent_id.
 */
export interface AgentSummary {
  agent_id: string;
  agent_name: string;
  agent_type: AgentType;
  client_type: ClientType;
  user: string;
  hostname: string;
  first_seen_at: string;
  last_seen_at: string;
  total_sessions: number;
  total_tokens: number;
  /** State rollup: "active" if any session under this agent is
   *  active; otherwise the most-recent session's state; empty string
   *  when the agent has no sessions yet. */
  state: SessionState | "";
}

/** Top-level fleet response. */
export interface FleetResponse {
  agents: AgentSummary[];
  total: number;
  page: number;
  per_page: number;
  /**
   * Aggregated runtime context facets across all non-terminal
   * sessions. Powers the CONTEXT sidebar filter panel. Empty
   * object when no sessions have context.
   */
  context_facets: import("@/types/context").ContextFacets;
}

/** Session detail response from GET /v1/sessions/:id. */
export interface SessionDetail {
  session: Session;
  events: AgentEvent[];
  /**
   * Chronological list of timestamps where an agent re-attached to
   * this session using the same session_id. Excludes the initial
   * session_start. Populated by the ingestion session store (D094);
   * empty for sessions that have only ever run once. Consumed by the
   * drawer's ATTACH badge and the swimlane's amber start circle.
   */
  attachments?: string[];
}

/** WebSocket message pushed on fleet state change. */
export interface FleetUpdate {
  type: "session_update" | "session_start" | "session_end";
  session: Session;
  last_event?: AgentEvent;
}

/** Token policy as returned by GET /v1/policies. */
export interface Policy {
  id: string;
  scope: "org" | "flavor" | "session";
  scope_value: string;
  token_limit: number | null;
  warn_at_pct: number | null;
  degrade_at_pct: number | null;
  degrade_to: string | null;
  block_at_pct: number | null;
  created_at: string;
  updated_at: string;
}

/** Request body for creating or updating a policy. */
export interface PolicyRequest {
  scope: "org" | "flavor" | "session";
  scope_value: string;
  token_limit: number | null;
  warn_at_pct: number | null;
  degrade_at_pct: number | null;
  degrade_to: string | null;
  block_at_pct: number | null;
}

/** Request body for POST /v1/directives. */
export interface DirectiveRequest {
  action: "shutdown" | "shutdown_flavor";
  session_id?: string;
  flavor?: string;
  reason?: string;
  grace_period_ms?: number;
}

/** Control-plane directive as returned by API. */
export interface Directive {
  id: string;
  session_id: string | null;
  flavor: string | null;
  action: string;
  reason: string | null;
  degrade_to: string | null;
  grace_period_ms: number;
  issued_by: string;
  issued_at: string;
  delivered_at: string | null;
}

/** Query parameters for GET /v1/analytics. */
export interface AnalyticsParams {
  metric?: string;
  group_by?: string;
  range?: string;
  from?: string;
  to?: string;
  granularity?: string;
  filter_flavor?: string;
  filter_model?: string;
  filter_agent_type?: string;
  filter_provider?: string;
}

/** A single time-series data point. */
export interface DataPoint {
  date: string;
  value: number;
}

/** One dimension series in the analytics response. */
export interface AnalyticsSeries {
  dimension: string;
  total: number;
  data: DataPoint[];
}

/** Aggregated totals for the analytics response. */
export interface AnalyticsTotals {
  grand_total: number;
  period_change_pct: number;
}

/** Response from GET /v1/analytics. */
export interface AnalyticsResponse {
  metric: string;
  group_by: string;
  range: string;
  granularity: string;
  series: AnalyticsSeries[];
  totals: AnalyticsTotals;
  /** True when metric=estimated_cost and the window contains post_call
   *  rows for models without a pricing entry. UI shows a partial-
   *  estimate disclaimer when set. See DECISIONS.md D099. */
  partial_estimate?: boolean;
}

/** Prompt content for a single event, from GET /v1/events/:id/content. */
export interface EventContent {
  event_id: string;
  session_id: string;
  provider: string;
  model: string;
  system_prompt: string | null;
  // Provider-specific JSON structures -- intentionally untyped per rule 20
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any;
  /**
   * Phase 4 polish: embedding-shaped content. Populated only on
   * ``event_type=embeddings`` events; absent on chat events. Carries
   * the request's ``input`` parameter -- a string (single-input
   * embed) or list of strings (batch embed) per the OpenAI / litellm
   * / LangChain ``OpenAIEmbeddings`` API. Dashboard's
   * ``EmbeddingsContentViewer`` branches on the type to render the
   * single-input or batch-list view.
   */
  // ``input`` is overloaded across event-content sources:
  //   * Phase 4 ``embeddings``: string (single-input embed) or string[]
  //     (batch embed) — the OpenAI / litellm input parameter.
  //   * Phase 5 ``mcp_tool_call`` / ``mcp_prompt_get`` overflow (B-6):
  //     dict carrying the call's full ``arguments`` when the inline
  //     payload field overflowed the 8 KiB threshold.
  // Components branch on the parent event's event_type to render
  // appropriately.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: string | string[] | Record<string, any> | null;
  captured_at: string;
}

/** Custom directive registered by a sensor. */
export interface CustomDirective {
  id: string;
  fingerprint: string;
  name: string;
  description: string;
  flavor: string;
  parameters: CustomDirectiveParameter[];
  registered_at: string;
  last_seen_at: string;
}

/** A single parameter for a custom directive. */
export interface CustomDirectiveParameter {
  name: string;
  type: "string" | "integer" | "boolean" | "float";
  description: string;
  options: string[];
  required: boolean;
  default: unknown;
}

/** Search result: agent summary. */
export interface SearchResultAgent {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  last_seen: string;
}

/** Search result: session summary (extended with fields for Investigate table). */
export interface SearchResultSession {
  session_id: string;
  flavor: string;
  host: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  model: string;
  tokens_used: number;
  token_limit: number | null;
  context: Record<string, unknown>;
}

/** Search result: event summary. */
export interface SearchResultEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  tool_name: string;
  model: string;
  occurred_at: string;
}

/** Combined search results from GET /v1/search. */
export interface SearchResults {
  agents: SearchResultAgent[];
  sessions: SearchResultSession[];
  events: SearchResultEvent[];
}

/** One row in the paginated sessions list from GET /v1/sessions. */
export interface SessionListItem {
  session_id: string;
  flavor: string;
  /**
   * D114 vocabulary: ``coding`` or ``production``. Populated from
   * sessions.agent_type. Drives the AGENT TYPE facet on the
   * Investigate page.
   */
  agent_type: AgentType;
  /** D115 identity fields (nullable for legacy / lazy-created rows). */
  agent_id?: string | null;
  agent_name?: string | null;
  client_type?: ClientType | null;
  host: string | null;
  model: string | null;
  state: SessionState;
  started_at: string;
  ended_at: string | null;
  /**
   * Most-recent activity timestamp. For active / idle / stale / lost
   * sessions: max(events.occurred_at) across the session, projected
   * through the worker's last_seen_at column. For closed sessions:
   * effectively the session_end timestamp. Drives the Investigate
   * "Last Seen" column.
   */
  last_seen_at: string;
  duration_s: number;
  tokens_used: number;
  token_limit: number | null;
  context: Record<string, unknown>;
  /**
   * True when at least one event in this session has has_content=true.
   * Drives the camera icon in the Investigate table and the SessionDrawer.
   */
  capture_enabled?: boolean;
  /** D095 attribution -- nullable when token was revoked or the row
   *  predates Phase 5. */
  token_id?: string | null;
  token_name?: string | null;
  /**
   * Phase 4 polish: every distinct ``payload->'error'->>'error_type'``
   * observed across the session's ``llm_error`` events. Always
   * present on the wire (empty array when the session has no
   * errors) so the dashboard can read ``error_types.length > 0``
   * directly without a null check. Drives the Investigate ERROR
   * TYPE facet aggregation and the row-level red error indicator
   * in the session table.
   */
  error_types?: string[];
  /**
   * Every distinct policy enforcement ``event_type`` observed in the
   * session: any subset of ``policy_warn`` / ``policy_degrade`` /
   * ``policy_block``. Always present (empty array when no policy
   * events). Drives the Investigate POLICY facet aggregation and the
   * severity-ranked row-level dot indicator (block > degrade > warn).
   */
  policy_event_types?: string[];
  /**
   * Phase 5: every distinct MCP server name the session connected to,
   * derived at query time from ``sessions.context.mcp_servers`` JSONB.
   * Always present on the wire (empty array when the session connected
   * to no MCP server). Drives the Investigate MCP SERVER facet
   * aggregation. Names only — the listing payload stays lean; the full
   * fingerprint (transport, version, capabilities, instructions) lives
   * on the detail endpoint via ``Session.context.mcp_servers``.
   */
  mcp_server_names?: string[];
}

/** Paginated response from GET /v1/sessions. */
export interface SessionsResponse {
  sessions: SessionListItem[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

/** One row in the GET /v1/access-tokens response (D095/D096). */
export interface AccessToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Response body for POST /v1/access-tokens. The `token` field is the
 * plaintext access token and is returned to the caller exactly once
 * on creation -- it is never exposed by any other endpoint.
 */
export interface CreatedAccessToken {
  id: string;
  name: string;
  prefix: string;
  token: string;
  created_at: string;
}
