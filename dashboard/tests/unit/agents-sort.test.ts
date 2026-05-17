import { describe, it, expect } from "vitest";
import {
  type SortState,
  sortAgents,
  toggleSort,
} from "@/lib/agents-sort";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";
import { ClientType } from "@/lib/agent-identity";

function mkAgent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: over.agent_id ?? "agent-1",
    agent_name: "a",
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    first_seen_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-14T12:00:00Z",
    total_sessions: 1,
    total_tokens: 100,
    state: "active",
    topology: "lone",
    ...over,
  };
}

function mkSummary(
  agentId: string,
  tokens: number,
  errors = 0,
): AgentSummaryResponse {
  return {
    agent_id: agentId,
    period: "7d",
    bucket: "day",
    totals: {
      tokens,
      errors,
      sessions: 1,
      cost_usd: 0,
      latency_p50_ms: 0,
      latency_p95_ms: 0,
    },
    series: [],
  };
}

describe("toggleSort", () => {
  it("flips direction when the same column is clicked", () => {
    const next = toggleSort({ column: "tokens_7d", direction: "desc" }, "tokens_7d");
    expect(next.direction).toBe("asc");
  });

  it("resets to default direction (desc) on a different numeric column", () => {
    const next = toggleSort({ column: "tokens_7d", direction: "asc" }, "errors_7d");
    expect(next).toEqual({ column: "errors_7d", direction: "desc" });
  });

  it("resets to default direction (asc) on agent_name column", () => {
    const next = toggleSort({ column: "tokens_7d", direction: "asc" }, "agent_name");
    expect(next).toEqual({ column: "agent_name", direction: "asc" });
  });
});

describe("sortAgents", () => {
  const summaries = new Map<string, AgentSummaryResponse>();
  summaries.set("a", mkSummary("a", 100));
  summaries.set("b", mkSummary("b", 500));
  summaries.set("c", mkSummary("c", 300));

  it("sorts numeric column DESC", () => {
    const sort: SortState = { column: "tokens_7d", direction: "desc" };
    const result = sortAgents(
      [mkAgent({ agent_id: "a" }), mkAgent({ agent_id: "b" }), mkAgent({ agent_id: "c" })],
      summaries,
      sort,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["b", "c", "a"]);
  });

  it("sorts numeric column ASC", () => {
    const sort: SortState = { column: "tokens_7d", direction: "asc" };
    const result = sortAgents(
      [mkAgent({ agent_id: "a" }), mkAgent({ agent_id: "b" }), mkAgent({ agent_id: "c" })],
      summaries,
      sort,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["a", "c", "b"]);
  });

  it("breaks ties by agent_id ASC", () => {
    const ties = new Map<string, AgentSummaryResponse>();
    ties.set("b", mkSummary("b", 100));
    ties.set("a", mkSummary("a", 100));
    const sort: SortState = { column: "tokens_7d", direction: "desc" };
    const result = sortAgents(
      [mkAgent({ agent_id: "b" }), mkAgent({ agent_id: "a" })],
      ties,
      sort,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["a", "b"]);
  });

  it("treats missing summary as zero", () => {
    const sort: SortState = { column: "tokens_7d", direction: "desc" };
    const partial = new Map<string, AgentSummaryResponse>();
    partial.set("b", mkSummary("b", 500));
    const result = sortAgents(
      [mkAgent({ agent_id: "a" }), mkAgent({ agent_id: "b" })],
      partial,
      sort,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["b", "a"]);
  });

  it("does not mutate input", () => {
    const input = [
      mkAgent({ agent_id: "a" }),
      mkAgent({ agent_id: "b" }),
    ];
    const before = input.map((a) => a.agent_id);
    sortAgents(input, summaries, { column: "tokens_7d", direction: "asc" });
    expect(input.map((a) => a.agent_id)).toEqual(before);
  });

  it("sorts state column with active first under DESC", () => {
    const sort: SortState = { column: "state", direction: "desc" };
    const result = sortAgents(
      [
        mkAgent({ agent_id: "closed-1", state: "closed" }),
        mkAgent({ agent_id: "active-1", state: "active" }),
        mkAgent({ agent_id: "lost-1", state: "lost" }),
      ],
      new Map(),
      sort,
    );
    expect(result[0]!.agent_id).toBe("active-1");
    expect(result[2]!.agent_id).toBe("lost-1");
  });
});
