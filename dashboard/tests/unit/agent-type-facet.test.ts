import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/types";
import { computeFacets } from "@/pages/Investigate";

function mkSession(
  id: string,
  flavor: string,
  agentType: string,
  state: SessionListItem["state"] = "active",
): SessionListItem {
  return {
    session_id: id,
    flavor,
    agent_type: agentType,
    host: null,
    model: null,
    state,
    started_at: "",
    ended_at: null,
    duration_s: 0,
    tokens_used: 0,
    token_limit: null,
    context: {},
  };
}

describe("computeFacets -- AGENT TYPE", () => {
  it("emits an AGENT TYPE facet with counts per value", () => {
    const sessions = [
      mkSession("a", "claude-code", "developer"),
      mkSession("b", "claude-code", "developer"),
      mkSession("c", "research-agent", "autonomous"),
      mkSession("d", "batch-job", "batch"),
    ];
    const groups = computeFacets(sessions);
    const agentType = groups.find((g) => g.key === "agent_type");
    expect(agentType).toBeDefined();
    expect(agentType!.label).toBe("AGENT TYPE");
    const values = Object.fromEntries(
      agentType!.values.map((v) => [v.value, v.count]),
    );
    expect(values).toEqual({
      developer: 2,
      autonomous: 1,
      batch: 1,
    });
  });

  it("is sorted by count descending (most common first)", () => {
    const sessions = [
      mkSession("a", "f", "batch"),
      mkSession("b", "f", "batch"),
      mkSession("c", "f", "batch"),
      mkSession("d", "f", "developer"),
    ];
    const groups = computeFacets(sessions);
    const agentType = groups.find((g) => g.key === "agent_type")!;
    expect(agentType.values[0].value).toBe("batch");
    expect(agentType.values[0].count).toBe(3);
    expect(agentType.values[1].value).toBe("developer");
  });

  it("uses the sticky-facet source when the main result is filtered", () => {
    // Main result is filtered down to a single agent_type (developer),
    // so the unfiltered source is what the facet should render -- the
    // user can't click over to another agent_type if the facet has
    // collapsed to a single row.
    const filtered = [mkSession("a", "claude-code", "developer")];
    const unfiltered = [
      mkSession("a", "claude-code", "developer"),
      mkSession("b", "research", "autonomous"),
      mkSession("c", "batch", "batch"),
    ];
    const groups = computeFacets(filtered, { agent_type: unfiltered });
    const agentType = groups.find((g) => g.key === "agent_type")!;
    expect(agentType.values.length).toBe(3);
  });

  it("omits the facet entirely when no sessions carry an agent_type", () => {
    // Defensive: if every session has agent_type="" (empty string) or
    // the field is missing, the facet row is dropped via the
    // .filter((g) => g.values.length > 0) guard.
    const sessions = [
      {
        ...mkSession("a", "flavor-a", ""),
        agent_type: "",
      },
    ];
    const groups = computeFacets(sessions);
    const agentType = groups.find((g) => g.key === "agent_type");
    expect(agentType).toBeUndefined();
  });

  it("places AGENT TYPE between FRAMEWORK and OS in the facet order", () => {
    // The facet order drives the sidebar layout. Operators scanning
    // top-to-bottom expect identity (flavor/model/framework) above
    // environment (os/git/host). agent_type belongs on the identity
    // side of that divide, just under FRAMEWORK.
    const sessions = [
      {
        ...mkSession("a", "claude-code", "developer"),
        context: { frameworks: ["claude-code"], os: "Linux" },
      },
    ];
    const order = computeFacets(sessions).map((g) => g.key);
    const fw = order.indexOf("framework");
    const at = order.indexOf("agent_type");
    const os = order.indexOf("os");
    expect(fw).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(-1);
    expect(os).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(fw);
    expect(at).toBeLessThan(os);
  });
});
