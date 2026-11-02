import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentSummary, RecentSession } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";

// The fleet store hides orphan agents, rows with no sessions, from the
// Fleet sidebar and swimlane. ``total_sessions`` is a counter the worker
// maintains, and a counter that drifted to 0 (a parent agent whose
// session the worker attributed without counting it) hid a live agent
// with an active session. An agent whose ``recent_sessions`` carries a
// session is therefore never an orphan.

const fetchFleetMock = vi.fn();
const fetchSessionsMock = vi.fn();
const fetchCustomDirectivesMock = vi.fn();

// Vitest hoists vi.mock above the imports, so the store imported above
// reads these mocks.
vi.mock("@/lib/api", () => ({
  fetchFleet: (...args: unknown[]) => fetchFleetMock(...args),
  fetchSessions: (...args: unknown[]) => fetchSessionsMock(...args),
  fetchCustomDirectives: (...args: unknown[]) =>
    fetchCustomDirectivesMock(...args),
}));

const LIVE_ID = "11111111-1111-4111-8111-111111111111";
const COUNTED_ID = "22222222-2222-4222-8222-222222222222";
const ORPHAN_ID = "33333333-3333-4333-8333-333333333333";
const EMPTY_ROLLUP_ID = "44444444-4444-4444-8444-444444444444";

function recentSession(agentId: string, sessionId: string): RecentSession {
  return {
    session_id: sessionId,
    flavor: "orphan-filter-test",
    agent_type: "coding",
    agent_id: agentId,
    client_type: "claude_code",
    state: "active",
    started_at: "2026-11-02T10:00:00Z",
    last_seen_at: "2026-11-02T10:05:00Z",
    tokens_used: 22266,
    capture_enabled: false,
  };
}

function agent(
  agentId: string,
  totalSessions: number,
  recent?: RecentSession[],
): AgentSummary {
  return {
    agent_id: agentId,
    agent_name: `agent-${agentId.slice(0, 4)}`,
    agent_type: "coding",
    client_type: "claude_code",
    user: "test",
    hostname: "host",
    first_seen_at: "2026-11-02T10:00:03Z",
    last_seen_at: "2026-11-02T10:05:00Z",
    total_sessions: totalSessions,
    total_tokens: 22266,
    state: recent?.length ? "active" : "",
    topology: "lone",
    recent_sessions: recent,
  };
}

beforeEach(() => {
  fetchFleetMock.mockReset();
  fetchSessionsMock.mockReset();
  fetchCustomDirectivesMock.mockReset();
  fetchSessionsMock.mockResolvedValue({
    sessions: [],
    total: 0,
    limit: 100,
    offset: 0,
    has_more: false,
  });
  fetchCustomDirectivesMock.mockResolvedValue([]);
  useFleetStore.setState({
    agents: [],
    flavors: [],
    enteredBucketAt: new Map(),
    loading: false,
    error: null,
  });
});

async function loadFleet(agents: AgentSummary[]) {
  fetchFleetMock.mockResolvedValue({
    agents,
    total: agents.length,
    page: 1,
    per_page: 200,
    context_facets: {},
  });
  await useFleetStore.getState().load();
  return useFleetStore.getState().flavors;
}

describe("useFleetStore.load -- orphan agent filter", () => {
  it("keeps an agent whose counter reads 0 but whose recent_sessions carries a session", async () => {
    const flavors = await loadFleet([
      agent(LIVE_ID, 0, [recentSession(LIVE_ID, "deeedb28-0000-4000-8000-000000000001")]),
    ]);

    expect(flavors.map((f) => f.agent_id)).toEqual([LIVE_ID]);
    const [live] = flavors;
    expect(live?.sessions.map((s) => s.session_id)).toEqual([
      "deeedb28-0000-4000-8000-000000000001",
    ]);
    expect(live?.active_count).toBe(1);
  });

  it("still hides an agent with no sessions at all", async () => {
    const flavors = await loadFleet([
      agent(COUNTED_ID, 3, [recentSession(COUNTED_ID, "aaaa0000-0000-4000-8000-000000000002")]),
      agent(ORPHAN_ID, 0),
      agent(EMPTY_ROLLUP_ID, 0, []),
    ]);

    expect(flavors.map((f) => f.agent_id)).toEqual([COUNTED_ID]);
  });

  it("keeps an agent whose counter is positive even before its sessions load", async () => {
    const flavors = await loadFleet([agent(COUNTED_ID, 2)]);

    expect(flavors.map((f) => f.agent_id)).toEqual([COUNTED_ID]);
    expect(flavors[0]?.session_count).toBe(2);
  });
});
