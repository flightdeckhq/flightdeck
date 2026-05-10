import type {
  FleetResponse,
  AgentSummary,
  SessionDetail,
  Policy,
  PolicyRequest,
  DirectiveRequest,
  Directive,
  AnalyticsParams,
  AnalyticsResponse,
  EventContent,
  SearchResults,
  CustomDirective,
  AgentEvent,
  SessionsResponse,
  AccessToken,
  CreatedAccessToken,
  MCPPolicy,
  MCPPolicyAuditLog,
  MCPPolicyMetrics,
  MCPPolicyMutation,
  MCPPolicyResolveResult,
  MCPPolicyTemplate,
} from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL || "/api";

// D095/D096: every dashboard request is authenticated with an access
// token. "Access token" is the D096 rename -- the product also tracks
// LLM input/output token counts on sessions, so "token" alone is
// ambiguous. Phase 5 Part 1b hardcodes tok_dev; the Settings page in
// Phase 5 Part 2 will swap this for a user-selected access token
// read from localStorage. The ENVIRONMENT=dev gate on the API service
// means production deployments reject tok_dev at the middleware;
// shipping this fallback in a prod build is a non-issue because the
// server will 401 it anyway, but the Part 2 work still needs to
// replace this before a dashboard bundle is shipped to end users.
export const ACCESS_TOKEN = "tok_dev";

/** localStorage key that overrides the hardcoded ``ACCESS_TOKEN``
 *  when present. Pre-built for the Phase 5 Part 2 Settings page that
 *  will write to it via UI; in the meantime an operator who needs
 *  admin scope (e.g. for the MCP Protection Policy admin features)
 *  can paste an admin token via DevTools without a code change.
 *  Reading at request time keeps token rotation a localStorage
 *  change rather than a redeploy. */
export const ACCESS_TOKEN_STORAGE_KEY = "flightdeck-access-token";

function getActiveAccessToken(): string {
  if (typeof window === "undefined") return ACCESS_TOKEN;
  try {
    const stored = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    if (stored && stored.length > 0) return stored;
  } catch {
    // localStorage may be unavailable (e.g. SSR / strict iframe). Fall
    // back to the build-time token rather than failing requests.
  }
  return ACCESS_TOKEN;
}

// WS_ACCESS_TOKEN_QUERY is the query-string form used by the
// WebSocket /v1/stream endpoint. Browsers cannot set Authorization
// on a WebSocket upgrade, so the server accepts the access token via
// ``?token=`` as an alternative. Reads the active token at call
// time so a localStorage override is honoured for new connections.
export function wsAccessTokenQuery(): string {
  return `token=${encodeURIComponent(getActiveAccessToken())}`;
}

/** @deprecated import {@link wsAccessTokenQuery} and call it. The
 *  constant captures the build-time token and ignores the
 *  localStorage override. Kept for compatibility with call sites
 *  that haven't been migrated. */
export const WS_ACCESS_TOKEN_QUERY = `token=${encodeURIComponent(ACCESS_TOKEN)}`;

function authHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  if (!h.has("Authorization")) {
    h.set("Authorization", `Bearer ${getActiveAccessToken()}`);
  }
  return h;
}

// Default request timeout for every apiFetch call. 30 s matches
// browser fetch convention and is generous enough for the dashboard's
// largest-result paths (bulk events for a long session, full sessions
// list); none of the call sites is SSE / streaming. Callers passing
// their own AbortSignal still race the timeout — whichever fires
// first wins.
const REQUEST_TIMEOUT_MS = 30_000;

// apiFetch is the single fetch wrapper used by every call site in
// this module. Callers pass the same options they would to the
// global fetch; the wrapper injects the Authorization header (D095)
// and resolves the base URL. Keep all /api/* fetches routed through
// here so token rotation is a one-line change.
//
// Timeout: every request is bounded by REQUEST_TIMEOUT_MS via
// AbortSignal.timeout, raced with any caller-provided signal so a
// dead API server can never hang a tab. AbortSignal.any combines
// the two; without a caller signal the timeout signal is used
// directly.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: authHeaders(init.headers),
    signal,
  });
}

/** Builds the "Admin token required to ${action}" error string with
 *  an inline how-to-fix hint pointing the operator at the
 *  ``flightdeck-access-token`` localStorage key. Kept as a single
 *  helper so the instruction stays consistent across every admin
 *  surface (audit, metrics, dry-run, templates, YAML import/export,
 *  version history). The Phase 5 Part 2 Settings page will replace
 *  the hint with a Set-Token UI, at which point this helper's
 *  second sentence collapses to a CTA. */
export function adminTokenError(action: string): string {
  return (
    `Admin token required to ${action} ` +
    `Set the ${ACCESS_TOKEN_STORAGE_KEY} localStorage key in this ` +
    `browser to an admin-scoped token (DevTools → Application → ` +
    `Local Storage), then reload.`
  );
}

/** Subclass of Error that carries the HTTP status code so call
 *  sites can distinguish 401 / 403 / 404 / 5xx without parsing the
 *  message. Surfaces in MCP Protection Policy admin views render
 *  403 as actionable copy ("Admin token required") rather than a
 *  generic "API 403" message. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message?: string,
  ) {
    super(message ?? `API ${status}: ${path}`);
    this.name = "ApiError";
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    throw new ApiError(res.status, path);
  }
  return res.json() as Promise<T>;
}

export function fetchFleet(page = 1, perPage = 50, agentType?: string): Promise<FleetResponse> {
  let url = `/v1/fleet?page=${page}&per_page=${perPage}`;
  if (agentType) url += `&agent_type=${agentType}`;
  return fetchJson<FleetResponse>(url);
}

/**
 * Fetch a single agent's identity via ``GET /v1/agents/{id}``.
 * Returns ``null`` when the server 404s (agent id not known) so
 * callers can handle "no such agent" without a try/catch. Any other
 * non-2xx status still throws via fetchJson.
 */
export async function fetchAgentById(agentId: string): Promise<AgentSummary | null> {
  const res = await apiFetch(`/v1/agents/${encodeURIComponent(agentId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`API ${res.status}: /v1/agents/${agentId}`);
  }
  return (await res.json()) as AgentSummary;
}

/**
 * Fetch session detail. When ``eventsLimit`` is provided the server
 * returns at most the N newest events (still sorted ASC). The drawer
 * uses this to cap the initial load on long-running stable sessions
 * (D113); Fleet-side callers continue to call without the arg and
 * receive the full history.
 */
export function fetchSession(id: string, eventsLimit?: number): Promise<SessionDetail> {
  const qs = eventsLimit ? `?events_limit=${eventsLimit}` : "";
  return fetchJson<SessionDetail>(`/v1/sessions/${id}${qs}`);
}

/**
 * Fetch older events for a session via the keyset-cursor variant of
 * GET /v1/events. ``before`` is an RFC 3339 timestamp (typically the
 * oldest occurred_at currently visible in the drawer); the server
 * returns at most ``limit`` rows with occurred_at < before, ordered
 * newest-first. The drawer merges the result into the shared
 * eventsCache and re-sorts ASC.
 */
export function fetchOlderEvents(
  sessionId: string,
  before: string,
  limit: number,
): Promise<BulkEventsResponse> {
  // ``from`` is required by the endpoint but a keyset-by-before query
  // is already scoped to occurred_at < before; passing the Unix epoch
  // makes the time-window filter a no-op so the cursor is the only
  // bound that matters.
  const sp = new URLSearchParams();
  sp.set("from", "1970-01-01T00:00:00Z");
  sp.set("session_id", sessionId);
  sp.set("before", before);
  sp.set("order", "desc");
  sp.set("limit", String(limit));
  return fetchJson<BulkEventsResponse>(`/v1/events?${sp.toString()}`);
}

export async function fetchPolicies(): Promise<Policy[]> {
  try {
    return await fetchJson<Policy[]>("/v1/policies");
  } catch {
    return [];
  }
}

export async function createPolicy(data: PolicyRequest): Promise<Policy> {
  const res = await apiFetch(`/v1/policies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: POST /v1/policies`);
  }
  return res.json() as Promise<Policy>;
}

export async function updatePolicy(id: string, data: PolicyRequest): Promise<Policy> {
  const res = await apiFetch(`/v1/policies/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: PUT /v1/policies/${id}`);
  }
  return res.json() as Promise<Policy>;
}

export async function deletePolicy(id: string): Promise<void> {
  const res = await apiFetch(`/v1/policies/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: DELETE /v1/policies/${id}`);
  }
}

export async function createDirective(data: DirectiveRequest): Promise<Directive> {
  const res = await apiFetch(`/v1/directives`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: POST /v1/directives`);
  }
  return res.json() as Promise<Directive>;
}

export async function fetchEventContent(eventId: string): Promise<EventContent | null> {
  try {
    return await fetchJson<EventContent>(`/v1/events/${eventId}/content`);
  } catch {
    return null; // 404 or error
  }
}

export async function fetchSearch(query: string, signal?: AbortSignal): Promise<SearchResults> {
  return fetchJson<SearchResults>(`/v1/search?q=${encodeURIComponent(query)}`, { signal });
}

/**
 * Return distinct flavor strings seen across recent sessions. The
 * v0.4.0 Phase 1 fleet response is agent-keyed and no longer groups
 * sessions by flavor, so this helper sources the list from the
 * paginated /v1/sessions endpoint. Used by the policy editor and
 * directive trigger forms that still scope on sessions.flavor.
 *
 * Best-effort: returns [] on any network / parse failure so callers
 * (PolicyEditor dropdown, Directives flavor filter) render an empty
 * list rather than erroring out. The dropdowns accept free-form
 * input so an empty fetch is survivable.
 */
export async function fetchFlavors(): Promise<string[]> {
  try {
    // Server caps the sessions page at 100. Fetching more than that
    // requires paginating; for the policy-editor / directive-trigger
    // dropdowns one page of recent sessions is sufficient since the
    // dropdown is a hint, not an authoritative flavor list.
    const resp = await fetchSessions({ limit: 100, offset: 0 });
    const seen = new Set<string>();
    for (const s of resp.sessions) {
      if (s.flavor) seen.add(s.flavor);
    }
    return [...seen].sort();
  } catch {
    return [];
  }
}

export async function fetchCustomDirectives(flavor?: string): Promise<CustomDirective[]> {
  const url = flavor ? `/v1/directives/custom?flavor=${encodeURIComponent(flavor)}` : '/v1/directives/custom';
  const resp = await fetchJson<{ directives: CustomDirective[] }>(url);
  return resp.directives ?? [];
}

export async function triggerCustomDirective(data: {
  action: "custom";
  directive_name: string;
  fingerprint: string;
  session_id?: string;
  flavor?: string;
  parameters?: Record<string, unknown>;
}): Promise<void> {
  const res = await apiFetch(`/v1/directives`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
}

export interface BulkEventsParams {
  from: string;
  to?: string;
  flavor?: string;
  event_type?: string;
  session_id?: string;
  limit?: number;
  offset?: number;
}

export interface BulkEventsResponse {
  events: AgentEvent[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export function fetchBulkEvents(
  params: BulkEventsParams,
  signal?: AbortSignal,
): Promise<BulkEventsResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set("from", params.from);
  if (params.to) searchParams.set("to", params.to);
  if (params.flavor) searchParams.set("flavor", params.flavor);
  if (params.event_type) searchParams.set("event_type", params.event_type);
  if (params.session_id) searchParams.set("session_id", params.session_id);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));
  return fetchJson<BulkEventsResponse>(
    `/v1/events?${searchParams.toString()}`,
    { signal },
  );
}

export interface SessionsParams {
  q?: string;
  from?: string;
  to?: string;
  state?: string[];
  flavor?: string[];
  /** D115 single-agent filter. Empty = no filter. */
  agent_id?: string;
  /**
   * Filter by sessions.agent_type. D114 vocabulary
   * (``coding`` / ``production``). Repeatable: OR within the group,
   * AND with every other filter.
   */
  agent_type?: string[];
  /**
   * Filter on sessions.context.frameworks[] -- repeatable. Values
   * are the full name/version strings emitted by the sensor's
   * FrameworkCollector (e.g. "langgraph/1.1.6"). Server side this
   * maps to the ?| JSONB-array-contains-any operator.
   */
  framework?: string[];
  /**
   * Generic scalar-key context filters. Every key listed here maps
   * to a repeatable query param on ``/v1/sessions`` and a
   * ``context->>'<key>' IN (...)`` WHERE fragment on the server.
   * Keys outside this whitelist are silently dropped by the handler
   * -- safe against typos and injection. Keep in sync with
   * api/internal/store/sessions.go::AllowedContextFilterKeys.
   */
  user?: string[];
  os?: string[];
  arch?: string[];
  hostname?: string[];
  process_name?: string[];
  node_version?: string[];
  python_version?: string[];
  git_branch?: string[];
  /** Filter-only (no facet). Powers deep-link triage of a single
   *  commit across the fleet. */
  git_commit?: string[];
  git_repo?: string[];
  orchestration?: string[];
  /**
   * Phase 4: filter to sessions that emitted an llm_error event of
   * one of the listed taxonomy values (rate_limit, authentication,
   * etc.). Repeatable; OR within the dimension, AND with every
   * other filter. Backed by an EXISTS subquery over the events
   * table on the API side.
   */
  error_type?: string[];
  /**
   * Filter to sessions that emitted at least one policy enforcement
   * event of the listed types. Vocabulary: ``policy_warn`` |
   * ``policy_degrade`` | ``policy_block``. Repeatable; OR within the
   * dimension. Closed-set validated server-side — out-of-band values
   * 400.
   */
  policy_event_type?: string[];
  /**
   * Phase 5: filter to sessions that connected to at least one MCP
   * server with a matching name. Repeatable; OR within. Backed by an
   * EXISTS subquery against ``sessions.context.mcp_servers`` JSONB on
   * the API side. Powers the Investigate MCP SERVER facet.
   */
  mcp_server?: string[];
  /**
   * D126 sub-agent observability filters. ``parent_session_id``
   * scopes to children of one specific parent (powers the
   * SubAgentsTab "Sub-agents" list). ``agent_role`` is repeatable
   * — backs the Investigate ROLE facet's multi-select shape. The
   * ``has_sub_agents`` / ``is_sub_agent`` booleans back the
   * TOPOLOGY facet checkboxes.
   */
  parent_session_id?: string;
  agent_role?: string[];
  has_sub_agents?: boolean;
  is_sub_agent?: boolean;
  /**
   * Operator-actionable enrichment facet filters. Each repeatable
   * array filter narrows to sessions that emitted at least one
   * matching event. ``terminal`` is a bool toggle. Composes with
   * every other filter via AND.
   */
  close_reason?: string[];
  estimated_via?: string[];
  terminal?: boolean;
  matched_entry_id?: string[];
  originating_call_context?: string[];
  /**
   * D126 UX revision 2026-05-03 — when explicitly false, excludes
   * pure children (sessions whose ``parent_session_id`` is set
   * AND that themselves have no descendants), leaving
   * parents-with-children + lone sessions in the response. The
   * Investigate page sets this to false as its default scope.
   * Omit (undefined) preserves the legacy "all sessions" behaviour
   * — the param is tri-state on the wire (omit / true / false).
   */
  include_pure_children?: boolean;
  model?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

export async function fetchSessions(params: SessionsParams, signal?: AbortSignal): Promise<SessionsResponse> {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.state) {
    for (const s of params.state) sp.append("state", s);
  }
  if (params.flavor) {
    for (const f of params.flavor) sp.append("flavor", f);
  }
  if (params.agent_id) sp.set("agent_id", params.agent_id);
  if (params.agent_type) {
    for (const a of params.agent_type) sp.append("agent_type", a);
  }
  if (params.framework) {
    for (const fw of params.framework) sp.append("framework", fw);
  }
  // Generic scalar-key context filters. Iterated via the shared key
  // list so adding a new key is a one-line change here plus the
  // whitelist update on the server.
  for (const key of [
    "user",
    "os",
    "arch",
    "hostname",
    "process_name",
    "node_version",
    "python_version",
    "git_branch",
    "git_commit",
    "git_repo",
    "orchestration",
  ] as const) {
    const values = params[key];
    if (values) {
      for (const v of values) sp.append(key, v);
    }
  }
  if (params.error_type) {
    for (const et of params.error_type) sp.append("error_type", et);
  }
  if (params.policy_event_type) {
    for (const pt of params.policy_event_type) sp.append("policy_event_type", pt);
  }
  if (params.mcp_server) {
    for (const m of params.mcp_server) sp.append("mcp_server", m);
  }
  if (params.parent_session_id) sp.set("parent_session_id", params.parent_session_id);
  if (params.agent_role) {
    for (const r of params.agent_role) sp.append("agent_role", r);
  }
  if (params.has_sub_agents) sp.set("has_sub_agents", "true");
  if (params.is_sub_agent) sp.set("is_sub_agent", "true");
  if (params.close_reason) {
    for (const v of params.close_reason) sp.append("close_reason", v);
  }
  if (params.estimated_via) {
    for (const v of params.estimated_via) sp.append("estimated_via", v);
  }
  if (params.terminal) sp.set("terminal", "true");
  if (params.matched_entry_id) {
    for (const v of params.matched_entry_id) sp.append("matched_entry_id", v);
  }
  if (params.originating_call_context) {
    for (const v of params.originating_call_context)
      sp.append("originating_call_context", v);
  }
  if (params.include_pure_children !== undefined) {
    sp.set(
      "include_pure_children",
      params.include_pure_children ? "true" : "false",
    );
  }
  if (params.model) sp.set("model", params.model);
  if (params.sort) sp.set("sort", params.sort);
  if (params.order) sp.set("order", params.order);
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  return fetchJson<SessionsResponse>(`/v1/sessions?${sp.toString()}`, { signal });
}

export function fetchAnalytics(params: AnalyticsParams): Promise<AnalyticsResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) searchParams.set(key, value);
  });
  return fetchJson<AnalyticsResponse>(`/v1/analytics?${searchParams.toString()}`);
}

// ---- Access tokens (D095/D096) --------------------------------------
//
// All four endpoints run through apiFetch so the dev-time ACCESS_TOKEN
// header is attached. Errors propagate as thrown Error so the Settings
// page can render targeted inline messages per flow (create/rename/
// delete) rather than one global toast.

export function fetchAccessTokens(): Promise<AccessToken[]> {
  return fetchJson<AccessToken[]>("/v1/access-tokens");
}

export async function createAccessToken(name: string): Promise<CreatedAccessToken> {
  const res = await apiFetch("/v1/access-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: POST /v1/access-tokens`);
  }
  return res.json() as Promise<CreatedAccessToken>;
}

export async function deleteAccessToken(id: string): Promise<void> {
  const res = await apiFetch(`/v1/access-tokens/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`API ${res.status}: DELETE /v1/access-tokens/${id}`);
  }
}

export async function renameAccessToken(id: string, name: string): Promise<AccessToken> {
  const res = await apiFetch(`/v1/access-tokens/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: PATCH /v1/access-tokens/${id}`);
  }
  return res.json() as Promise<AccessToken>;
}

// ----- Whoami (D147) -----

/** Response shape for GET /v1/whoami. Read-open per D147. */
export interface WhoamiResponse {
  role: "admin" | "viewer";
  token_id: string;
}

export function fetchWhoami(): Promise<WhoamiResponse> {
  return fetchJson<WhoamiResponse>("/v1/whoami");
}

// ----- MCP Protection Policy (D128 / D131 / D135 / D138 / D139 / D147) -----

export function fetchGlobalMCPPolicy(): Promise<MCPPolicy> {
  return fetchJson<MCPPolicy>("/v1/mcp-policies/global");
}

export async function fetchFlavorMCPPolicy(
  flavor: string,
): Promise<MCPPolicy | null> {
  const res = await apiFetch(`/v1/mcp-policies/${encodeURIComponent(flavor)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchFlavorMCPPolicy ${res.status}`);
  }
  return res.json() as Promise<MCPPolicy>;
}

export function createFlavorMCPPolicy(
  flavor: string,
  body: MCPPolicyMutation,
): Promise<MCPPolicy> {
  return fetchJson<MCPPolicy>(
    `/v1/mcp-policies/${encodeURIComponent(flavor)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function updateGlobalMCPPolicy(
  body: MCPPolicyMutation,
): Promise<MCPPolicy> {
  return fetchJson<MCPPolicy>("/v1/mcp-policies/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateFlavorMCPPolicy(
  flavor: string,
  body: MCPPolicyMutation,
): Promise<MCPPolicy> {
  return fetchJson<MCPPolicy>(
    `/v1/mcp-policies/${encodeURIComponent(flavor)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function deleteFlavorMCPPolicy(flavor: string): Promise<void> {
  const res = await apiFetch(`/v1/mcp-policies/${encodeURIComponent(flavor)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteFlavorMCPPolicy ${res.status}`);
  }
}

export function resolveMCPPolicy(params: {
  flavor?: string;
  server_url: string;
  server_name: string;
}): Promise<MCPPolicyResolveResult> {
  const qs = new URLSearchParams({
    server_url: params.server_url,
    server_name: params.server_name,
  });
  if (params.flavor) qs.set("flavor", params.flavor);
  return fetchJson<MCPPolicyResolveResult>(
    `/v1/mcp-policies/resolve?${qs.toString()}`,
  );
}

export function listMCPPolicyAuditLog(
  flavorOrGlobal: string,
  params: {
    event_type?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<MCPPolicyAuditLog[]> {
  const qs = new URLSearchParams();
  if (params.event_type) qs.set("event_type", params.event_type);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const path =
    `/v1/mcp-policies/${encodeURIComponent(flavorOrGlobal)}/audit-log`
    + (qs.toString() ? `?${qs.toString()}` : "");
  return fetchJson<MCPPolicyAuditLog[]>(path);
}

export function getMCPPolicyMetrics(
  flavorOrGlobal: string,
  period: "24h" | "7d" | "30d" = "24h",
): Promise<MCPPolicyMetrics> {
  return fetchJson<MCPPolicyMetrics>(
    `/v1/mcp-policies/${encodeURIComponent(flavorOrGlobal)}/metrics?period=${period}`,
  );
}

export function listMCPPolicyTemplates(): Promise<MCPPolicyTemplate[]> {
  return fetchJson<MCPPolicyTemplate[]>("/v1/mcp-policies/templates");
}

export function applyMCPPolicyTemplate(
  flavor: string,
  templateName: string,
): Promise<MCPPolicy> {
  return fetchJson<MCPPolicy>(
    `/v1/mcp-policies/${encodeURIComponent(flavor)}/apply_template`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: templateName }),
    },
  );
}
