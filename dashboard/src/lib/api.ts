import type { FleetResponse, SessionDetail, Policy, PolicyRequest, DirectiveRequest, Directive, AnalyticsParams, AnalyticsResponse, EventContent, SearchResults, CustomDirective, AgentEvent, SessionsResponse } from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL || "/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
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

export function fetchSession(id: string): Promise<SessionDetail> {
  return fetchJson<SessionDetail>(`/v1/sessions/${id}`);
}

export async function fetchPolicies(): Promise<Policy[]> {
  try {
    return await fetchJson<Policy[]>("/v1/policies");
  } catch {
    return [];
  }
}

export async function createPolicy(data: PolicyRequest): Promise<Policy> {
  const res = await fetch(`${BASE}/v1/policies`, {
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
  const res = await fetch(`${BASE}/v1/policies/${id}`, {
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
  const res = await fetch(`${BASE}/v1/policies/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: DELETE /v1/policies/${id}`);
  }
}

export async function createDirective(data: DirectiveRequest): Promise<Directive> {
  const res = await fetch(`${BASE}/v1/directives`, {
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
  const res = await fetch(`${BASE}/v1/search?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) {
    throw new Error(`API ${res.status}: /v1/search`);
  }
  return res.json() as Promise<SearchResults>;
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
  const res = await fetch(`${BASE}/v1/directives`, {
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
  if (params.model) sp.set("model", params.model);
  if (params.sort) sp.set("sort", params.sort);
  if (params.order) sp.set("order", params.order);
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  const res = await fetch(`${BASE}/v1/sessions?${sp.toString()}`, { signal });
  if (!res.ok) throw new Error(`API ${res.status}: GET /v1/sessions`);
  return res.json() as Promise<SessionsResponse>;
}

export function fetchAnalytics(params: AnalyticsParams): Promise<AnalyticsResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) searchParams.set(key, value);
  });
  return fetchJson<AnalyticsResponse>(`/v1/analytics?${searchParams.toString()}`);
}
