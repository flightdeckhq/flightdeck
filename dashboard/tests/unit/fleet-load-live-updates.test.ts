import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// load() fetches a snapshot of the fleet. The API reads it at some
// point while the request is out, so a live update broadcast after that
// read can reach the page before the response does, and the worker sends
// each state change once. The store must not let the older snapshot
// undo such an update: it re-applies them in the order they arrived,
// so an agent's badge ends on the one sent last, without counting a
// run the snapshot already counts, and without letting them start
// loads of their own. One load of a view runs at a time: calls for the
// view in flight get one more load after it, rather than a load each
// that drops the one before (which a stream of calls would starve),
// and only a load of another view supersedes the one in flight.

const { fleetCalls, sessionsCalls, deferred } = vi.hoisted(() => {
  type Deferred = {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  };
  const make = (): Deferred => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  return { fleetCalls: [] as Deferred[], sessionsCalls: [] as Deferred[], deferred: make };
});

vi.mock("@/lib/api", () => ({
  fetchFleet: vi.fn(() => {
    const d = deferred();
    fleetCalls.push(d);
    return d.promise;
  }),
  fetchSessions: vi.fn(() => {
    const d = deferred();
    sessionsCalls.push(d);
    return d.promise;
  }),
  fetchCustomDirectives: vi.fn(async () => []),
}));

import { fetchFleet } from "@/lib/api";
import { useFleetStore } from "@/store/fleet";
import type {
  AgentEvent,
  AgentSummary,
  FleetUpdate,
  RecentSession,
  Session,
  SessionState,
} from "@/lib/types";

const NOW_ISO = new Date().toISOString();
const AGENT = "agent-r";
const RUN = "run-r";

function session(over: Partial<Session> = {}): Session {
  return {
    session_id: RUN,
    flavor: "flavor-r",
    agent_type: "production",
    agent_id: AGENT,
    agent_name: AGENT,
    client_type: "flightdeck_sensor",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: NOW_ISO,
    last_seen_at: NOW_ISO,
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

/** The run as GET /v1/sessions lists it. */
function listItem(state: SessionState, over: Partial<Session> = {}) {
  const s = session({ state, ...over });
  return { ...s, token_name: null };
}

/** The run as an agent's ``recent_sessions`` lists it. */
function recentOf(runId: string): RecentSession {
  return {
    session_id: runId,
    flavor: "flavor-r",
    agent_type: "production",
    agent_id: AGENT,
    state: "active",
    started_at: NOW_ISO,
    last_seen_at: NOW_ISO,
    tokens_used: 0,
    capture_enabled: false,
  };
}

function eventOf(runId: string, eventType: AgentEvent["event_type"]): AgentEvent {
  return {
    id: `${eventType}-${runId}`,
    session_id: runId,
    flavor: "flavor-r",
    event_type: eventType,
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
    occurred_at: NOW_ISO,
  } as AgentEvent;
}

/** A new run of the agent starts. */
const runStart = (runId: string): FleetUpdate => ({
  type: "session_start",
  session: session({ session_id: runId }),
  last_event: eventOf(runId, "session_start"),
  agent_state: "active",
});

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: AGENT,
    agent_name: AGENT,
    agent_type: "production",
    client_type: "flightdeck_sensor",
    user: "demo",
    hostname: "demo-host",
    first_seen_at: NOW_ISO,
    last_seen_at: NOW_ISO,
    total_sessions: 1,
    total_tokens: 0,
    state: "active",
    topology: "lone",
    recent_sessions: [],
    ...over,
  };
}

function fleetWith(agents: AgentSummary[]) {
  return { agents, total: agents.length, page: 1, per_page: 200, context_facets: {} };
}

/** Answer the load numbered ``i`` (in call order). */
async function answer(i: number, agents: AgentSummary[], items: unknown[]): Promise<void> {
  fleetCalls[i]!.resolve(fleetWith(agents));
  sessionsCalls[i]!.resolve({ sessions: items, total: items.length });
}

function seedHeld(state: SessionState): void {
  useFleetStore.setState({
    flavors: [
      {
        flavor: AGENT,
        agent_type: "production",
        session_count: 1,
        active_count: state === "active" ? 1 : 0,
        tokens_used_total: 0,
        sessions: [session({ state })],
        agent_id: AGENT,
        agent_name: AGENT,
        last_seen_at: NOW_ISO,
      },
    ],
    agents: [agent({ state })],
  });
}

const stateChange = (state: SessionState): FleetUpdate => ({
  type: "session_update",
  session: session({ state }),
  agent_state: state,
});

const run = () =>
  useFleetStore
    .getState()
    .flavors.find((f) => f.flavor === AGENT)
    ?.sessions.find((s) => s.session_id === RUN);
const agentRow = () => useFleetStore.getState().agents.find((a) => a.agent_id === AGENT);

beforeEach(() => {
  fleetCalls.length = 0;
  sessionsCalls.length = 0;
  vi.mocked(fetchFleet).mockClear();
});

afterEach(() => {
  useFleetStore.setState({
    flavors: [],
    agents: [],
    loading: false,
    error: null,
    agentTypeFilter: "all",
  });
});

describe("load() and live updates that arrive while it is in flight", () => {
  it("keeps a state change that lands before the older snapshot does", async () => {
    seedHeld("active");
    const loading = useFleetStore.getState().load();

    // The reconciler marks the run stale after the API read the
    // snapshot; its broadcast reaches the page first.
    useFleetStore.getState().applyUpdate(stateChange("stale"));
    expect(run()?.state).toBe("stale");

    // The snapshot lands, still saying active.
    await answer(0, [agent({ state: "active" })], [listItem("active")]);
    await loading;

    expect(run()?.state).toBe("stale");
    expect(agentRow()?.state).toBe("stale");
  });

  it("lets the snapshot win over an update applied before the load started", async () => {
    seedHeld("active");
    // Applied before the load: the snapshot the load reads is newer
    // (here the run revived since), so the update is not re-applied.
    useFleetStore.getState().applyUpdate(stateChange("stale"));
    const loading = useFleetStore.getState().load();

    await answer(0, [agent({ state: "active" })], [listItem("active")]);
    await loading;

    expect(run()?.state).toBe("active");
  });

  it("drops the result of a load that a load of another view superseded", async () => {
    const first = useFleetStore.getState().load();
    // The type filter changes while the first load is out.
    const second = useFleetStore.getState().load({ agentType: "coding" });
    expect(fetchFleet).toHaveBeenCalledTimes(2);

    // The newer load answers first...
    await answer(1, [agent({ agent_name: "coding roster" })], []);
    await second;
    // ...and the older one later, with the roster of the old view.
    await answer(0, [agent({ agent_name: "all roster" })], []);
    await first;

    expect(agentRow()?.agent_name).toBe("coding roster");
    expect(useFleetStore.getState().agentTypeFilter).toBe("coding");
    expect(fetchFleet).toHaveBeenCalledTimes(2);
  });

  it("lands the load in flight when more calls for its view arrive, then loads once more", async () => {
    const first = useFleetStore.getState().load();
    // Pages mounting together, a new agent, a reconnect: none of these
    // starts a load that would drop the first one's result.
    void useFleetStore.getState().load();
    void useFleetStore.getState().load();
    void useFleetStore.getState().load();
    expect(fetchFleet).toHaveBeenCalledTimes(1);

    await answer(0, [agent({ agent_name: "first roster" })], []);
    await first;

    // The first result is shown, and one load runs for the three calls.
    expect(agentRow()?.agent_name).toBe("first roster");
    expect(fetchFleet).toHaveBeenCalledTimes(2);

    await answer(1, [agent({ agent_name: "roster read after the calls" })], []);
    await vi.waitFor(() =>
      expect(agentRow()?.agent_name).toBe("roster read after the calls"),
    );
    expect(useFleetStore.getState().loading).toBe(false);
    expect(fetchFleet).toHaveBeenCalledTimes(2);
  });

  it("gives a new agent whose run starts during a load its row from one more load", async () => {
    const NEW_AGENT = "agent-n";
    const loading = useFleetStore.getState().load();

    useFleetStore.getState().applyUpdate({
      type: "session_start",
      session: session({ session_id: "run-n", agent_id: NEW_AGENT, agent_name: NEW_AGENT }),
      agent_state: "active",
    });
    // No second load while the first is out.
    expect(fetchFleet).toHaveBeenCalledTimes(1);

    // The snapshot was read before the run started.
    await answer(0, [], []);
    await loading;

    // The replayed start draws the agent from the update alone...
    const synthesised = useFleetStore.getState().agents.find((a) => a.agent_id === NEW_AGENT);
    expect(synthesised?.total_tokens).toBe(0);
    expect(fetchFleet).toHaveBeenCalledTimes(2);

    // ...and the next load brings the API's row for it.
    await answer(1, [agent({ agent_id: NEW_AGENT, agent_name: NEW_AGENT, total_tokens: 42 })], []);
    await vi.waitFor(() =>
      expect(
        useFleetStore.getState().agents.find((a) => a.agent_id === NEW_AGENT)?.total_tokens,
      ).toBe(42),
    );
    expect(fetchFleet).toHaveBeenCalledTimes(2);
  });

  it("still runs the load a call asked for when the load in flight fails", async () => {
    const first = useFleetStore.getState().load();
    // The reconnect's catch-up, while a load the restarting API is
    // about to fail is out.
    void useFleetStore.getState().load();

    fleetCalls[0]!.reject(new Error("API restarting"));
    sessionsCalls[0]!.resolve({ sessions: [], total: 0 });
    await first;
    expect(fetchFleet).toHaveBeenCalledTimes(2);

    await answer(1, [agent({ agent_name: "after the restart" })], []);
    await vi.waitFor(() => expect(agentRow()?.agent_name).toBe("after the restart"));
    expect(useFleetStore.getState().error).toBeNull();
  });

  it("re-applies a run start of an agent the snapshot lacks without loading again", async () => {
    seedHeld("active");
    const loading = useFleetStore.getState().load();

    // A new run of the agent starts meanwhile. The agent is on the
    // page, so this needs no load of its own.
    const started = runStart("run-r-2");
    useFleetStore.getState().applyUpdate(started);
    expect(fetchFleet).toHaveBeenCalledTimes(1);

    // The snapshot no longer lists the agent (say, filtered out).
    await answer(0, [], []);
    await loading;

    // The re-applied start draws the run again, and loads nothing.
    expect(
      useFleetStore
        .getState()
        .flavors.find((f) => f.flavor === AGENT)
        ?.sessions.map((s) => s.session_id),
    ).toEqual(["run-r-2"]);
    expect(fetchFleet).toHaveBeenCalledTimes(1);
  });

  it("ends an agent's badge on the update that arrived last, across its runs", async () => {
    const R1 = RUN;
    const R2 = "run-r-2";
    useFleetStore.setState({
      flavors: [
        {
          flavor: AGENT,
          agent_type: "production",
          session_count: 2,
          active_count: 2,
          tokens_used_total: 0,
          sessions: [session({ session_id: R2 }), session({ session_id: R1 })],
          agent_id: AGENT,
          agent_name: AGENT,
          last_seen_at: NOW_ISO,
        },
      ],
      agents: [agent({ state: "active" })],
    });
    const loading = useFleetStore.getState().load();
    const apply = (u: FleetUpdate) => useFleetStore.getState().applyUpdate(u);

    // While the load is out: R1 sends an event, then R2 does...
    apply({
      type: "session_update",
      session: session({ session_id: R1 }),
      last_event: eventOf(R1, "post_call"),
      agent_state: "active",
    });
    apply({
      type: "session_update",
      session: session({ session_id: R2 }),
      last_event: eventOf(R2, "post_call"),
      agent_state: "active",
    });
    // ...R2 closes while R1 is still active...
    apply({
      type: "session_end",
      session: session({ session_id: R2, state: "closed", ended_at: NOW_ISO }),
      agent_state: "active",
    });
    // ...and then R1 goes stale, which leaves the agent no active run.
    apply({
      type: "session_update",
      session: session({ session_id: R1, state: "stale" }),
      agent_state: "stale",
    });
    expect(agentRow()?.state).toBe("stale");

    // The snapshot was read before all of it.
    await answer(
      0,
      [agent({ state: "active" })],
      [listItem("active", { session_id: R2 }), listItem("active", { session_id: R1 })],
    );
    await loading;

    expect(agentRow()?.state).toBe("stale");
  });

  it("does not count again a run start that the snapshot already counts", async () => {
    seedHeld("active");
    const loading = useFleetStore.getState().load();

    // A new run of the agent starts while the load is out...
    useFleetStore.getState().applyUpdate(runStart("run-r-2"));

    // ...and the API read the snapshot after it: the run is counted.
    await answer(
      0,
      [agent({ total_sessions: 2, recent_sessions: [recentOf("run-r-2"), recentOf(RUN)] })],
      [listItem("active", { session_id: "run-r-2" }), listItem("active")],
    );
    await loading;

    expect(agentRow()?.total_sessions).toBe(2);
  });

  it("counts a run whose start arrives twice once", () => {
    seedHeld("active");
    useFleetStore.getState().applyUpdate(runStart("run-r-2"));
    useFleetStore.getState().applyUpdate(runStart("run-r-2"));

    expect(agentRow()?.total_sessions).toBe(2);
  });
});
