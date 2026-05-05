import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/types";
import { computeFacets } from "@/pages/Investigate";

function mk(
  id: string,
  flavor: string,
  overrides: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    session_id: id,
    flavor,
    agent_type: overrides.agent_type ?? "coding",
    host: overrides.host ?? null,
    model: overrides.model ?? null,
    state: overrides.state ?? "active",
    started_at: overrides.started_at ?? "",
    ended_at: overrides.ended_at ?? null,
    last_seen_at: overrides.last_seen_at ?? "",
    duration_s: overrides.duration_s ?? 0,
    tokens_used: overrides.tokens_used ?? 0,
    token_limit: overrides.token_limit ?? null,
    context: overrides.context ?? {},
    parent_session_id: overrides.parent_session_id,
    agent_role: overrides.agent_role,
  };
}

describe("computeFacets -- D126 sub-agent facets", () => {
  it("hides the ROLE facet when no session carries an agent_role", () => {
    // Root-only result sets must not surface the ROLE facet —
    // showing a single non-actionable ``(root)`` bucket would be a
    // dead-end UX (Rule 17: no placeholder UI).
    const sessions = [mk("a", "x"), mk("b", "y")];
    expect(computeFacets(sessions).find((g) => g.key === "agent_role")).toBeUndefined();
  });

  it("emits a ROLE facet entry per distinct agent_role", () => {
    const sessions = [
      mk("a", "x", { parent_session_id: "p1", agent_role: "Researcher" }),
      mk("b", "y", { parent_session_id: "p1", agent_role: "Researcher" }),
      mk("c", "z", { parent_session_id: "p2", agent_role: "Writer" }),
      mk("d", "w"), // root, must not contribute
    ];
    const role = computeFacets(sessions).find((g) => g.key === "agent_role");
    expect(role).toBeDefined();
    expect(role?.label).toBe("ROLE");
    const map = Object.fromEntries(role!.values.map((v) => [v.value, v.count]));
    // Root sessions bucket as "(root)" internally but the renderer
    // strips the entry so the facet is purely actionable. The
    // visible values list must therefore omit "(root)" entirely.
    expect(map).toEqual({ Researcher: 2, Writer: 1 });
  });

  it("renders the TOPOLOGY facet with count=0 on root-only result sets", () => {
    // D126 § 7.fix.F — TOPOLOGY facet is always visible so the
    // user can toggle "Has sub-agents" to widen the search even
    // when the current visible set has no sub-agents. Hiding it
    // would be a dead-end UX (the user would have nothing to
    // click). The is_sub_agent count is 0 in this case.
    const sessions = [mk("a", "x"), mk("b", "y")];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    expect(topo).toBeDefined();
    const map = Object.fromEntries(topo!.values.map((v) => [v.value, v.count]));
    expect(map.is_sub_agent).toBe(0);
    expect(map.has_sub_agents).toBe(0);
  });

  it("emits the TOPOLOGY facet with two boolean values when sub-agents are visible", () => {
    const sessions = [
      mk("a", "x", { parent_session_id: "p1", agent_role: "Researcher" }),
      mk("b", "x", { parent_session_id: "p2", agent_role: "Writer" }),
    ];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    expect(topo).toBeDefined();
    const map = Object.fromEntries(topo!.values.map((v) => [v.value, v.count]));
    // is_sub_agent counts every visible session whose
    // parent_session_id is set; has_sub_agents counts sessions
    // whose own session_id appears as some other session's
    // parent_session_id. In this fixture neither parent (p1, p2)
    // appears as a session in ``sessions``, so has_sub_agents is 0.
    expect(map.is_sub_agent).toBe(2);
    expect(map.has_sub_agents).toBe(0);
  });

  it("emits has_sub_agents > 0 when a parent session is visible alongside its child", () => {
    // D126 § 8.fix — the has_sub_agents count was hardcoded to 0
    // in step 7.fix because no per-row signal was wired through
    // from the API. Step 8.fix computes it client-side: collect
    // every distinct parent_session_id across visible sessions,
    // then tally sessions whose own session_id sits in that set.
    // This matches the AgentTable's ``→ N`` pill semantics from
    // the same data source.
    const sessions = [
      // Parent — its session_id IS referenced as parent by the
      // children below.
      mk("p1", "parent-flavor"),
      mk("c1", "child-flavor", {
        parent_session_id: "p1",
        agent_role: "Researcher",
      }),
      mk("c2", "child-flavor", {
        parent_session_id: "p1",
        agent_role: "Writer",
      }),
    ];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    expect(topo).toBeDefined();
    const map = Object.fromEntries(topo!.values.map((v) => [v.value, v.count]));
    expect(map.is_sub_agent).toBe(2); // c1 + c2
    expect(map.has_sub_agents).toBe(1); // p1 only
  });

  // D126 UX revision 2026-05-03 — TOPOLOGY facet behaviour under
  // the new default scope (parents-with-children + lone). The
  // facet stays visible regardless of whether either checkbox is
  // selected; selecting "Has sub-agents" is a visual no-op (the
  // default scope ALREADY filters to parents-with-children + lone)
  // while "Is sub-agent" overrides to children-only.

  it("renders TOPOLOGY facet even when default scope hides pure children (always-on)", () => {
    // Simulate what the default scope returns: only parents (which
    // have children referenced) + lone sessions. The facet
    // computation should still emit both checkboxes so the user
    // can override.
    const sessions = [
      mk("p1", "parent-flavor"),
      mk("lone", "lone-flavor"),
      // child of p1 IS in the visible set here so has_sub_agents > 0
      mk("c1", "child-flavor", {
        parent_session_id: "p1",
        agent_role: "Researcher",
      }),
    ];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    expect(topo).toBeDefined();
    const values = topo!.values.map((v) => v.value).sort();
    expect(values).toEqual(["has_sub_agents", "is_sub_agent"]);
  });

  it("is_sub_agent count covers depth-2 children whose parents also have parents", () => {
    // gp (root) → mid (child + has_sub_agents) → leaf (pure child)
    // mid is BOTH is_sub_agent (parent_session_id set) AND
    // has_sub_agents (referenced by leaf). The facet count for
    // is_sub_agent should include mid AND leaf (= 2); has_sub_agents
    // should include gp AND mid (= 2).
    const sessions = [
      mk("gp", "root-flavor"),
      mk("mid", "mid-flavor", {
        parent_session_id: "gp",
        agent_role: "Coordinator",
      }),
      mk("leaf", "leaf-flavor", {
        parent_session_id: "mid",
        agent_role: "Worker",
      }),
    ];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    const map = Object.fromEntries(topo!.values.map((v) => [v.value, v.count]));
    expect(map.is_sub_agent).toBe(2); // mid + leaf
    expect(map.has_sub_agents).toBe(2); // gp + mid
  });

  it("TOPOLOGY facet survives a children-only override view", () => {
    // What the user sees with ``is_sub_agent=true``: only
    // children. The facet checkbox is still rendered so the user
    // can toggle BACK to default. The ROLE facet drives
    // disambiguation in this view; TOPOLOGY shouldn't disappear
    // because the user clicked into it.
    const sessions = [
      mk("c1", "x", { parent_session_id: "p1", agent_role: "A" }),
      mk("c2", "x", { parent_session_id: "p1", agent_role: "B" }),
    ];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    expect(topo).toBeDefined();
    const values = topo!.values.map((v) => v.value).sort();
    expect(values).toEqual(["has_sub_agents", "is_sub_agent"]);
  });
});
