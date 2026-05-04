import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/types";
import {
  buildUrlParams,
  parseUrlState,
  computeFacets,
  CLEAR_ALL_FILTERS_PATCH,
  nextExpandedParentsOnToggle,
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
    child_count: overrides.child_count,
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
    // has_sub_agents counts sessions whose own session_id
    // appears as another session's parent_session_id. In this
    // fixture the parents (p1, p2) aren't materialised as
    // visible sessions, so the count is 0. Step 8.fix's
    // sub-agent-facets.test.ts adds the positive case where the
    // parent session is also visible and the count goes to 1.
    expect(map.has_sub_agents).toBe(0);
  });
});

// D126 UX revision 2026-05-03 — default scope + parent-pill + inline
// expansion behaviour tests. Drives the buildUrlParams /
// parseUrlState round-trip for the new state plus the SessionListItem
// child_count contract that powers the parent-row pill render.

describe("Investigate UX revision — child_count semantics", () => {
  it("parents with child_count > 0 are distinguishable from lone sessions", () => {
    const parent = mk("p1", "x", { child_count: 3 });
    const lone = mk("lone", "y", { child_count: 0 });
    expect(parent.child_count).toBe(3);
    expect(lone.child_count).toBe(0);
  });

  it("absent child_count treats the row as lone (legacy back-compat)", () => {
    const legacy = mk("legacy", "x");
    expect(legacy.child_count).toBeUndefined();
    // Render-side check: ``(s.child_count ?? 0) > 0`` is the
    // discriminator. Undefined → falsy → not a parent.
    const isParent = (legacy.child_count ?? 0) > 0;
    expect(isParent).toBe(false);
  });

  it("parents whose own parent_session_id is set still report child_count", () => {
    // Depth-2 nesting: a session that's both a child of someone
    // and has children of its own. The parent-pill should render
    // (child_count > 0) AND the "Filter to parent" link should
    // render (parent_session_id set). Two independent affordances
    // on the same row.
    const middle = mk("mid", "x", {
      parent_session_id: "gp",
      agent_role: "Coordinator",
      child_count: 2,
    });
    expect((middle.child_count ?? 0) > 0).toBe(true);
    expect(middle.parent_session_id).toBe("gp");
  });
});

describe("Investigate UX revision — TOPOLOGY facet override semantics", () => {
  // The facet checkboxes drive the listing scope:
  //   - default: parents-with-children + lone (pure children hidden)
  //   - "Has sub-agents" alone: same as default (visual no-op)
  //   - "Is sub-agent" alone: children-only override
  //   - both: union (existing OR composition stays)
  it("default urlState carries no facet override", () => {
    const parsed = parseUrlState(new URLSearchParams());
    expect(parsed.isSubAgent).toBe(false);
    expect(parsed.hasSubAgents).toBe(false);
  });

  it("only is_sub_agent set means override-to-children-only", () => {
    const parsed = parseUrlState(new URLSearchParams("is_sub_agent=true"));
    expect(parsed.isSubAgent).toBe(true);
    expect(parsed.hasSubAgents).toBe(false);
  });

  it("only has_sub_agents set means stay-at-default-scope", () => {
    const parsed = parseUrlState(new URLSearchParams("has_sub_agents=true"));
    expect(parsed.hasSubAgents).toBe(true);
    expect(parsed.isSubAgent).toBe(false);
  });

  it("both set composes via the existing OR semantics on the server", () => {
    const parsed = parseUrlState(
      new URLSearchParams("is_sub_agent=true&has_sub_agents=true"),
    );
    expect(parsed.isSubAgent).toBe(true);
    expect(parsed.hasSubAgents).toBe(true);
  });

  it("CLEAR_ALL_FILTERS_PATCH zeros both facet flags", () => {
    expect(CLEAR_ALL_FILTERS_PATCH.isSubAgent).toBe(false);
    expect(CLEAR_ALL_FILTERS_PATCH.hasSubAgents).toBe(false);
  });
});

// D126 UX revision 2026-05-04: clicking a different parent row
// collapses the previously-expanded parent. The pre-fix Set-add
// behaviour accumulated children across clicks; the new pure
// reducer ``nextExpandedParentsOnToggle`` resets to a single-id
// Set on every transition-to-expanded. Toggling off the same
// parent collapses it without auto-expanding anything else.
describe("Investigate inline expansion — single-parent reducer", () => {
  it("clicking a fresh parent returns a Set containing ONLY that parent", () => {
    const next = nextExpandedParentsOnToggle(new Set(), "p-1");
    expect([...next]).toEqual(["p-1"]);
  });

  it("clicking a different parent collapses the previously-expanded one", () => {
    // Supervisor's repro: expand p-1 (2 children), then click
    // p-2 (3 children). Pre-fix the result was {p-1, p-2}; post-
    // fix it is just {p-2}.
    const after1 = nextExpandedParentsOnToggle(new Set(), "p-1");
    const after2 = nextExpandedParentsOnToggle(after1, "p-2");
    expect([...after2]).toEqual(["p-2"]);
    expect(after2.has("p-1")).toBe(false);
  });

  it("clicking the SAME parent again toggles it off without auto-expanding any other", () => {
    const expanded = nextExpandedParentsOnToggle(new Set(), "p-1");
    const collapsed = nextExpandedParentsOnToggle(expanded, "p-1");
    expect([...collapsed]).toEqual([]);
  });

  it("does not mutate the input Set (returns a fresh Set on every call)", () => {
    const input = new Set(["p-1"]);
    const out = nextExpandedParentsOnToggle(input, "p-2");
    // Input untouched.
    expect([...input]).toEqual(["p-1"]);
    // Output is a different Set instance.
    expect(out).not.toBe(input);
    expect([...out]).toEqual(["p-2"]);
  });

  it("rapid alternating clicks A → B → A always lands on the just-clicked parent", () => {
    let s: Set<string> = new Set();
    s = nextExpandedParentsOnToggle(s, "p-A");
    expect([...s]).toEqual(["p-A"]);
    s = nextExpandedParentsOnToggle(s, "p-B");
    expect([...s]).toEqual(["p-B"]);
    s = nextExpandedParentsOnToggle(s, "p-A");
    expect([...s]).toEqual(["p-A"]);
  });
});
