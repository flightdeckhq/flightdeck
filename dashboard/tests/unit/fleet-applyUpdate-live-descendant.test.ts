import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the live sub-agent indent gap on /agents.
//
// Pre-fix, applyUpdate's agents[] mirror at the WS-event hot path only
// patched the existing agent's `total_sessions / last_seen_at / state`
// fields — `recent_sessions` was left untouched. Brand-new agents were
// not inserted at all; the store relied on the async `load()`
// refetch kicked off above to bring them in. That broke
// `deriveFamilyDescendantSet` (which resolves parent/child by walking
// `recent_sessions[*].parent_session_id`) for any sub-agent appearing
// live — the linkage didn't land until the next full browser refresh.
//
// The fix:
//   1. Existing-agent session_start: head-prepend the new session into
//      `recent_sessions` so its `parent_session_id` is queryable
//      immediately.
//   2. Brand-new-agent session_start: synthesise an `AgentSummary`
//      row in `agents[]` with `recent_sessions = [new session]` so
//      the descendant resolver sees the agent on the very tick the
//      WS event arrives.
//
// Both branches are asserted below; the test also verifies that
// `deriveFamilyDescendantSet` actually marks the new sub-agent as a
// descendant after the WS event lands.

// `applyUpdate`'s `session_start`-on-a-new-agent branch fires a
// best-effort `load()` that hits the network unless `@/lib/api` is
// mocked. Mock it so the test stays hermetic.
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
import { deriveFamilyDescendantSet } from "@/lib/agents-sort";
import type {
  AgentSummary,
  FleetUpdate,
  RecentSession,
  Session,
} from "@/lib/types";

// ---- builders ------------------------------------------------------------

const NOW_ISO = new Date().toISOString();

const PARENT_AGENT_ID = "agent-parent-001";
const PARENT_SESSION_ID = "sess-parent-001";
const CHILD_AGENT_ID = "agent-child-001";
const CHILD_SESSION_ID = "sess-child-001";

function mkRecentSession(over: Partial<RecentSession> = {}): RecentSession {
  return {
    session_id: "sess-x",
    flavor: "flavor-x",
    agent_type: "coding",
    agent_id: null,
    agent_name: null,
    client_type: null,
    host: null,
    model: null,
    framework: null,
    state: "active",
    started_at: NOW_ISO,
    last_seen_at: NOW_ISO,
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    capture_enabled: false,
    parent_session_id: null,
    agent_role: null,
    ...over,
  };
}

function mkAgent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: "agent-x",
    agent_name: "agent-x",
    agent_type: "coding",
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

function mkSession(over: Partial<Session> = {}): Session {
  return {
    session_id: "sess-x",
    flavor: "flavor-x",
    agent_type: "coding",
    agent_id: null,
    agent_name: null,
    client_type: null,
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

function seedParentOnly(): void {
  useFleetStore.setState({
    agents: [
      mkAgent({
        agent_id: PARENT_AGENT_ID,
        agent_name: "omria@Omri-PC",
        client_type: "claude_code",
        topology: "lone",
        recent_sessions: [
          mkRecentSession({
            session_id: PARENT_SESSION_ID,
            agent_id: PARENT_AGENT_ID,
            agent_name: "omria@Omri-PC",
            client_type: "claude_code",
          }),
        ],
      }),
    ],
    flavors: [],
    enteredBucketAt: new Map<string, number>(),
    shuttingDown: new Set<string>(),
  });
}

function childSessionStart(): FleetUpdate {
  return {
    type: "session_start",
    session: mkSession({
      session_id: CHILD_SESSION_ID,
      flavor: "claude-code",
      agent_id: CHILD_AGENT_ID,
      agent_name: "omria@Omri-PC/general-purpose",
      client_type: "claude_code",
      parent_session_id: PARENT_SESSION_ID,
      agent_role: "general-purpose",
      state: "active",
    }),
  };
}

// ---- tests ---------------------------------------------------------------

describe("fleet store applyUpdate — live sub-agent indent (regression guard)", () => {
  beforeEach(() => {
    seedParentOnly();
  });

  afterEach(() => {
    useFleetStore.setState({
      flavors: [],
      agents: [],
      enteredBucketAt: new Map<string, number>(),
      shuttingDown: new Set<string>(),
    });
  });

  it("synthesises a brand-new agent row with the session in recent_sessions", () => {
    // Parent is alone in the roster pre-event.
    expect(useFleetStore.getState().agents).toHaveLength(1);

    useFleetStore.getState().applyUpdate(childSessionStart());

    const agents = useFleetStore.getState().agents;
    expect(agents).toHaveLength(2);
    const child = agents.find((a) => a.agent_id === CHILD_AGENT_ID);
    expect(child).toBeDefined();
    expect(child?.agent_name).toBe("omria@Omri-PC/general-purpose");
    expect(child?.client_type).toBe("claude_code");
    expect(child?.topology).toBe("child");
    expect(child?.recent_sessions).toHaveLength(1);
    expect(child!.recent_sessions![0].session_id).toBe(CHILD_SESSION_ID);
    expect(child!.recent_sessions![0].parent_session_id).toBe(
      PARENT_SESSION_ID,
    );
    expect(child!.recent_sessions![0].agent_role).toBe("general-purpose");
  });

  it("deriveFamilyDescendantSet resolves the linkage on the same tick the WS event lands", () => {
    // Pre-event: child not present, descendant set empty.
    expect(deriveFamilyDescendantSet(useFleetStore.getState().agents).size).toBe(
      0,
    );

    useFleetStore.getState().applyUpdate(childSessionStart());

    const descendants = deriveFamilyDescendantSet(
      useFleetStore.getState().agents,
    );
    // The child's parent_session_id resolves to the parent's
    // session_id in the parent's recent_sessions → child is marked
    // as a family descendant immediately, no full refetch required.
    expect(descendants.has(CHILD_AGENT_ID)).toBe(true);
    expect(descendants.has(PARENT_AGENT_ID)).toBe(false);
  });

  it("existing-agent session_start head-prepends the new session into recent_sessions", () => {
    // Seed the child agent first so the next session_start hits the
    // existing-agent branch instead of the synth-insert branch.
    useFleetStore.setState({
      agents: [
        ...useFleetStore.getState().agents,
        mkAgent({
          agent_id: CHILD_AGENT_ID,
          agent_name: "omria@Omri-PC/general-purpose",
          client_type: "claude_code",
          topology: "child",
          recent_sessions: [
            mkRecentSession({
              session_id: "sess-child-OLD",
              agent_id: CHILD_AGENT_ID,
              parent_session_id: PARENT_SESSION_ID,
              agent_role: "general-purpose",
            }),
          ],
        }),
      ],
    });

    useFleetStore.getState().applyUpdate(childSessionStart());

    const child = useFleetStore
      .getState()
      .agents.find((a) => a.agent_id === CHILD_AGENT_ID);
    expect(child).toBeDefined();
    expect(child?.total_sessions).toBe(2);
    expect(child?.recent_sessions).toHaveLength(2);
    expect(child!.recent_sessions![0].session_id).toBe(CHILD_SESSION_ID);
    expect(child!.recent_sessions![1].session_id).toBe("sess-child-OLD");
    expect(child!.recent_sessions![0].parent_session_id).toBe(
      PARENT_SESSION_ID,
    );
  });

  it("non-start events leave recent_sessions untouched", () => {
    // First seed the child so the agents[] mirror branch matches it.
    useFleetStore.getState().applyUpdate(childSessionStart());
    const before = useFleetStore
      .getState()
      .agents.find((a) => a.agent_id === CHILD_AGENT_ID);
    const beforeSessions = before?.recent_sessions ?? [];

    // Now apply a non-start update for the same agent.
    useFleetStore.getState().applyUpdate({
      type: "session_update",
      session: mkSession({
        session_id: CHILD_SESSION_ID,
        flavor: "claude-code",
        agent_id: CHILD_AGENT_ID,
        agent_name: "omria@Omri-PC/general-purpose",
        client_type: "claude_code",
        parent_session_id: PARENT_SESSION_ID,
        agent_role: "general-purpose",
        state: "active",
      }),
    });

    const after = useFleetStore
      .getState()
      .agents.find((a) => a.agent_id === CHILD_AGENT_ID);
    expect(after?.total_sessions).toBe(before?.total_sessions);
    expect(after?.recent_sessions).toEqual(beforeSessions);
  });

  it("recent_sessions window caps at 5 entries", () => {
    // Seed an existing child agent already at the 5-entry cap.
    useFleetStore.setState({
      agents: [
        ...useFleetStore.getState().agents,
        mkAgent({
          agent_id: CHILD_AGENT_ID,
          agent_name: "omria@Omri-PC/general-purpose",
          client_type: "claude_code",
          topology: "child",
          recent_sessions: Array.from({ length: 5 }, (_, i) =>
            mkRecentSession({
              session_id: `sess-old-${i}`,
              agent_id: CHILD_AGENT_ID,
              parent_session_id: PARENT_SESSION_ID,
              agent_role: "general-purpose",
            }),
          ),
        }),
      ],
    });

    useFleetStore.getState().applyUpdate(childSessionStart());

    const child = useFleetStore
      .getState()
      .agents.find((a) => a.agent_id === CHILD_AGENT_ID);
    // Head is the new session; tail dropped to keep at 5.
    expect(child?.recent_sessions).toHaveLength(5);
    expect(child!.recent_sessions![0].session_id).toBe(CHILD_SESSION_ID);
    expect(child!.recent_sessions![4].session_id).toBe("sess-old-3");
  });
});
