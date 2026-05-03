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
    // parent_session_id is set; has_sub_agents has no per-row
    // signal on the wire so the count surfaces as 0 — the renderer
    // shows the checkbox without a number, but the entry must be
    // present so the user can toggle it.
    expect(map.is_sub_agent).toBe(2);
    expect(map.has_sub_agents).toBe(0);
  });
});
