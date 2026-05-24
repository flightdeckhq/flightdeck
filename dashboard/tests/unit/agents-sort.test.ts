import { describe, it, expect } from "vitest";
import {
  type SortState,
  deriveFamilyDescendantSet,
  paginateFamilies,
  sortAgents,
  sortAgentsWithFamilies,
  toggleSort,
} from "@/lib/agents-sort";
import type {
  AgentSummary,
  AgentSummaryResponse,
  RecentSession,
} from "@/lib/types";
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

// Family-grouping helpers. ``recent_sessions[].parent_session_id``
// is the authoritative linkage source (per-agent backfilled, not
// time-windowed like the fleet-store flavors) so a child whose
// parent's sessions fall outside any wall-clock window still
// groups with its parent on /agents.
function mkRecentSession(
  sessionId: string,
  parentSessionId?: string,
): RecentSession {
  return {
    session_id: sessionId,
    flavor: "f",
    agent_type: "coding",
    state: "active",
    started_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-14T12:00:00Z",
    tokens_used: 0,
    capture_enabled: false,
    parent_session_id: parentSessionId,
  };
}

describe("deriveFamilyDescendantSet", () => {
  it("marks a child whose parent's session is present", () => {
    const agents = [
      mkAgent({
        agent_id: "p",
        recent_sessions: [mkRecentSession("s-p")],
      }),
      mkAgent({
        agent_id: "c",
        recent_sessions: [mkRecentSession("s-c", "s-p")],
      }),
    ];
    const set = deriveFamilyDescendantSet(agents);
    expect(set.has("p")).toBe(false);
    expect(set.has("c")).toBe(true);
  });

  it("treats an orphan child (parent not in list) as a root", () => {
    // The parent's session_id is referenced but the parent agent
    // is NOT in the supplied ``agents`` slice — common when a
    // filter hides the parent. The child must remain visible at
    // its own sort position as a single-row family, NOT silently
    // grouped under an absent root.
    const agents = [
      mkAgent({
        agent_id: "c-orphan",
        recent_sessions: [mkRecentSession("s-c", "s-absent")],
      }),
    ];
    const set = deriveFamilyDescendantSet(agents);
    expect(set.has("c-orphan")).toBe(false);
  });

  it("handles depth-2 chains (grandparent → parent → leaf)", () => {
    const agents = [
      mkAgent({
        agent_id: "g",
        recent_sessions: [mkRecentSession("s-g")],
      }),
      mkAgent({
        agent_id: "p",
        recent_sessions: [mkRecentSession("s-p", "s-g")],
      }),
      mkAgent({
        agent_id: "l",
        recent_sessions: [mkRecentSession("s-l", "s-p")],
      }),
    ];
    const set = deriveFamilyDescendantSet(agents);
    expect(set.has("g")).toBe(false);
    expect(set.has("p")).toBe(true);
    expect(set.has("l")).toBe(true);
  });
});

describe("sortAgentsWithFamilies", () => {
  // Reusable helper — agent with explicit recent_sessions wiring.
  function mkAgentWithParent(
    agentId: string,
    parentId: string | null,
    tokens: number,
    state: AgentSummary["state"] = "active",
  ): AgentSummary {
    const ownSession = `s-${agentId}`;
    const parentSession = parentId ? `s-${parentId}` : undefined;
    return mkAgent({
      agent_id: agentId,
      agent_name: agentId,
      total_tokens: tokens,
      state,
      recent_sessions: [mkRecentSession(ownSession, parentSession)],
    });
  }

  it("places a child directly after its parent under EVERY sortable column + direction", () => {
    // Parent has lower tokens than its child. A naive
    // per-agent sort under tokens DESC would float the child
    // ABOVE the parent. The family-grouped sort keeps the
    // child directly under its parent regardless.
    const parent = mkAgentWithParent("p", null, 100);
    const child = mkAgentWithParent("c", "p", 9999);
    const lone = mkAgentWithParent("z", null, 50);
    const summaries = new Map<string, AgentSummaryResponse>([
      ["p", mkSummary("p", 100)],
      ["c", mkSummary("c", 9999)],
      ["z", mkSummary("z", 50)],
    ]);

    for (const direction of ["asc", "desc"] as const) {
      for (const column of [
        "agent_name",
        "tokens_7d",
        "last_seen_at",
        "state",
      ] as const) {
        const result = sortAgentsWithFamilies(
          [parent, child, lone],
          summaries,
          { column, direction },
        );
        const ids = result.map((a) => a.agent_id);
        // Child must immediately follow parent.
        const pIdx = ids.indexOf("p");
        const cIdx = ids.indexOf("c");
        expect(cIdx).toBe(pIdx + 1);
      }
    }
  });

  it("orders families by the root's sort key + direction (lone agents interleave)", () => {
    // tokens DESC: lone "z" (50) sorts AFTER parent "p" (100)
    // even though child "c" (9999) is the highest individual.
    // The family-of-p sorts by p's key (100), beating z (50).
    const parent = mkAgentWithParent("p", null, 100);
    const child = mkAgentWithParent("c", "p", 9999);
    const loneZ = mkAgentWithParent("z", null, 50);
    const loneY = mkAgentWithParent("y", null, 30);
    const summaries = new Map<string, AgentSummaryResponse>([
      ["p", mkSummary("p", 100)],
      ["c", mkSummary("c", 9999)],
      ["z", mkSummary("z", 50)],
      ["y", mkSummary("y", 30)],
    ]);
    const result = sortAgentsWithFamilies(
      [parent, child, loneZ, loneY],
      summaries,
      { column: "tokens_7d", direction: "desc" },
    );
    // Expected order: p (100, root) → c (9999, child of p) →
    // z (50, lone) → y (30, lone). Family-of-p as a unit
    // outranks both lones; lones sort among themselves DESC.
    expect(result.map((a) => a.agent_id)).toEqual(["p", "c", "z", "y"]);
  });

  it("orders multiple children within a family by their own keys", () => {
    const parent = mkAgentWithParent("p", null, 100);
    const childA = mkAgentWithParent("c-a", "p", 500);
    const childB = mkAgentWithParent("c-b", "p", 1500);
    const summaries = new Map<string, AgentSummaryResponse>([
      ["p", mkSummary("p", 100)],
      ["c-a", mkSummary("c-a", 500)],
      ["c-b", mkSummary("c-b", 1500)],
    ]);
    const result = sortAgentsWithFamilies(
      [parent, childA, childB],
      summaries,
      { column: "tokens_7d", direction: "desc" },
    );
    // p first; then c-b (1500 > 500) under DESC; then c-a.
    expect(result.map((a) => a.agent_id)).toEqual(["p", "c-b", "c-a"]);
  });

  it("orphan child renders as a single-row family at its own sort position", () => {
    // Child references a parent NOT in the list. Must render
    // alongside lone agents using its OWN sort key (not
    // grouped under an absent root).
    const lone = mkAgentWithParent("a-lone", null, 200);
    const orphan = mkAgentWithParent("o", "absent", 1000);
    const summaries = new Map<string, AgentSummaryResponse>([
      ["a-lone", mkSummary("a-lone", 200)],
      ["o", mkSummary("o", 1000)],
    ]);
    const result = sortAgentsWithFamilies([lone, orphan], summaries, {
      column: "tokens_7d",
      direction: "desc",
    });
    // tokens DESC: orphan (1000) above lone (200) — orphan is
    // its own root family.
    expect(result.map((a) => a.agent_id)).toEqual(["o", "a-lone"]);
  });

  it("cyclic parent linkage terminates without infinite loop", () => {
    // Defensive guard. The wire contract is acyclic — a child's
    // ``parent_session_id`` never points back at one of its own
    // descendants — but bugs upstream could violate that. The
    // ``findRoot`` walker carries a ``visited`` set; if it sees
    // a node it has already walked, it returns rather than
    // looping. Construct the smallest possible cycle (A → B → A)
    // and assert the sort completes without throwing or timing
    // out.
    const a = mkAgent({
      agent_id: "a",
      agent_name: "a",
      recent_sessions: [mkRecentSession("s-a", "s-b")],
    });
    const b = mkAgent({
      agent_id: "b",
      agent_name: "b",
      recent_sessions: [mkRecentSession("s-b", "s-a")],
    });
    const summaries = new Map<string, AgentSummaryResponse>([
      ["a", mkSummary("a", 100)],
      ["b", mkSummary("b", 200)],
    ]);
    expect(() =>
      sortAgentsWithFamilies([a, b], summaries, {
        column: "tokens_7d",
        direction: "desc",
      }),
    ).not.toThrow();
    // Both rows still surface — the cycle defence collapses
    // them into one family rather than dropping either.
    const result = sortAgentsWithFamilies([a, b], summaries, {
      column: "tokens_7d",
      direction: "desc",
    });
    expect(result.map((r) => r.agent_id).sort()).toEqual(["a", "b"]);
  });

  it("depth-2 middle (grandparent → parent → leaf) flattens under root", () => {
    const g = mkAgentWithParent("g", null, 100);
    const p = mkAgentWithParent("p", "g", 200);
    const l = mkAgentWithParent("l", "p", 300);
    const summaries = new Map<string, AgentSummaryResponse>([
      ["g", mkSummary("g", 100)],
      ["p", mkSummary("p", 200)],
      ["l", mkSummary("l", 300)],
    ]);
    const result = sortAgentsWithFamilies([g, p, l], summaries, {
      column: "tokens_7d",
      direction: "desc",
    });
    // Family root g sorts first; descendants p and l follow,
    // sorted among themselves by tokens DESC (l=300 > p=200).
    expect(result.map((a) => a.agent_id)).toEqual(["g", "l", "p"]);
  });
});

describe("paginateFamilies", () => {
  it("packs multiple families on one page when they fit", () => {
    const a = mkAgent({ agent_id: "a" });
    const b = mkAgent({ agent_id: "b" });
    const c = mkAgent({ agent_id: "c" });
    // All three are lone roots — no descendants.
    const pages = paginateFamilies([a, b, c], new Set<string>(), 10);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.map((x) => x.agent_id)).toEqual(["a", "b", "c"]);
  });

  it("never splits a family across a page boundary", () => {
    // Family of 3 (root + 2 children) + lone — pageSize 3
    // means the family fills page 1 and the lone goes to page 2,
    // even though page 1 had spare slots.
    const p = mkAgent({ agent_id: "p" });
    const c1 = mkAgent({ agent_id: "c1" });
    const c2 = mkAgent({ agent_id: "c2" });
    const z = mkAgent({ agent_id: "z" });
    const descendants = new Set(["c1", "c2"]);
    // Fixture would split if pageSize=3 placed the page slice
    // mid-family at position 3 — the family-respecting paginator
    // pushes the lone to page 2 instead.
    const pages = paginateFamilies([p, c1, c2, z], descendants, 3);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.map((x) => x.agent_id)).toEqual(["p", "c1", "c2"]);
    expect(pages[1]!.map((x) => x.agent_id)).toEqual(["z"]);
  });

  it("oversized family lands on its own page (never infinite-loops)", () => {
    // Family larger than pageSize — defensive branch. Should
    // emit a single oversized page rather than splitting or
    // looping.
    const p = mkAgent({ agent_id: "p" });
    const c1 = mkAgent({ agent_id: "c1" });
    const c2 = mkAgent({ agent_id: "c2" });
    const c3 = mkAgent({ agent_id: "c3" });
    const descendants = new Set(["c1", "c2", "c3"]);
    const pages = paginateFamilies([p, c1, c2, c3], descendants, 2);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.map((x) => x.agent_id)).toEqual(["p", "c1", "c2", "c3"]);
  });

  it("empty input returns []", () => {
    expect(paginateFamilies([], new Set<string>(), 10)).toEqual([]);
  });
});
