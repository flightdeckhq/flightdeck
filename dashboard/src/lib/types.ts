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
  | "directive_result";

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
  error?: string;
  duration_ms?: number;
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

/** Fleet state grouped by flavor, as returned by GET /v1/fleet. */
export interface FlavorSummary {
  flavor: string;
  agent_type: string;
  session_count: number;
  active_count: number;
  tokens_used_total: number;
  sessions: Session[];
}

/** Top-level fleet response. */
export interface FleetResponse {
  flavors: FlavorSummary[];
  total_session_count: number;
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
  flavor: string;
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
   * developer / autonomous / supervised / batch. Populated from the
   * sessions.agent_type column. Drives the AGENT TYPE facet on the
   * Investigate page.
   */
  agent_type: string;
  host: string | null;
  model: string | null;
  state: SessionState;
  started_at: string;
  ended_at: string | null;
  duration_s: number;
  tokens_used: number;
  token_limit: number | null;
  context: Record<string, unknown>;
  /**
   * True when at least one event in this session has has_content=true.
   * Drives the camera icon in the Investigate table and the SessionDrawer.
   */
  capture_enabled?: boolean;
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
