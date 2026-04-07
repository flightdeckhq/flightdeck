import type { FleetResponse, SessionDetail } from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}

export function fetchFleet(): Promise<FleetResponse> {
  return fetchJson<FleetResponse>("/v1/fleet");
}

export function fetchSession(id: string): Promise<SessionDetail> {
  return fetchJson<SessionDetail>(`/v1/sessions/${id}`);
}
