import type { FleetResponse, SessionDetail, Policy, PolicyRequest } from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}

export function fetchFleet(limit = 50, offset = 0): Promise<FleetResponse> {
  return fetchJson<FleetResponse>(`/v1/fleet?limit=${limit}&offset=${offset}`);
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
