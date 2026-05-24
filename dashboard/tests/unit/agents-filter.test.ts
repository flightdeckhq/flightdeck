import { describe, it, expect } from "vitest";
import {
  type AgentFilterState,
  agentFrameworks,
  agentMatchesSearch,
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

// Polish Batch 2 Fix 4 — the /agents page has a client-side
// free-text search bar. `agentMatchesSearch` is the predicate:
// case-insensitive substring across the agent name, agent_type,
// client_type, the agent's frameworks, and the models on its
// recent sessions. `filterAgents` ANDs the search against the chip
// dimensions.
describe("agentMatchesSearch (Fix 4)", () => {
  it("matches every agent on an empty query", () => {
    expect(agentMatchesSearch(mkAgent(), "")).toBe(true);
  });

  it("matches every agent on a whitespace-only query", () => {
    expect(agentMatchesSearch(mkAgent(), "   ")).toBe(true);
  });

  it("narrows by agent_name (case-insensitive substring)", () => {
    const agent = mkAgent({ agent_name: "Checkout-Bot" });
    expect(agentMatchesSearch(agent, "checkout")).toBe(true);
    expect(agentMatchesSearch(agent, "CHECKOUT")).toBe(true);
    expect(agentMatchesSearch(agent, "out-bo")).toBe(true);
    expect(agentMatchesSearch(agent, "research")).toBe(false);
  });

  it("narrows by agent_type", () => {
    expect(
      agentMatchesSearch(mkAgent({ agent_type: "production" }), "prod"),
    ).toBe(true);
    expect(
      agentMatchesSearch(mkAgent({ agent_type: "coding" }), "prod"),
    ).toBe(false);
  });

  it("narrows by client_type", () => {
    // ClientType.ClaudeCode === "claude_code"
    expect(
      agentMatchesSearch(
        mkAgent({ client_type: ClientType.ClaudeCode }),
        "claude_code",
      ),
    ).toBe(true);
    expect(
      agentMatchesSearch(
        mkAgent({ client_type: ClientType.FlightdeckSensor }),
        "claude_code",
      ),
    ).toBe(false);
  });

  it("narrows by a framework on the agent's recent sessions", () => {
    const agent = mkAgent({
      recent_sessions: [
        mkRecentSession({ framework: "langgraph" }),
        mkRecentSession({ framework: "crewai" }),
      ],
    });
    expect(agentMatchesSearch(agent, "langgraph")).toBe(true);
    expect(agentMatchesSearch(agent, "crew")).toBe(true);
    expect(agentMatchesSearch(agent, "autogen")).toBe(false);
  });

  it("narrows by a model on the agent's recent sessions", () => {
    const agent = mkAgent({
      recent_sessions: [mkRecentSession({ model: "claude-sonnet-4-5" })],
    });
    expect(agentMatchesSearch(agent, "sonnet")).toBe(true);
    expect(agentMatchesSearch(agent, "gpt-4o")).toBe(false);
  });

  it("survives an agent with no recent sessions", () => {
    const agent = mkAgent({ agent_name: "lone-agent" });
    expect(agentMatchesSearch(agent, "lone")).toBe(true);
    expect(agentMatchesSearch(agent, "sonnet")).toBe(false);
  });
});

describe("filterAgents — free-text search dimension (Fix 4)", () => {
  it("narrows the agent list by the search field", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      search: "checkout",
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", agent_name: "checkout-bot" }),
        mkAgent({ agent_id: "b", agent_name: "research-agent" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("returns every agent when search is the empty string", () => {
    expect(
      filterAgents(
        [mkAgent({ agent_id: "a" }), mkAgent({ agent_id: "b" })],
        { ...EMPTY_FILTER, search: "" },
      ),
    ).toHaveLength(2);
  });

  it("ANDs the search with chip dimensions", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      states: new Set(["active"]),
      search: "checkout",
    };
    const result = filterAgents(
      [
        // matches both — survives
        mkAgent({
          agent_id: "a",
          agent_name: "checkout-bot",
          state: "active",
        }),
        // matches search but wrong state
        mkAgent({
          agent_id: "b",
          agent_name: "checkout-worker",
          state: "closed",
        }),
        // matches state but not search
        mkAgent({
          agent_id: "c",
          agent_name: "research-agent",
          state: "active",
        }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("EMPTY_FILTER.search defaults to an empty string", () => {
    expect(EMPTY_FILTER.search).toBe("");
  });
});

// ---- runtime-context facets ----

describe("filterAgents — runtime-context dimensions", () => {
  it("narrows by hostname (agent-table column, single-valued)", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      hostnames: new Set(["worker-7"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", hostname: "worker-7" }),
        mkAgent({ agent_id: "b", hostname: "worker-2" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by user (agent-table column, single-valued)", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      users: new Set(["alice"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", user: "alice" }),
        mkAgent({ agent_id: "b", user: "bob" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by os (latest-session context, nullable)", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      oss: new Set(["Linux"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", os: "Linux" }),
        mkAgent({ agent_id: "b", os: "Darwin" }),
        mkAgent({ agent_id: "c", os: null }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by arch", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      archs: new Set(["arm64"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", arch: "arm64" }),
        mkAgent({ agent_id: "b", arch: "x86_64" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by git_branch", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      gitBranches: new Set(["main"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", git_branch: "main" }),
        mkAgent({ agent_id: "b", git_branch: "feature-x" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by git_repo", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      gitRepos: new Set(["flightdeck"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", git_repo: "flightdeck" }),
        mkAgent({ agent_id: "b", git_repo: "other" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by orchestration", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      orchestrations: new Set(["kubernetes"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", orchestration: "kubernetes" }),
        mkAgent({ agent_id: "b", orchestration: "docker" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by python_version", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      pythonVersions: new Set(["3.12"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", python_version: "3.12" }),
        mkAgent({ agent_id: "b", python_version: "3.10" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("narrows by process_name", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      processNames: new Set(["main.py"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", process_name: "main.py" }),
        mkAgent({ agent_id: "b", process_name: "worker.py" }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("an agent with a null runtime-context field never matches a non-empty chip filter for that dim", () => {
    // A nullable runtime-context field (e.g. os=null) on an agent means the
    // latest session's context didn't carry that key. Searching
    // for any value on that dim must exclude the agent — operators
    // filtering by "os=Linux" should not see an agent whose latest
    // session has no os recorded at all.
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      oss: new Set(["Linux"]),
    };
    const result = filterAgents(
      [
        mkAgent({ agent_id: "a", os: null }),
        mkAgent({ agent_id: "b", os: undefined }),
      ],
      filter,
    );
    expect(result).toHaveLength(0);
  });

  it("ANDs across multiple runtime-context dims (os + git_branch)", () => {
    const filter: AgentFilterState = {
      ...EMPTY_FILTER,
      oss: new Set(["Linux"]),
      gitBranches: new Set(["main"]),
    };
    const result = filterAgents(
      [
        // matches both — survives
        mkAgent({
          agent_id: "a",
          os: "Linux",
          git_branch: "main",
        }),
        // wrong branch
        mkAgent({
          agent_id: "b",
          os: "Linux",
          git_branch: "feature-x",
        }),
        // wrong OS
        mkAgent({
          agent_id: "c",
          os: "Darwin",
          git_branch: "main",
        }),
      ],
      filter,
    );
    expect(result.map((x) => x.agent_id)).toEqual(["a"]);
  });

  it("agentMatchesSearch folds runtime-context fields into the haystack", () => {
    // A free-text search for "Linux" should match an agent whose
    // latest session ran on Linux even without the user opening
    // the OS sidebar chip — the search bar is the omni-search
    // entry point.
    expect(
      agentMatchesSearch(
        mkAgent({ agent_id: "a", os: "Linux", arch: "arm64" }),
        "Linux",
      ),
    ).toBe(true);
    expect(
      agentMatchesSearch(
        mkAgent({
          agent_id: "b",
          os: "Linux",
          git_branch: "fix/auth-bug",
        }),
        "auth-bug",
      ),
    ).toBe(true);
    expect(
      agentMatchesSearch(
        mkAgent({ agent_id: "c", os: null, arch: null }),
        "Linux",
      ),
    ).toBe(false);
  });
});
