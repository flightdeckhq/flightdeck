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
  FlavorSummary,
  RecentSession,
  Session,
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
  parentAgentId?: string,
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
    parent_agent_id: parentAgentId,
  };
}

// Fleet-store flavor builder for the windowed-parent regression
// test. The flavor key is the agent_id under the D115 swimlane
// scheme, so a parent that has spawned 5+ recent sessions still
// surfaces ALL of them under its flavor's ``sessions`` list (the
// /v1/sessions window cap is ~200 across all agents, not 5 per
// agent like RecentSessionsPerAgent on /v1/fleet).
function mkSession(
  sessionId: string,
  parentSessionId?: string | null,
): Session {
  return {
    session_id: sessionId,
    flavor: "f",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-14T12:00:00Z",
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: parentSessionId ?? null,
  };
}

function mkFlavor(agentId: string, sessions: Session[]): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: sessions.filter((s) => s.state === "active").length,
    tokens_used_total: sessions.reduce((sum, s) => sum + s.tokens_used, 0),
    sessions,
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

  // ---- explicit-row-order coverage --------------------------------------
  // The supervisor's hotfix brief calls out three scenarios where a
  // child must not float away from its parent under sort. Each test
  // below asserts the FULL row sequence (not just "child immediately
  // follows parent") so a regression that breaks the order
  // anywhere — even mid-family — surfaces immediately.

  it("STATUS DESC: family stays at parent's rank even when children have different states", () => {
    // Parent is active; one child idle, one child closed. Under a
    // naive per-agent sort, the active parent would lead, then the
    // active lone, then the idle child, then the closed child — the
    // children would float away. Family-grouped sort keeps the whole
    // family at the parent's (active) rank.
    const parent = mkAgentWithParent("p", null, 0, "active");
    const childIdle = mkAgentWithParent("c-idle", "p", 0, "idle");
    const childClosed = mkAgentWithParent("c-closed", "p", 0, "closed");
    const loneActive = mkAgentWithParent("z-lone", null, 0, "active");
    const loneClosed = mkAgentWithParent("y-lone", null, 0, "closed");
    const summaries = new Map<string, AgentSummaryResponse>();
    const result = sortAgentsWithFamilies(
      [childClosed, loneClosed, parent, childIdle, loneActive],
      summaries,
      { column: "state", direction: "desc" },
    );
    // Active families first. Among them, the agent_id tie-breaker
    // ranks "p" < "z-lone". Within the family of p, descendants
    // sort by state DESC: idle (4) > closed (2), then agent_id ASC
    // settles ties. Closed lone family lands last.
    expect(result.map((a) => a.agent_id)).toEqual([
      "p",
      "c-idle",
      "c-closed",
      "z-lone",
      "y-lone",
    ]);
  });

  it("AGENT name ASC: family stays together at parent's name position", () => {
    // Children names ("b-doc", "a-plan") would naturally sort BEFORE
    // the parent ("m-omria") under name ASC. Family grouping
    // overrides this so children move with their parent.
    const parent = mkAgent({
      agent_id: "p",
      agent_name: "m-omria",
      recent_sessions: [mkRecentSession("s-p")],
    });
    const childDoc = mkAgent({
      agent_id: "c-doc",
      agent_name: "b-doc",
      recent_sessions: [mkRecentSession("s-cdoc", "s-p")],
    });
    const childPlan = mkAgent({
      agent_id: "c-plan",
      agent_name: "a-plan",
      recent_sessions: [mkRecentSession("s-cplan", "s-p")],
    });
    const loneA = mkAgent({
      agent_id: "lone-a",
      agent_name: "a-support",
      recent_sessions: [mkRecentSession("s-la")],
    });
    const loneZ = mkAgent({
      agent_id: "lone-z",
      agent_name: "z-research",
      recent_sessions: [mkRecentSession("s-lz")],
    });
    const result = sortAgentsWithFamilies(
      [parent, childDoc, childPlan, loneA, loneZ],
      new Map(),
      { column: "agent_name", direction: "asc" },
    );
    // Families sort by root name ASC: "a-support" (lone-a), then
    // "m-omria" (parent + its children), then "z-research" (lone-z).
    // Children inside the omria family sort by their own name ASC:
    // "a-plan" (c-plan) before "b-doc" (c-doc).
    expect(result.map((a) => a.agent_id)).toEqual([
      "lone-a",
      "p",
      "c-plan",
      "c-doc",
      "lone-z",
    ]);
  });

  it("TOKENS_7D DESC: family stays at parent's rank even when a child has higher tokens than its parent", () => {
    // Child has higher tokens than parent AND higher tokens than
    // every lone agent. A naive per-agent sort would float the
    // child to the very top. Family-grouped sort keeps it under its
    // (lower-tokens) parent.
    const parent = mkAgentWithParent("p", null, 100);
    const childHigh = mkAgentWithParent("c-high", "p", 9999);
    const childLow = mkAgentWithParent("c-low", "p", 50);
    const loneHigh = mkAgentWithParent("z-lone", null, 800);
    const loneLow = mkAgentWithParent("y-lone", null, 30);
    const summaries = new Map<string, AgentSummaryResponse>([
      ["p", mkSummary("p", 100)],
      ["c-high", mkSummary("c-high", 9999)],
      ["c-low", mkSummary("c-low", 50)],
      ["z-lone", mkSummary("z-lone", 800)],
      ["y-lone", mkSummary("y-lone", 30)],
    ]);
    const result = sortAgentsWithFamilies(
      [parent, childHigh, childLow, loneHigh, loneLow],
      summaries,
      { column: "tokens_7d", direction: "desc" },
    );
    // Families sort by root tokens DESC: z-lone (800) > p (100) >
    // y-lone (30). Within the p family, descendants sort by their
    // own tokens DESC: c-high (9999) before c-low (50). Crucially,
    // c-high does NOT escape to the top of the table.
    expect(result.map((a) => a.agent_id)).toEqual([
      "z-lone",
      "p",
      "c-high",
      "c-low",
      "y-lone",
    ]);
  });

  // ---- windowed-parent regression ---------------------------------------
  // Production root cause: ``AgentSummary.recent_sessions`` is
  // capped at 5 per agent on both server (RecentSessionsPerAgent)
  // and client (RECENT_SESSIONS_WINDOW). A busy parent that has
  // spawned 5+ sessions since starting a sub-agent rolls the
  // spawn-context session out of its own window, so
  // ``sessionToAgent.get(parent_session_id)`` returns undefined on
  // the recent_sessions-only path and the child becomes a lone
  // family. The fleet store's flavors view (sourced from
  // /v1/sessions, ~200-session window) carries the spawn session
  // and recovers the linkage.

  it("regression: child whose parent's spawn session has rolled out of recent_sessions still groups via fleet flavors", () => {
    // Parent's recent_sessions contains 5 NEWER sessions; the
    // spawn-context session "s-spawn" is NOT among them. Child's
    // recent_sessions still carries parent_session_id = "s-spawn".
    // Without fleet flavors, the linkage fails and the child
    // floats away. With fleet flavors (which carry "s-spawn" under
    // the parent's flavor key), the linkage resolves.
    const parent = mkAgent({
      agent_id: "p",
      agent_name: "p",
      recent_sessions: [
        mkRecentSession("s-p-5"),
        mkRecentSession("s-p-4"),
        mkRecentSession("s-p-3"),
        mkRecentSession("s-p-2"),
        mkRecentSession("s-p-1"),
      ],
    });
    const child = mkAgent({
      agent_id: "c",
      agent_name: "c",
      recent_sessions: [mkRecentSession("s-c", "s-spawn")],
    });
    const lone = mkAgent({
      agent_id: "z",
      agent_name: "z",
      recent_sessions: [mkRecentSession("s-z")],
    });
    // Per-agent KPI: child has more tokens than parent. Under
    // tokens DESC and the buggy recent_sessions-only path, child
    // would sort above its parent (and above lone z too).
    const summaries = new Map<string, AgentSummaryResponse>([
      ["p", mkSummary("p", 100)],
      ["c", mkSummary("c", 9000)],
      ["z", mkSummary("z", 50)],
    ]);
    // Fleet flavors carries the parent's six sessions (the 5 in
    // recent_sessions PLUS the spawn-context session) under the
    // parent's agent_id flavor key. This is the realistic shape
    // the /v1/sessions endpoint feeds into the store: ~200 most-
    // recent sessions across all agents, not capped per-agent.
    const flavors: FlavorSummary[] = [
      mkFlavor("p", [
        mkSession("s-p-5"),
        mkSession("s-p-4"),
        mkSession("s-p-3"),
        mkSession("s-p-2"),
        mkSession("s-p-1"),
        mkSession("s-spawn"),
      ]),
      mkFlavor("c", [mkSession("s-c", "s-spawn")]),
      mkFlavor("z", [mkSession("s-z")]),
    ];

    // Without fleet flavors: bug repro — child floats above parent
    // (and above lone z) on tokens DESC.
    const buggy = sortAgentsWithFamilies(
      [parent, child, lone],
      summaries,
      { column: "tokens_7d", direction: "desc" },
    );
    expect(buggy.map((a) => a.agent_id)).toEqual(["c", "p", "z"]);

    // With fleet flavors: family groups properly. Parent's family
    // (rank 100) ranks above lone z (50); child sits directly
    // under its parent.
    const fixed = sortAgentsWithFamilies(
      [parent, child, lone],
      summaries,
      { column: "tokens_7d", direction: "desc" },
      flavors,
    );
    expect(fixed.map((a) => a.agent_id)).toEqual(["p", "c", "z"]);
  });

  it("regression: windowed-parent descendant set picks up the child when fleet flavors carry the spawn session", () => {
    // Same data shape — but assert the descendant set directly so
    // the 28-px indent stamp (driven by ``data-topology="child"``
    // on ``AgentTableRow``) also fires under the windowed-parent
    // scenario.
    const parent = mkAgent({
      agent_id: "p",
      recent_sessions: [
        mkRecentSession("s-p-5"),
        mkRecentSession("s-p-4"),
        mkRecentSession("s-p-3"),
        mkRecentSession("s-p-2"),
        mkRecentSession("s-p-1"),
      ],
    });
    const child = mkAgent({
      agent_id: "c",
      recent_sessions: [mkRecentSession("s-c", "s-spawn")],
    });
    const flavors: FlavorSummary[] = [
      mkFlavor("p", [
        mkSession("s-p-5"),
        mkSession("s-p-4"),
        mkSession("s-p-3"),
        mkSession("s-p-2"),
        mkSession("s-p-1"),
        mkSession("s-spawn"),
      ]),
      mkFlavor("c", [mkSession("s-c", "s-spawn")]),
    ];
    // Without flavors: linkage unresolvable — descendant set empty.
    expect(deriveFamilyDescendantSet([parent, child]).has("c")).toBe(false);
    // With flavors: linkage resolves — child marked as descendant.
    expect(
      deriveFamilyDescendantSet([parent, child], flavors).has("c"),
    ).toBe(true);
  });

  // ---- direct parent_agent_id projection ---------------------------
  // After the server-side projection lands, the child's
  // recent_sessions row carries ``parent_agent_id`` directly. This
  // is the AUTHORITATIVE source: it's immune to every windowing
  // scheme. The fallback session-to-agent map (recent_sessions +
  // fleet flavors) is consulted only when the direct projection is
  // missing — backwards-compatible with deployments whose API
  // hasn't been redeployed yet.

  it("direct parent_agent_id resolves the linkage with NO recent_sessions overlap and NO fleet flavors", () => {
    // Worst-case windowing: parent's spawn session is in NEITHER
    // the parent's recent_sessions NOR fleet flavors (the deeply-
    // windowed case the dual-source fix alone couldn't recover).
    // The direct projection MUST resolve the linkage on its own.
    const parent = mkAgent({
      agent_id: "p",
      agent_name: "p",
      recent_sessions: [
        mkRecentSession("s-p-newer-1"),
        mkRecentSession("s-p-newer-2"),
        mkRecentSession("s-p-newer-3"),
        mkRecentSession("s-p-newer-4"),
        mkRecentSession("s-p-newer-5"),
      ],
    });
    const child = mkAgent({
      agent_id: "c",
      agent_name: "c",
      recent_sessions: [
        mkRecentSession("s-c", "s-spawn-deeply-old", "p"),
      ],
    });
    const summaries = new Map<string, AgentSummaryResponse>([
      ["p", mkSummary("p", 100)],
      ["c", mkSummary("c", 9999)],
    ]);
    // No fleet flavors arg AND no overlap on session_ids — the
    // only thing that lets this resolve is the direct projection.
    const result = sortAgentsWithFamilies(
      [parent, child],
      summaries,
      { column: "tokens_7d", direction: "desc" },
    );
    expect(result.map((a) => a.agent_id)).toEqual(["p", "c"]);
    expect(deriveFamilyDescendantSet([parent, child]).has("c")).toBe(true);
  });

  it("direct parent_agent_id wins over a contradicting session-map walk", () => {
    // Direct projection says "p"; sessionToAgent walk (built from
    // recent_sessions and fleet flavors) says "ghost". The direct
    // projection must win — it's the authoritative source-of-truth
    // from the SQL self-join.
    const parent = mkAgent({
      agent_id: "p",
      recent_sessions: [mkRecentSession("s-p")],
    });
    const child = mkAgent({
      agent_id: "c",
      recent_sessions: [mkRecentSession("s-c", "s-p", "p")],
    });
    // Phantom flavor mis-attributes "s-p" to "ghost". If the
    // session-map walk fired before the direct projection check,
    // the linkage would resolve to "ghost" and "c" would render
    // as a lone family. Direct projection wins → groups under "p".
    const flavors: FlavorSummary[] = [
      mkFlavor("ghost", [mkSession("s-p")]),
    ];
    const result = sortAgentsWithFamilies(
      [parent, child],
      new Map(),
      { column: "agent_name", direction: "asc" },
      flavors,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["p", "c"]);
  });

  it("missing direct projection falls back to session-map walk (backwards-compat)", () => {
    // Pre-projection deployments: parent_agent_id is undefined on
    // the wire. The fallback session-to-agent map must still
    // resolve the linkage when parent_session_id is in some
    // agent's recent_sessions slice. This guards against silently
    // breaking the old code path during a rollout.
    const parent = mkAgent({
      agent_id: "p",
      recent_sessions: [mkRecentSession("s-p")],
    });
    const child = mkAgent({
      agent_id: "c",
      // parent_agent_id explicitly undefined.
      recent_sessions: [mkRecentSession("s-c", "s-p")],
    });
    const result = sortAgentsWithFamilies([parent, child], new Map(), {
      column: "agent_name",
      direction: "asc",
    });
    expect(result.map((a) => a.agent_id)).toEqual(["p", "c"]);
    expect(deriveFamilyDescendantSet([parent, child]).has("c")).toBe(true);
  });

  it("fleet-flavors source does not override recent_sessions when both cover a session", () => {
    // recent_sessions is the per-agent rollup and is immune to the
    // wall-clock window that fleet flavors live under. When both
    // sources cover a session_id, recent_sessions wins. This guards
    // against a malformed flavors payload mis-attributing a session
    // to a different agent.
    const parent = mkAgent({
      agent_id: "p",
      recent_sessions: [mkRecentSession("s-p")],
    });
    const child = mkAgent({
      agent_id: "c",
      recent_sessions: [mkRecentSession("s-c", "s-p")],
    });
    // Fleet flavors mis-attribute "s-p" to a phantom agent "ghost".
    // The recent_sessions source already says "s-p" → "p", and
    // recent_sessions wins. Linkage resolves to "p" correctly.
    const flavors: FlavorSummary[] = [
      mkFlavor("ghost", [mkSession("s-p")]),
      mkFlavor("c", [mkSession("s-c", "s-p")]),
    ];
    const result = sortAgentsWithFamilies(
      [parent, child],
      new Map(),
      { column: "agent_name", direction: "asc" },
      flavors,
    );
    expect(result.map((a) => a.agent_id)).toEqual(["p", "c"]);
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
