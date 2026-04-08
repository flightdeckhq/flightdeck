/** Lifecycle state of a sensor session. */
export type SessionState = "active" | "idle" | "stale" | "closed" | "lost";

/** All event types the sensor can emit. */
export type EventType =
  | "session_start"
  | "session_end"
  | "heartbeat"
  | "pre_call"
  | "post_call"
  | "tool_call";

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
  warn_at_pct?: number | null;
  degrade_at_pct?: number | null;
  degrade_to?: string | null;
  block_at_pct?: number | null;
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
  occurred_at: string;
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
}

/** Session detail response from GET /v1/sessions/:id. */
export interface SessionDetail {
  session: Session;
  events: AgentEvent[];
}

/** WebSocket message pushed on fleet state change. */
export interface FleetUpdate {
  type: "session_update" | "session_start" | "session_end";
  session: Session;
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

/** Control-plane directive (Phase 2+, defined for type completeness). */
export interface Directive {
  action: string;
  reason: string;
  grace_period_ms: number;
}
