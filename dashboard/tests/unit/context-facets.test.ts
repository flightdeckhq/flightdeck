import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/types";
import { computeFacets } from "@/pages/Investigate";

type CtxOverrides = Partial<Pick<SessionListItem, "model" | "host" | "agent_type">> & {
  context?: Record<string, unknown>;
};

function mk(id: string, flavor: string, overrides: CtxOverrides = {}): SessionListItem {
  return {
    session_id: id,
    flavor,
    agent_type: overrides.agent_type ?? "coding",
    host: overrides.host ?? null,
    model: overrides.model ?? null,
    state: "active",
    started_at: "",
    ended_at: null,
    duration_s: 0,
    tokens_used: 0,
    token_limit: null,
    context: overrides.context ?? {},
  };
}

// One test per facet (15 total -- matches the brief's "one
// computeFacets test per facet" accounting). Existing STATE / FLAVOR /
// MODEL / FRAMEWORK / AGENT TYPE facets keep their own coverage in
// agent-type-facet.test.ts; this file focuses on the ten scalar
// context facets + three sanity scenarios (sticky source, missing
// field, canonical order).

describe("computeFacets -- scalar context facets", () => {
  it("OS facet emits one entry per distinct value", () => {
    const sessions = [
      mk("a", "x", { context: { os: "Linux" } }),
      mk("b", "x", { context: { os: "Linux" } }),
      mk("c", "x", { context: { os: "Darwin" } }),
    ];
    const group = computeFacets(sessions).find((g) => g.key === "os");
    expect(group?.label).toBe("OS");
    expect(Object.fromEntries(group!.values.map((v) => [v.value, v.count]))).toEqual({
      Linux: 2,
      Darwin: 1,
    });
  });

  it("ARCH facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { arch: "x64" } }),
      mk("b", "x", { context: { arch: "arm64" } }),
    ]).find((g) => g.key === "arch");
    expect(group?.label).toBe("ARCH");
    expect(group?.values.length).toBe(2);
  });

  it("HOSTNAME facet prefers context.hostname, falls back to session.host", () => {
    const sessions = [
      mk("a", "x", { context: { hostname: "node-01" } }),
      // Legacy shape: no context.hostname but session.host populated.
      mk("b", "x", { host: "node-02" }),
    ];
    const group = computeFacets(sessions).find((g) => g.key === "hostname");
    expect(group).toBeDefined();
    const vals = new Set(group!.values.map((v) => v.value));
    expect(vals.has("node-01")).toBe(true);
    expect(vals.has("node-02")).toBe(true);
  });

  it("USER facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { user: "alice" } }),
      mk("b", "x", { context: { user: "alice" } }),
      mk("c", "x", { context: { user: "bob" } }),
    ]).find((g) => g.key === "user");
    expect(group?.label).toBe("USER");
    expect(group?.values.map((v) => v.value)).toEqual(["alice", "bob"]);
    expect(group?.values.map((v) => v.count)).toEqual([2, 1]);
  });

  it("PROCESS_NAME facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { process_name: "claude-code" } }),
      mk("b", "x", { context: { process_name: "python" } }),
    ]).find((g) => g.key === "process_name");
    expect(group?.label).toBe("PROCESS_NAME");
    expect(group?.values.length).toBe(2);
  });

  it("NODE VERSION facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { node_version: "v24.15.0" } }),
    ]).find((g) => g.key === "node_version");
    expect(group?.label).toBe("NODE VERSION");
    expect(group?.values[0].value).toBe("v24.15.0");
  });

  it("PYTHON VERSION facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { python_version: "3.12.1" } }),
    ]).find((g) => g.key === "python_version");
    expect(group?.label).toBe("PYTHON VERSION");
  });

  it("GIT BRANCH facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { git_branch: "main" } }),
      mk("b", "x", { context: { git_branch: "feat/abc" } }),
    ]).find((g) => g.key === "git_branch");
    expect(group?.label).toBe("GIT BRANCH");
    expect(group?.values.length).toBe(2);
  });

  it("GIT REPO facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { git_repo: "flightdeck" } }),
    ]).find((g) => g.key === "git_repo");
    expect(group?.label).toBe("GIT REPO");
  });

  it("ORCHESTRATION facet", () => {
    const group = computeFacets([
      mk("a", "x", { context: { orchestration: "kubernetes" } }),
      mk("b", "x", { context: { orchestration: "docker-compose" } }),
    ]).find((g) => g.key === "orchestration");
    expect(group?.label).toBe("ORCHESTRATION");
    expect(group?.values.length).toBe(2);
  });

  it("does NOT emit a git_commit facet (filter-only by decision)", () => {
    const groups = computeFacets([
      mk("a", "x", { context: { git_commit: "abc1234" } }),
    ]);
    expect(groups.find((g) => g.key === "git_commit")).toBeUndefined();
  });

  it("does NOT emit a pid / working_dir / supports_directives facet", () => {
    // These are drawer-only per the Phase 3 addendum #2 decision.
    const groups = computeFacets([
      mk("a", "x", {
        context: {
          pid: 1234,
          working_dir: "/mnt/c/Users/omria/dev/flightdeck",
          supports_directives: false,
        },
      }),
    ]).map((g) => g.key);
    expect(groups.includes("pid")).toBe(false);
    expect(groups.includes("working_dir")).toBe(false);
    expect(groups.includes("supports_directives")).toBe(false);
  });

  it("uses sticky sources when a context facet is actively filtered", () => {
    // Main result is filtered to a single user (alice); the sticky
    // source provides the full set so the USER facet still shows
    // alice + bob + carol.
    const filtered = [mk("a", "x", { context: { user: "alice" } })];
    const unfiltered = [
      mk("a", "x", { context: { user: "alice" } }),
      mk("b", "x", { context: { user: "bob" } }),
      mk("c", "x", { context: { user: "carol" } }),
    ];
    const groups = computeFacets(filtered, { user: unfiltered });
    const userGroup = groups.find((g) => g.key === "user");
    expect(userGroup?.values.length).toBe(3);
  });

  it("omits a scalar facet when every session has an empty string value", () => {
    // Defensive: null / empty values shouldn't create bogus facet
    // entries. The facet row stays hidden entirely (the >=1 rule is
    // on distinct non-empty values, not on total session count).
    const groups = computeFacets([
      mk("a", "x", { context: { user: "" } }),
      mk("b", "x", { context: {} }),
    ]);
    expect(groups.find((g) => g.key === "user")).toBeUndefined();
  });

  it("renders the 15 canonical facets in the spec order", () => {
    // One session carrying every facet-worthy scalar. The resulting
    // .map(key) should match the canonical order in the Phase 3 #2
    // brief. Keys whose value is missing are filtered out -- this
    // test puts every key so all 15 render.
    const session = mk("a", "claude-code", {
      model: "claude-sonnet-4-6",
      context: {
        frameworks: ["claude-code/2.1.112"],
        os: "Linux",
        arch: "x64",
        hostname: "omri-pc",
        user: "omria",
        process_name: "claude-code",
        node_version: "v24.15.0",
        python_version: "3.12.1",
        git_branch: "feat/phase-5-tokens",
        git_repo: "flightdeck",
        orchestration: "kubernetes",
      },
    });
    const order = computeFacets([session]).map((g) => g.key);
    expect(order).toEqual([
      "state",
      "flavor",
      "agent_type",
      "model",
      "framework",
      "os",
      "arch",
      "hostname",
      "user",
      "process_name",
      "node_version",
      "python_version",
      "git_branch",
      "git_repo",
      "orchestration",
    ]);
  });
});
