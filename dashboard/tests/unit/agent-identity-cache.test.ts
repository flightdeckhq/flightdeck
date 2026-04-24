import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAgentIdentityCache,
  peekAgentName,
  requestAgent,
  seedAgents,
} from "@/lib/agent-identity-cache";
import type { AgentSummary } from "@/lib/types";
import { AgentType, ClientType } from "@/lib/agent-identity";

// The cache is module-singleton state. __resetAgentIdentityCache keeps
// tests isolated so the in-flight / hit / miss transitions don't leak
// between cases.

function mkAgent(partial: Partial<AgentSummary>): AgentSummary {
  return {
    agent_id: partial.agent_id ?? "00000000-0000-0000-0000-000000000000",
    agent_name: partial.agent_name ?? "unknown@unknown",
    agent_type: partial.agent_type ?? AgentType.Production,
    client_type: partial.client_type ?? ClientType.FlightdeckSensor,
    user: partial.user ?? "u",
    hostname: partial.hostname ?? "h",
    first_seen_at: partial.first_seen_at ?? "",
    last_seen_at: partial.last_seen_at ?? "",
    total_sessions: partial.total_sessions ?? 0,
    total_tokens: partial.total_tokens ?? 0,
    state: partial.state ?? "",
  };
}

const originalFetch = globalThis.fetch;

describe("agent-identity-cache", () => {
  beforeEach(() => {
    __resetAgentIdentityCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetAgentIdentityCache();
  });

  it("seedAgents populates the cache so peekAgentName resolves without fetch", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    seedAgents([mkAgent({ agent_id: uuid, agent_name: "seeded-name" })]);
    expect(peekAgentName(uuid)).toBe("seeded-name");
  });

  it("requestAgent hits /v1/agents/{id} and stores the result", async () => {
    const uuid = "22222222-3333-4444-5555-666666666666";
    const spy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(mkAgent({ agent_id: uuid, agent_name: "fetched-name" })),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    requestAgent(uuid);
    // Pending after the call sets up — peek returns null while the
    // promise is in flight so the UI still falls back to the prefix.
    expect(peekAgentName(uuid)).toBeNull();
    // Flush the microtask queue so the .then() runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(peekAgentName(uuid)).toBe("fetched-name");
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain(`/v1/agents/${uuid}`);
  });

  it("requestAgent pins a miss on 404 without throwing", async () => {
    const uuid = "33333333-4444-5555-6666-777777777777";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;

    requestAgent(uuid);
    await new Promise((r) => setTimeout(r, 0));
    expect(peekAgentName(uuid)).toBeNull();
    // Second call is a no-op — the miss is cached, no extra fetch.
    requestAgent(uuid);
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("seeded hits suppress a later requestAgent fetch", async () => {
    const uuid = "44444444-5555-6666-7777-888888888888";
    seedAgents([mkAgent({ agent_id: uuid, agent_name: "seeded-first" })]);
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    requestAgent(uuid);
    expect(spy).not.toHaveBeenCalled();
    expect(peekAgentName(uuid)).toBe("seeded-first");
  });
});
