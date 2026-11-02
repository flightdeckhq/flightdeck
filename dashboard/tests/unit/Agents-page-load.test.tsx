import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The Agents page loads the fleet roster through useFleet, once when it
// mounts, as Fleet does. A load of its own, started whenever the roster
// was empty and no load was running, started again each time a load
// ended empty or failed: an empty fleet, or an API failing every load,
// loaded /v1/fleet without pause.

vi.mock("@/lib/api", () => ({
  fetchFleet: vi.fn(),
  fetchSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  fetchCustomDirectives: vi.fn(async () => []),
  // The KPI summaries stay pending; the rows render without them.
  fetchAgentSummary: vi.fn(() => new Promise(() => {})),
  wsAccessTokenQuery: () => "token=test",
}));

import { fetchFleet } from "@/lib/api";
import { Agents } from "@/pages/Agents";
import { useFleetStore } from "@/store/fleet";
import type { AgentSummary } from "@/lib/types";

/** A live stream that never opens, so no update starts a load. */
class QuietSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

/** How many act() rounds ``settle`` runs. A load takes a few microtask
 *  hops and one render to finish, and a page that loads again when a
 *  load ends needs one more render per load, so ten rounds let several
 *  loads run: a loop shows up as more loads than the bound. */
const SETTLE_ROUNDS = 10;

/** A page that loads again whenever a load ends never lets act()
 *  settle, and the test would hang instead of failing. Past this many
 *  calls the mock leaves the load pending, so a loop stops there and
 *  the call count reports it. Well above the one or two loads a mount
 *  makes. */
const LOOP_GUARD_CALLS = 20;

const fetchFleetMock = vi.mocked(fetchFleet);
const NOW_ISO = new Date().toISOString();

function agent(agentId: string): AgentSummary {
  return {
    agent_id: agentId,
    agent_name: agentId,
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
  };
}

function roster(agents: AgentSummary[]) {
  return { agents, total: agents.length, page: 1, per_page: 200, context_facets: {} };
}

/** Answer every fleet load with ``answer`` (see LOOP_GUARD_CALLS). */
function answerLoads(answer: () => ReturnType<typeof fetchFleet>): void {
  fetchFleetMock.mockImplementation(() =>
    fetchFleetMock.mock.calls.length > LOOP_GUARD_CALLS ? new Promise<never>(() => {}) : answer(),
  );
}

/** Let every load the mount started, and any load that led to, run. */
async function settle(): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }
}

/** Open /agents directly, as a deep link does. */
function renderAgents({ strict = false } = {}) {
  const page = (
    <MemoryRouter initialEntries={["/agents"]}>
      <Agents />
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{page}</StrictMode> : page);
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", QuietSocket);
  fetchFleetMock.mockReset();
  useFleetStore.setState({ agents: [], flavors: [], loading: false, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Agents page loads the roster once per visit", () => {
  it("loads an empty fleet a bounded number of times and shows the empty table", async () => {
    answerLoads(async () => roster([]));
    // StrictMode runs mount effects twice, as dev builds do.
    renderAgents({ strict: true });
    await settle();
    const atMount = fetchFleetMock.mock.calls.length;
    expect(atMount).toBeGreaterThanOrEqual(1);
    expect(atMount).toBeLessThanOrEqual(2);

    // The roster stays empty, and nothing loads it again.
    await settle();
    expect(fetchFleetMock).toHaveBeenCalledTimes(atMount);
    expect(screen.getByTestId("agent-table-empty")).toBeTruthy();
  });

  it("does not load again and again when every load fails", async () => {
    answerLoads(async () => {
      throw new Error("API down");
    });
    renderAgents();
    await settle();
    await settle();

    expect(fetchFleetMock).toHaveBeenCalledTimes(1);
    expect(useFleetStore.getState().error).toBe("API down");
    expect(screen.getByTestId("agent-table-empty")).toBeTruthy();
  });

  it("loads a populated fleet once and shows its rows", async () => {
    answerLoads(async () => roster([agent("agent-a"), agent("agent-b")]));
    renderAgents();
    await settle();

    expect(screen.getByTestId("agent-row-agent-a")).toBeTruthy();
    expect(screen.getByTestId("agent-row-agent-b")).toBeTruthy();
    await settle();
    expect(fetchFleetMock).toHaveBeenCalledTimes(1);
  });
});
