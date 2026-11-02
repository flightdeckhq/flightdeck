import { afterEach, describe, expect, it, vi } from "vitest";

// The worker announces its own state changes on the fleet stream: the
// reconciler marking a run stale or lost, and a child's event reviving
// its parent, arrive as a session_update with the session and no
// last_event; the orphan reaper's close arrives as a session_end
// carrying the synthetic session_end it wrote (close_reason
// orphan_timeout). applyUpdate must apply the run's new state and
// ended_at, re-derive the agent's rolled-up state the way the API
// does, and treat neither kind as activity: no fresh last_seen_at on
// the agent row, no bucket move, no parent-cluster bump, and a row's
// last_seen_at never moves back.

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
import type {
  AgentEvent,
  AgentSummary,
  FlavorSummary,
  FleetUpdate,
  RecentSession,
  Session,
} from "@/lib/types";

const NOW = Date.now();
const iso = (t: number): string => new Date(t).toISOString();

const AGENT = "agent-one";
const RUN = "run-live";
const OTHER_RUN = "run-other";
/** The run's last signal: 3 minutes ago, past the worker's stale threshold. */
const RUN_SEEN = iso(NOW - 3 * 60_000);
/** The agent row's last activity, newer than the run's. */
const ROW_SEEN = iso(NOW - 10_000);
const ROW_ENTERED = NOW - 10_000;

function mkSession(over: Partial<Session> = {}): Session {
  return {
    session_id: RUN,
    flavor: "flavor-one",
    agent_type: "production",
    agent_id: AGENT,
    agent_name: AGENT,
    client_type: "flightdeck_sensor",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: iso(NOW - 10 * 60_000),
    last_seen_at: RUN_SEEN,
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: null,
    agent_role: null,
    context: {},
    capture_enabled: false,
    ...over,
  };
}

function mkRecent(s: Session): RecentSession {
  return {
    session_id: s.session_id,
    flavor: s.flavor,
    agent_type: "production",
    agent_id: s.agent_id,
    agent_name: s.agent_name,
    client_type: "flightdeck_sensor",
    host: null,
    model: null,
    framework: null,
    state: s.state,
    started_at: s.started_at,
    last_seen_at: s.last_seen_at,
    ended_at: s.ended_at ?? null,
    tokens_used: 0,
    token_limit: null,
    capture_enabled: false,
    parent_session_id: s.parent_session_id ?? null,
    agent_role: null,
  };
}

function mkAgent(agentId: string, sessions: Session[], over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: agentId,
    agent_name: agentId,
    agent_type: "production",
    client_type: "flightdeck_sensor",
    user: "demo",
    hostname: "demo-host",
    first_seen_at: iso(NOW - 60 * 60_000),
    last_seen_at: ROW_SEEN,
    total_sessions: sessions.length,
    total_tokens: 0,
    state: "active",
    topology: "lone",
    recent_sessions: sessions.map(mkRecent),
    ...over,
  };
}

function mkFlavor(agentId: string, sessions: Session[], lastSeen = ROW_SEEN): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "production",
    session_count: sessions.length,
    active_count: sessions.filter((s) => s.state === "active").length,
    tokens_used_total: 0,
    sessions,
    agent_id: agentId,
    agent_name: agentId,
    last_seen_at: lastSeen,
  };
}

function mkEvent(over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: "event-1",
    session_id: RUN,
    flavor: "flavor-one",
    event_type: "session_end",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    framework: null,
    client_type: "flightdeck_sensor",
    agent_type: "production",
    occurred_at: iso(NOW),
    ...over,
  };
}

/** One agent whose runs are `sessions`, last active ROW_SEEN. */
function seed(sessions: Session[]): void {
  useFleetStore.setState({
    flavors: [mkFlavor(AGENT, sessions)],
    agents: [mkAgent(AGENT, sessions)],
    enteredBucketAt: new Map([[AGENT, ROW_ENTERED]]),
    shuttingDown: new Set<string>(),
  });
}

const stateChange = (over: Partial<Session>): FleetUpdate => ({
  type: "session_update",
  session: mkSession(over),
});

const row = () => useFleetStore.getState().flavors.find((f) => f.flavor === AGENT);
const agent = () => useFleetStore.getState().agents.find((a) => a.agent_id === AGENT);
const run = (id = RUN) => row()?.sessions.find((s) => s.session_id === id);

afterEach(() => {
  useFleetStore.setState({
    flavors: [],
    agents: [],
    enteredBucketAt: new Map<string, number>(),
    shuttingDown: new Set<string>(),
  });
});

describe("applyUpdate — a state change the worker made, with no event", () => {
  it("moves the run to stale and drops the agent's badge from active", () => {
    seed([mkSession()]);

    useFleetStore.getState().applyUpdate(stateChange({ state: "stale" }));

    expect(run()?.state).toBe("stale");
    expect(row()?.active_count).toBe(0);
    expect(agent()?.state).toBe("stale");
    expect(agent()?.recent_sessions?.[0]?.state).toBe("stale");
  });

  it("is not activity: the agent row keeps its last_seen_at, bucket entry and row position", () => {
    seed([mkSession()]);

    useFleetStore.getState().applyUpdate(stateChange({ state: "stale" }));

    expect(agent()?.last_seen_at).toBe(ROW_SEEN);
    expect(useFleetStore.getState().enteredBucketAt.get(AGENT)).toBe(ROW_ENTERED);
    // The run's own last_seen_at (3 minutes ago) never pulls the
    // swimlane row's newer last_seen_at back.
    expect(row()?.last_seen_at).toBe(ROW_SEEN);
  });

  it("keeps the agent active while another of its runs is active", () => {
    seed([mkSession(), mkSession({ session_id: OTHER_RUN, last_seen_at: ROW_SEEN })]);

    useFleetStore.getState().applyUpdate(stateChange({ state: "stale" }));

    expect(run()?.state).toBe("stale");
    expect(agent()?.state).toBe("active");
    expect(row()?.active_count).toBe(1);
  });

  it("shows a run that went silent past the lost threshold as lost", () => {
    seed([mkSession({ state: "stale" })]);

    useFleetStore.getState().applyUpdate(stateChange({ state: "lost" }));

    expect(run()?.state).toBe("lost");
    expect(agent()?.state).toBe("lost");
  });

  it("takes the newest-started run's state when none is active, as the API does", () => {
    const older = mkSession({
      session_id: OTHER_RUN,
      state: "closed",
      started_at: iso(NOW - 20 * 60_000),
      ended_at: iso(NOW - 15 * 60_000),
    });
    seed([mkSession(), older]);

    useFleetStore.getState().applyUpdate(stateChange({ state: "stale" }));

    expect(agent()?.state).toBe("stale");
  });

  it("does not float the parent's cluster when a child's run changes state", () => {
    const parentRun = mkSession({
      session_id: "parent-run",
      agent_id: "parent-agent",
      agent_name: "parent-agent",
    });
    const childRun = mkSession({ parent_session_id: "parent-run" });
    const parentSeen = iso(NOW - 30 * 60_000);
    useFleetStore.setState({
      flavors: [mkFlavor("parent-agent", [parentRun], parentSeen), mkFlavor(AGENT, [childRun])],
      agents: [mkAgent(AGENT, [childRun])],
      enteredBucketAt: new Map([
        ["parent-agent", NOW - 30 * 60_000],
        [AGENT, ROW_ENTERED],
      ]),
      shuttingDown: new Set<string>(),
    });

    useFleetStore
      .getState()
      .applyUpdate(stateChange({ state: "stale", parent_session_id: "parent-run" }));

    const parent = useFleetStore.getState().flavors.find((f) => f.flavor === "parent-agent");
    expect(parent?.last_seen_at).toBe(parentSeen);
    expect(useFleetStore.getState().enteredBucketAt.get("parent-agent")).toBe(NOW - 30 * 60_000);
  });

  it("ignores a state change for a run the page does not hold", () => {
    seed([mkSession()]);
    const before = useFleetStore.getState().flavors;

    // A run of an agent this page never loaded goes stale...
    useFleetStore.getState().applyUpdate(
      stateChange({ session_id: "run-elsewhere", agent_id: "agent-elsewhere", state: "stale" }),
    );
    // ...and a run of a loaded agent that the page does not hold is
    // reaped: neither adds a row or a run.
    useFleetStore.getState().applyUpdate({
      type: "session_end",
      session: mkSession({ session_id: "run-unloaded", state: "closed", ended_at: iso(NOW) }),
      last_event: mkEvent({ session_id: "run-unloaded", payload: { close_reason: "orphan_timeout" } }),
    });

    expect(useFleetStore.getState().flavors).toBe(before);
    expect(row()?.sessions.map((s) => s.session_id)).toEqual([RUN]);
    expect(agent()?.state).toBe("active");
  });

  it("shows a parent revived by its child as active, taking its fresh last_seen_at", () => {
    const revivedAt = iso(NOW - 1_000);
    seed([mkSession({ state: "stale", last_seen_at: iso(NOW - 5 * 60_000) })]);
    useFleetStore.setState({ agents: [mkAgent(AGENT, [mkSession({ state: "stale" })], { state: "stale" })] });

    useFleetStore.getState().applyUpdate(stateChange({ state: "active", last_seen_at: revivedAt }));

    expect(run()?.state).toBe("active");
    expect(agent()?.state).toBe("active");
    expect(row()?.last_seen_at).toBe(revivedAt);
  });
});

describe("applyUpdate — closes", () => {
  it("applies the reaper's close and its ended_at without counting it as activity", () => {
    const endedAt = iso(NOW);
    seed([mkSession({ state: "lost" })]);

    useFleetStore.getState().applyUpdate({
      type: "session_end",
      session: mkSession({ state: "closed", ended_at: endedAt }),
      last_event: mkEvent({ payload: { close_reason: "orphan_timeout" } }),
    });

    expect(run()?.state).toBe("closed");
    expect(run()?.ended_at).toBe(endedAt);
    expect(agent()?.state).toBe("closed");
    expect(agent()?.recent_sessions?.[0]?.ended_at).toBe(endedAt);
    expect(agent()?.last_seen_at).toBe(ROW_SEEN);
    expect(useFleetStore.getState().enteredBucketAt.get(AGENT)).toBe(ROW_ENTERED);
  });

  it("drops the badge on a normal close too, which is activity", () => {
    seed([mkSession()]);

    useFleetStore.getState().applyUpdate({
      type: "session_end",
      session: mkSession({ state: "closed", ended_at: iso(NOW), last_seen_at: iso(NOW) }),
      last_event: mkEvent({ payload: { close_reason: "normal_exit" } }),
    });

    expect(agent()?.state).toBe("closed");
    expect(new Date(agent()!.last_seen_at).getTime()).toBeGreaterThan(new Date(ROW_SEEN).getTime());
  });

  it("never moves a row's last_seen_at back for an event on an older run", () => {
    seed([mkSession({ last_seen_at: ROW_SEEN }), mkSession({ session_id: OTHER_RUN, state: "closed" })]);

    useFleetStore.getState().applyUpdate({
      type: "session_update",
      session: mkSession({ session_id: OTHER_RUN, state: "closed", last_seen_at: RUN_SEEN }),
      last_event: mkEvent({ session_id: OTHER_RUN, event_type: "post_call" }),
    });

    expect(row()?.last_seen_at).toBe(ROW_SEEN);
  });
});
