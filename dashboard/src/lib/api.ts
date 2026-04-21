import type { FleetResponse, SessionDetail, Policy, PolicyRequest, DirectiveRequest, Directive, AnalyticsParams, AnalyticsResponse, EventContent, SearchResults, CustomDirective, AgentEvent, SessionsResponse, AccessToken, CreatedAccessToken } from "./types";

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

// WS_ACCESS_TOKEN_QUERY is the query-string form used by the
// WebSocket /v1/stream endpoint. Browsers cannot set Authorization
// on a WebSocket upgrade, so the server accepts the access token via
// ``?token=`` as an alternative.
export const WS_ACCESS_TOKEN_QUERY = `token=${encodeURIComponent(ACCESS_TOKEN)}`;

function authHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  if (!h.has("Authorization")) {
    h.set("Authorization", `Bearer ${ACCESS_TOKEN}`);
  }
  return h;
}

// apiFetch is the single fetch wrapper used by every call site in
// this module. Callers pass the same options they would to the
// global fetch; the wrapper injects the Authorization header (D095)
// and resolves the base URL. Keep all /api/* fetches routed through
// here so token rotation is a one-line change.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, headers: authHeaders(init.headers) });
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}

export function fetchFleet(limit = 50, offset = 0, agentType?: string): Promise<FleetResponse> {
  let url = `/v1/fleet?limit=${limit}&offset=${offset}`;
  if (agentType) url += `&agent_type=${agentType}`;
  return fetchJson<FleetResponse>(url);
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

export async function fetchFlavors(): Promise<string[]> {
  const resp = await fetchFleet(200, 0);
  return resp.flavors.map((f) => f.flavor);
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

export function fetchBulkEvents(params: BulkEventsParams): Promise<BulkEventsResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set("from", params.from);
  if (params.to) searchParams.set("to", params.to);
  if (params.flavor) searchParams.set("flavor", params.flavor);
  if (params.event_type) searchParams.set("event_type", params.event_type);
  if (params.session_id) searchParams.set("session_id", params.session_id);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));
  return fetchJson<BulkEventsResponse>(`/v1/events?${searchParams.toString()}`);
}

export interface SessionsParams {
  q?: string;
  from?: string;
  to?: string;
  state?: string[];
  flavor?: string[];
  /**
   * Filter by sessions.agent_type. Repeatable: OR within the group,
   * AND with every other filter. Values are free-form text and
   * unvalidated at the API layer -- a typo just yields an empty
   * result.
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
