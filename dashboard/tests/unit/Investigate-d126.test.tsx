import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/types";
import {
  buildUrlParams,
  parseUrlState,
  computeFacets,
  CLEAR_ALL_FILTERS_PATCH,
} from "@/pages/Investigate";

// D126 § 7.fix.N — Investigate D126 surface tests. Covers the
// TOPOLOGY + ROLE facet computation, the URL state round-trip, the
// active-filter chip composition, and the CLEAR_ALL_FILTERS_PATCH
// vocabulary.

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

describe("Investigate URL state — D126 round-trip", () => {
  it("parses and re-serialises agent_role + topology + parent_session_id", () => {
    const params = new URLSearchParams(
      "agent_role=Researcher&agent_role=Writer&is_sub_agent=true&has_sub_agents=true&parent_session_id=abc-123",
    );
    const parsed = parseUrlState(params);
    expect(parsed.agentRoles).toEqual(["Researcher", "Writer"]);
    expect(parsed.isSubAgent).toBe(true);
    expect(parsed.hasSubAgents).toBe(true);
    expect(parsed.parentSessionId).toBe("abc-123");
    const rebuilt = buildUrlParams(parsed).toString();
    expect(rebuilt).toContain("agent_role=Researcher");
    expect(rebuilt).toContain("agent_role=Writer");
    expect(rebuilt).toContain("is_sub_agent=true");
    expect(rebuilt).toContain("has_sub_agents=true");
    expect(rebuilt).toContain("parent_session_id=abc-123");
  });

  it("CLEAR_ALL_FILTERS_PATCH clears every D126 filter", () => {
    expect(CLEAR_ALL_FILTERS_PATCH.agentRoles).toEqual([]);
    expect(CLEAR_ALL_FILTERS_PATCH.isSubAgent).toBe(false);
    expect(CLEAR_ALL_FILTERS_PATCH.hasSubAgents).toBe(false);
    expect(CLEAR_ALL_FILTERS_PATCH.parentSessionId).toBe("");
  });

  it("absent D126 params parse to neutral defaults", () => {
    const parsed = parseUrlState(new URLSearchParams());
    expect(parsed.agentRoles).toEqual([]);
    expect(parsed.isSubAgent).toBe(false);
    expect(parsed.hasSubAgents).toBe(false);
    expect(parsed.parentSessionId).toBe("");
  });
});

describe("computeFacets — D126 ROLE facet", () => {
  it("hides itself when every visible session has agent_role=null", () => {
    const sessions = [mk("a", "x"), mk("b", "y")];
    const groups = computeFacets(sessions);
    expect(groups.find((g) => g.key === "agent_role")).toBeUndefined();
  });

  it("renders distinct roles with counts when sub-agents are visible", () => {
    const sessions = [
      mk("a", "x", { parent_session_id: "p", agent_role: "Researcher" }),
      mk("b", "y", { parent_session_id: "p", agent_role: "Researcher" }),
      mk("c", "z", { parent_session_id: "p", agent_role: "Writer" }),
    ];
    const role = computeFacets(sessions).find((g) => g.key === "agent_role");
    expect(role).toBeDefined();
    const map = Object.fromEntries(role!.values.map((v) => [v.value, v.count]));
    expect(map).toEqual({ Researcher: 2, Writer: 1 });
  });

  it("excludes the (root) bucket entirely so the click affordance is meaningful", () => {
    const sessions = [
      // Three roots + one child — the (root) entry would have
      // count=3 if we kept it. Filter must drop the entry so the
      // facet UI doesn't surface a non-actionable click target.
      mk("a", "x"),
      mk("b", "y"),
      mk("c", "z"),
      mk("d", "w", { parent_session_id: "p", agent_role: "Researcher" }),
    ];
    const role = computeFacets(sessions).find((g) => g.key === "agent_role");
    expect(role).toBeDefined();
    const values = role!.values.map((v) => v.value);
    expect(values).not.toContain("(root)");
    expect(values).toContain("Researcher");
  });
});

describe("computeFacets — D126 TOPOLOGY facet", () => {
  it("always renders both checkboxes regardless of result-set composition", () => {
    // Root-only sessions must still see TOPOLOGY so the user can
    // toggle "Has sub-agents" to widen the search. (D126 § 7.fix.F
    // contract — the facet is always-on.)
    const sessions = [mk("a", "x"), mk("b", "y")];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    expect(topo).toBeDefined();
    expect(topo!.values.map((v) => v.value).sort()).toEqual([
      "has_sub_agents",
      "is_sub_agent",
    ]);
  });

  it("is_sub_agent count reflects visible children", () => {
    const sessions = [
      mk("a", "x", { parent_session_id: "p1", agent_role: "Researcher" }),
      mk("b", "y", { parent_session_id: "p2", agent_role: "Writer" }),
      mk("c", "z"), // root, doesn't contribute
    ];
    const topo = computeFacets(sessions).find((g) => g.key === "topology");
    expect(topo).toBeDefined();
    const map = Object.fromEntries(topo!.values.map((v) => [v.value, v.count]));
    expect(map.is_sub_agent).toBe(2);
    // has_sub_agents has no per-row signal on the wire so its
    // count is always 0; the renderer drops the count display
    // for that one entry but the toggle stays clickable.
    expect(map.has_sub_agents).toBe(0);
  });
});
