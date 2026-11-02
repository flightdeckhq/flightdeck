import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  DIRECTIVE_COUNT_HEADER,
  createDirective,
  triggerCustomDirective,
} from "@/lib/api";

// POST /v1/directives answers with the last directive row it created
// and, in X-Directive-Count, how many it created: the number of runs a
// stop or a custom directive addressed to an agent reached. A rejection
// carries the API's reason, which the Fleet and run-drawer controls
// show the operator.

const originalFetch = globalThis.fetch;

const ROW = {
  id: "dir-1",
  session_id: "s-3",
  flavor: null,
  action: "shutdown",
  reason: "manual_fleet_kill",
  degrade_to: null,
  grace_period_ms: 5000,
  issued_by: "dashboard",
  issued_at: "2026-11-02T08:00:00Z",
  delivered_at: null,
};

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("createDirective", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the agent-scoped stop and returns the row with the API's count", async () => {
    const spy = answer(201, ROW, { [DIRECTIVE_COUNT_HEADER]: "3" });
    const created = await createDirective({
      action: "shutdown",
      agent_id: "aaaaaaaa-0000-4000-8000-00000000000a",
      reason: "manual_fleet_kill",
      grace_period_ms: 5000,
    });
    expect(created).toEqual({ directive: ROW, count: 3 });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/directives$/);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      action: "shutdown",
      agent_id: "aaaaaaaa-0000-4000-8000-00000000000a",
      reason: "manual_fleet_kill",
      grace_period_ms: 5000,
    });
  });

  it("reports no count when the header is missing or not a count", async () => {
    answer(201, ROW);
    expect((await createDirective({ action: "shutdown", session_id: "s-1" })).count).toBeNull();
    answer(201, ROW, { [DIRECTIVE_COUNT_HEADER]: "many" });
    expect((await createDirective({ action: "shutdown", session_id: "s-1" })).count).toBeNull();
  });

  it("throws the API's reason on a rejection", async () => {
    answer(404, { error: "no live session of this agent can take this directive" });
    const err = await createDirective({
      action: "shutdown",
      agent_id: "aaaaaaaa-0000-4000-8000-00000000000a",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe(
      "no live session of this agent can take this directive",
    );
  });
});

describe("triggerCustomDirective", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the count for a directive addressed to an agent", async () => {
    const spy = answer(201, { ...ROW, action: "custom" }, { [DIRECTIVE_COUNT_HEADER]: "2" });
    const created = await triggerCustomDirective({
      action: "custom",
      directive_name: "rotate",
      fingerprint: "fp-rotate",
      agent_id: "aaaaaaaa-0000-4000-8000-00000000000a",
      flavor: "research-agent",
    });
    expect(created.count).toBe(2);
    expect(JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      agent_id: "aaaaaaaa-0000-4000-8000-00000000000a",
      flavor: "research-agent",
    });
  });

  it("throws the API's reason on a rejection", async () => {
    answer(422, { error: "unknown directive fingerprint" });
    await expect(
      triggerCustomDirective({
        action: "custom",
        directive_name: "ghost",
        fingerprint: "fp-ghost",
        session_id: "s-1",
      }),
    ).rejects.toThrow("unknown directive fingerprint");
  });
});
