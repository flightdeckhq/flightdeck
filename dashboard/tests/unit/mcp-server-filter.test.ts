import { describe, it, expect } from "vitest";
import {
  parseUrlState,
  buildUrlParams,
  computeFacets,
  CLEAR_ALL_FILTERS_PATCH,
} from "@/pages/Investigate";
import type { SessionListItem } from "@/lib/types";

// Phase 5 — MCP_SERVER filter contract pinned at the URL-state, facet-
// aggregation, and CLEAR_ALL layers. Same shape as the Phase 4
// error-type-filter unit tests.

function makeSession(overrides: Partial<SessionListItem>): SessionListItem {
  return {
    session_id: overrides.session_id ?? "00000000-0000-0000-0000-000000000001",
    flavor: overrides.flavor ?? "phase5-fixture",
    agent_type: overrides.agent_type ?? "coding",
    host: null,
    model: null,
    state: "active",
    started_at: new Date().toISOString(),
    ended_at: null,
    last_seen_at: new Date().toISOString(),
    duration_s: 0,
    tokens_used: 0,
    token_limit: null,
    context: {},
    error_types: [],
    policy_event_types: [],
    mcp_server_names: overrides.mcp_server_names ?? [],
    ...overrides,
  };
}

describe("parseUrlState / buildUrlParams — mcp_server round-trip", () => {
  it("reads ?mcp_server=demo&mcp_server=github into mcpServers[]", () => {
    const sp = new URLSearchParams("mcp_server=demo&mcp_server=github");
    const state = parseUrlState(sp);
    expect(state.mcpServers).toEqual(["demo", "github"]);
  });

  it("buildUrlParams emits one mcp_server=... per value, preserving order", () => {
    const sp = new URLSearchParams(
      "mcp_server=alpha&mcp_server=beta&mcp_server=gamma",
    );
    const state = parseUrlState(sp);
    const params = buildUrlParams(state);
    const round = params.getAll("mcp_server");
    expect(round).toEqual(["alpha", "beta", "gamma"]);
  });

  it("absent param defaults to an empty array", () => {
    const sp = new URLSearchParams("");
    const state = parseUrlState(sp);
    expect(state.mcpServers).toEqual([]);
  });
});

describe("computeFacets — MCP SERVER aggregation", () => {
  it("aggregates names across visible sessions; one vote per session per name", () => {
    const sessions = [
      makeSession({ mcp_server_names: ["demo", "filesystem"] }),
      makeSession({ mcp_server_names: ["demo"] }),
      makeSession({ mcp_server_names: ["github"] }),
      makeSession({ mcp_server_names: [] }),
    ];
    const facets = computeFacets(sessions);
    const mcp = facets.find((g) => g.key === "mcp_server");
    expect(mcp).toBeDefined();
    const counts = Object.fromEntries(mcp!.values.map((v) => [v.value, v.count]));
    expect(counts).toEqual({ demo: 2, filesystem: 1, github: 1 });
  });

  it("hides the facet when no visible session connected to an MCP server", () => {
    const sessions = [makeSession({}), makeSession({})];
    const facets = computeFacets(sessions);
    expect(facets.find((g) => g.key === "mcp_server")).toBeUndefined();
  });

  it("sticky source: when mcp_server filter active, uses sources.mcp_server", () => {
    // Main result set: only the demo-filtered subset survives.
    const main = [makeSession({ mcp_server_names: ["demo"] })];
    // Sticky source: pre-filter set carrying every name the user
    // could toggle to.
    const sticky = [
      makeSession({ mcp_server_names: ["demo", "filesystem"] }),
      makeSession({ mcp_server_names: ["github"] }),
    ];
    const facets = computeFacets(main, { mcp_server: sticky });
    const mcp = facets.find((g) => g.key === "mcp_server");
    expect(mcp).toBeDefined();
    const names = mcp!.values.map((v) => v.value).sort();
    expect(names).toEqual(["demo", "filesystem", "github"]);
  });

  it("sits at the very end of the facet ordering", () => {
    const sessions = [
      makeSession({ mcp_server_names: ["demo"], error_types: ["rate_limit"] }),
    ];
    const facets = computeFacets(sessions);
    expect(facets[facets.length - 1].key).toBe("mcp_server");
  });
});

describe("CLEAR_ALL_FILTERS_PATCH — mcpServers reset", () => {
  it("includes mcpServers: [] so clear-all wipes the MCP_SERVER filter", () => {
    expect(CLEAR_ALL_FILTERS_PATCH.mcpServers).toEqual([]);
  });
});
