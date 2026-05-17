import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Polish Batch 2 Fix 5 — swimlane cluster re-sort. When a fleet
// WebSocket event arrives for a sub-agent session (one carrying a
// `parent_session_id`), applyUpdate resolves the PARENT flavor by
// scanning every loaded flavor for a session whose session_id
// matches that parent_session_id. It then bumps the parent flavor's
// `last_seen_at` to now (lifting the parent + sub-agent cluster out
// of the IDLE bucket — bucketFor keys on last_seen_at) and advances
// the parent's `enteredBucketAt` entry (floats the cluster to the
// top within the LIVE bucket).
//
// The backend already bumps the parent SESSION's last_seen_at, but
// the WS envelope only carries the child's session — so without
// this client-side bump the parent's swimlane row stays frozen in
// its stale bucket and the cluster never bubbles up. This test
// exercises that applyUpdate branch directly against the store.

// applyUpdate's `session_start`-on-a-new-agent branch fires a
// best-effort `load()`, which hits the network unless `@/lib/api`
// is mocked. The parent-bump branch under test fires on
// `session_update` for an already-loaded agent so it never reaches
// load(), but mock the module anyway so an unexpected refetch can
// never make the suite flaky / network-bound.
vi.mock("@/lib/api", () => ({
  fetchFleet: vi.fn(async () => ({
    agents: [],
    total: 0,
    page: 1,
    per_page: 200,
    context_facets: {},
  })),
  fetchSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  fetchCustomDirectives: vi.fn(async () => []),
}));

import { useFleetStore } from "@/store/fleet";
import { bucketFor } from "@/lib/fleet-ordering";
import type { FlavorSummary, FleetUpdate, Session } from "@/lib/types";

// ---- builders ------------------------------------------------------------

const NOW = Date.now();
const iso = (t: number): string => new Date(t).toISOString();

// Old enough that bucketFor classifies it as IDLE (> 5 min).
const IDLE_AGO = iso(NOW - 30 * 60_000);

function mkSession(over: Partial<Session> = {}): Session {
  return {
    session_id: "sess-x",
    flavor: "flavor-x",
    agent_type: "coding",
    agent_id: "flavor-x",
    agent_name: "agent-x",
    client_type: null,
    host: null,
    framework: null,
    model: null,
    state: "closed",
    started_at: IDLE_AGO,
    last_seen_at: IDLE_AGO,
    ended_at: IDLE_AGO,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: null,
    agent_role: null,
    context: {},
    ...over,
  };
}

function mkFlavor(over: Partial<FlavorSummary> = {}): FlavorSummary {
  return {
    flavor: "flavor-x",
    agent_type: "coding",
    session_count: 1,
    active_count: 0,
    tokens_used_total: 0,
    sessions: [],
    agent_id: "flavor-x",
    agent_name: "agent-x",
    last_seen_at: IDLE_AGO,
    ...over,
  };
}

const PARENT_SESSION_ID = "parent-session-001";
const CHILD_SESSION_ID = "child-session-001";

// A parent flavor with a single old (IDLE) session, and a separate
// child flavor whose session points back at the parent's session.
function seedStore(): void {
  const parentSession = mkSession({
    session_id: PARENT_SESSION_ID,
    flavor: "parent-agent",
    agent_id: "parent-agent",
    agent_name: "parent-agent",
  });
  const childSession = mkSession({
    session_id: CHILD_SESSION_ID,
    flavor: "child-agent",
    agent_id: "child-agent",
    agent_name: "child-agent",
    parent_session_id: PARENT_SESSION_ID,
    agent_role: "Explore",
  });

  useFleetStore.setState({
    flavors: [
      mkFlavor({
        flavor: "parent-agent",
        agent_id: "parent-agent",
        agent_name: "parent-agent",
        sessions: [parentSession],
        last_seen_at: IDLE_AGO,
      }),
      mkFlavor({
        flavor: "child-agent",
        agent_id: "child-agent",
        agent_name: "child-agent",
        sessions: [childSession],
        last_seen_at: IDLE_AGO,
      }),
    ],
    agents: [],
    // Parent + child both seeded as IDLE-era entries.
    enteredBucketAt: new Map<string, number>([
      ["parent-agent", NOW - 30 * 60_000],
      ["child-agent", NOW - 30 * 60_000],
    ]),
    shuttingDown: new Set<string>(),
  });
}

// A FleetUpdate for the child session — agent_id NOT null so the
// agents[]-mirror branch is exercised too, and parent_session_id set
// so the parent-bump branch fires.
function childUpdate(): FleetUpdate {
  return {
    type: "session_update",
    session: mkSession({
      session_id: CHILD_SESSION_ID,
      flavor: "child-agent",
      agent_id: "child-agent",
      agent_name: "child-agent",
      parent_session_id: PARENT_SESSION_ID,
      agent_role: "Explore",
      state: "active",
      last_seen_at: iso(NOW),
    }),
  };
}

// ---- tests ---------------------------------------------------------------

describe("fleet store applyUpdate — sub-agent parent-bump (Fix 5)", () => {
  beforeEach(() => {
    seedStore();
  });

  afterEach(() => {
    useFleetStore.setState({
      flavors: [],
      agents: [],
      enteredBucketAt: new Map<string, number>(),
      shuttingDown: new Set<string>(),
    });
  });

  it("advances the parent flavor's last_seen_at when a sub-agent event arrives", () => {
    const before = useFleetStore
      .getState()
      .flavors.find((f) => f.flavor === "parent-agent");
    expect(before?.last_seen_at).toBe(IDLE_AGO);
    // Sanity: the parent starts in the IDLE bucket.
    expect(bucketFor(before?.last_seen_at, Date.now())).toBe("idle");

    useFleetStore.getState().applyUpdate(childUpdate());

    const after = useFleetStore
      .getState()
      .flavors.find((f) => f.flavor === "parent-agent");
    // last_seen_at moved forward to ~now.
    expect(after?.last_seen_at).not.toBe(IDLE_AGO);
    const advancedMs = new Date(after!.last_seen_at!).getTime();
    expect(advancedMs).toBeGreaterThan(new Date(IDLE_AGO).getTime());
    // The cluster has bubbled out of IDLE into the LIVE bucket.
    expect(bucketFor(after?.last_seen_at, Date.now())).toBe("live");
  });

  it("advances the parent flavor's enteredBucketAt entry on the bucket crossing", () => {
    const beforeEntry = useFleetStore
      .getState()
      .enteredBucketAt.get("parent-agent");
    expect(beforeEntry).toBe(NOW - 30 * 60_000);

    useFleetStore.getState().applyUpdate(childUpdate());

    const afterEntry = useFleetStore
      .getState()
      .enteredBucketAt.get("parent-agent");
    // The IDLE→LIVE crossing advances the entry to ~now so the
    // cluster floats to the top of the LIVE bucket.
    expect(afterEntry).toBeDefined();
    expect(afterEntry!).toBeGreaterThan(beforeEntry!);
  });

  it("does not bump any flavor when the update carries no parent_session_id", () => {
    // A root-session update — no parent_session_id — must leave every
    // OTHER flavor's last_seen_at untouched.
    const rootUpdate: FleetUpdate = {
      type: "session_update",
      session: mkSession({
        session_id: CHILD_SESSION_ID,
        flavor: "child-agent",
        agent_id: "child-agent",
        agent_name: "child-agent",
        parent_session_id: null,
        state: "active",
        last_seen_at: iso(NOW),
      }),
    };
    useFleetStore.getState().applyUpdate(rootUpdate);

    const parent = useFleetStore
      .getState()
      .flavors.find((f) => f.flavor === "parent-agent");
    expect(parent?.last_seen_at).toBe(IDLE_AGO);
  });

  it("does not bump when the parent_session_id resolves to no loaded flavor", () => {
    // Best-effort contract: an orphan parent_session_id (parent row
    // not loaded yet) is skipped silently — no crash, no spurious
    // bump on the child's own flavor.
    const orphanUpdate: FleetUpdate = {
      type: "session_update",
      session: mkSession({
        session_id: CHILD_SESSION_ID,
        flavor: "child-agent",
        agent_id: "child-agent",
        agent_name: "child-agent",
        parent_session_id: "parent-not-in-store",
        state: "active",
        last_seen_at: iso(NOW),
      }),
    };
    expect(() =>
      useFleetStore.getState().applyUpdate(orphanUpdate),
    ).not.toThrow();

    const parent = useFleetStore
      .getState()
      .flavors.find((f) => f.flavor === "parent-agent");
    expect(parent?.last_seen_at).toBe(IDLE_AGO);
  });
});
