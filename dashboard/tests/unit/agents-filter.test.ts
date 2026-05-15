import { describe, it, expect } from "vitest";
import {
  type AgentFilterState,
  agentFrameworks,
  deriveFrameworkOptions,
  EMPTY_FILTER,
  filterAgents,
  toggleFilterValue,
} from "@/lib/agents-filter";
import type { AgentSummary, RecentSession } from "@/lib/types";
import { ClientType } from "@/lib/agent-identity";

function mkRecentSession(
  over: Partial<RecentSession> = {},
): RecentSession {
  return {
    session_id: "s",
    flavor: "f",
    agent_type: "coding",
    state: "closed",
    started_at: "2026-05-14T00:00:00Z",
    last_seen_at: "2026-05-14T00:00:00Z",
    tokens_used: 0,
    capture_enabled: false,
    ...over,
  };
}

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

describe("filterAgents", () => {
  it("returns every agent when no filter is active", () => {
    const agents = [mkAgent({ agent_id: "a" }), mkAgent({ agent_id: "b" })];
    expect(filterAgents(agents, EMPTY_FILTER)).toHaveLength(2);
  });

  it("narrows by state", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      states: new Set(["active"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", state: "active" }),
        mkAgent({ agent_id: "b", state: "closed" }),
      ],
      filter,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["a"]);
  });

  it("narrows by agent_type", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      agentTypes: new Set(["production"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", agent_type: "coding" }),
        mkAgent({ agent_id: "b", agent_type: "production" }),
      ],
      filter,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["b"]);
  });

  it("narrows by client_type", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      clientTypes: new Set([ClientType.FlightdeckSensor]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", client_type: ClientType.ClaudeCode }),
        mkAgent({ agent_id: "b", client_type: ClientType.FlightdeckSensor }),
      ],
      filter,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["b"]);
  });

  it("ANDs across dimensions", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      states: new Set(["active"]),
      agentTypes: new Set(["coding"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", state: "active", agent_type: "coding" }),
        mkAgent({ agent_id: "b", state: "active", agent_type: "production" }),
        mkAgent({ agent_id: "c", state: "closed", agent_type: "coding" }),
      ],
      filter,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["a"]);
  });

  it("ORs within a dimension", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      states: new Set(["active", "idle"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", state: "active" }),
        mkAgent({ agent_id: "b", state: "idle" }),
        mkAgent({ agent_id: "c", state: "closed" }),
      ],
      filter,
    );
    expect(result.map((a) => a.agent_id).sort()).toEqual(["a", "b"]);
  });

  it("narrows by framework", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      frameworks: new Set(["crewai"]),
    };
    const result = filterAgents(
      [
        mkAgent({
          agent_id: "a",
          recent_sessions: [mkRecentSession({ framework: "langchain" })],
        }),
        mkAgent({
          agent_id: "b",
          recent_sessions: [mkRecentSession({ framework: "crewai" })],
        }),
        mkAgent({
          agent_id: "c",
          recent_sessions: [mkRecentSession({ framework: null })],
        }),
      ],
      filter,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["b"]);
  });
});

describe("agentFrameworks", () => {
  it("returns an empty array when the agent has no recent sessions", () => {
    expect(agentFrameworks(mkAgent())).toEqual([]);
  });

  it("returns an empty array when every recent session is direct-SDK", () => {
    const agent = mkAgent({
      recent_sessions: [
        mkRecentSession({ framework: null }),
        mkRecentSession({ framework: undefined }),
      ],
    });
    expect(agentFrameworks(agent)).toEqual([]);
  });

  it("returns the distinct, sorted framework set", () => {
    const agent = mkAgent({
      recent_sessions: [
        mkRecentSession({ framework: "langchain" }),
        mkRecentSession({ framework: "crewai" }),
        mkRecentSession({ framework: "langchain" }),
        mkRecentSession({ framework: null }),
      ],
    });
    expect(agentFrameworks(agent)).toEqual(["crewai", "langchain"]);
  });
});

describe("deriveFrameworkOptions", () => {
  it("returns an empty array when no agent carries a framework", () => {
    expect(deriveFrameworkOptions([mkAgent(), mkAgent()])).toEqual([]);
  });

  it("unions frameworks across the visible agent set, sorted", () => {
    const agents = [
      mkAgent({
        agent_id: "a",
        recent_sessions: [mkRecentSession({ framework: "langgraph" })],
      }),
      mkAgent({
        agent_id: "b",
        recent_sessions: [
          mkRecentSession({ framework: "crewai" }),
          mkRecentSession({ framework: "langgraph" }),
        ],
      }),
    ];
    expect(deriveFrameworkOptions(agents)).toEqual(["crewai", "langgraph"]);
  });
});

describe("toggleFilterValue", () => {
  it("adds a missing value", () => {
    const next = toggleFilterValue(new Set<string>(), "active");
    expect(next.has("active")).toBe(true);
  });

  it("removes an existing value", () => {
    const next = toggleFilterValue(new Set(["active"]), "active");
    expect(next.has("active")).toBe(false);
  });

  it("returns a new Set (referential change for React)", () => {
    const input = new Set(["active"]);
    const output = toggleFilterValue(input, "idle");
    expect(output).not.toBe(input);
  });
});
