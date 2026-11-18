import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Activity } from "lucide-react";
import { AgentDrawer } from "@/components/agents/AgentDrawer";
import { RUNS_CHIP_BORDER, RUNS_CHIP_TINT } from "@/components/timeline/SwimLane";
import { useFleetStore } from "@/store/fleet";
import { ClientType } from "@/lib/agent-identity";
import { runsAtOnceShown } from "@/lib/swimlane-lanes";
import type { AgentSummary, FlavorSummary, Session, SessionsResponse } from "@/lib/types";

// The agent drawer's "Open in swimlane": with two or more of the agent's
// runs at once in the window the per-agent modal opens with (1m ending
// now), it reads "Open in swimlane · N runs" in the runs chip's accent,
// with the full count in its name and tooltip; with one run at once or
// none it is the plain button, its markup unchanged. It follows runs as
// they start and end and as the window slides, re-rendering itself and
// not the drawer.

const empty: SessionsResponse = { sessions: [], total: 0, limit: 50, offset: 0, has_more: false };
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSessions: vi.fn(async () => empty),
    fetchBulkEvents: vi.fn(async () => ({ events: [], total: 0, limit: 50, offset: 0, has_more: false })),
  };
});
// The Events tab renders once per drawer render: its count is the
// drawer's.
const renders = vi.hoisted(() => ({ drawer: 0 }));
vi.mock("@/components/agents/AgentDrawerEventsTab", () => ({
  AgentDrawerEventsTab: () => {
    renders.drawer += 1;
    return <div data-testid="events-tab-stub" />;
  },
}));
// The button prints its count once per render while it shows one.
vi.mock("@/lib/swimlane-lanes", async (orig) => {
  const actual = await orig<typeof import("@/lib/swimlane-lanes")>();
  return { ...actual, runsAtOnceShown: vi.fn(actual.runsAtOnceShown) };
});

const S = 1000;
let now = 0;

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: "agent-1",
    agent_name: "general-purpose",
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    first_seen_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-05-15T12:00:00Z",
    total_sessions: 1,
    total_tokens: 100,
    state: "active",
    topology: "lone",
    ...over,
  };
}

let seq = 0;
/** A run of agent-1 started ``startedAgoMs`` before now: open (active),
 *  or ended ``endedAgoMs`` before now. */
function run(startedAgoMs: number, endedAgoMs?: number): Session {
  seq += 1;
  return {
    session_id: `r${String(seq).padStart(7, "0")}-0000-4000-8000-000000000000`,
    flavor: "agent-1",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: endedAgoMs === undefined ? "active" : "closed",
    started_at: new Date(now - startedAgoMs).toISOString(),
    last_seen_at: new Date(now - (endedAgoMs ?? 0)).toISOString(),
    ended_at: endedAgoMs === undefined ? null : new Date(now - endedAgoMs).toISOString(),
    tokens_used: 0,
    token_limit: null,
  };
}

function flavor(agentId: string, sessions: Session[]): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: sessions.length,
    tokens_used_total: 0,
    sessions,
    agent_id: agentId,
    agent_name: agentId,
  };
}

function seed(sessions: Session[], others: FlavorSummary[] = []) {
  useFleetStore.setState({ agents: [agent()], flavors: [flavor("agent-1", sessions), ...others] });
}

async function openDrawer() {
  const view = render(
    <MemoryRouter>
      <AgentDrawer agentId="agent-1" onClose={() => {}} onSelectAgent={() => {}} />
    </MemoryRouter>,
  );
  await act(async () => {});
  return view;
}

const button = () => screen.getByTestId("agent-drawer-open-swimlane");

/** The button reads as the plain one after a count went away: the same
 *  element patched (so a focus on it stays), its name, text, look and
 *  attributes the plain button's. */
function expectPlain() {
  const b = button();
  expect(b).toHaveAccessibleName("Open general-purpose in swimlane");
  expect(b.textContent).toBe("Open in swimlane");
  expect(b).not.toHaveAttribute("data-run-count");
  expect(b).not.toHaveAttribute("title");
  expect(b.style.background).toBe("transparent");
  expect(b.style.border).toBe("1px solid var(--border)");
  expect(b.querySelector("svg")!.style.color).toBe("");
}

/** The button as it reads with one run at once or none: the markup the
 *  drawer has always drawn, rendered as the drawer renders it. */
function plainMarkup(): string {
  const { container, unmount } = render(
  <button
    type="button"
    data-testid="agent-drawer-open-swimlane"
    aria-label="Open general-purpose in swimlane"
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      fontSize: 11,
      fontFamily: "var(--font-mono)",
      color: "var(--text)",
      background: "transparent",
      border: "1px solid var(--border)",
      borderRadius: 4,
      padding: "4px 9px",
      cursor: "pointer",
    }}
  >
    <Activity size={12} aria-hidden="true" />
    Open in swimlane
  </button>,
    { container: document.createElement("div") },
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

beforeEach(() => {
  // A clock the test moves: the window the button counts in, and its
  // once-a-second re-read.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.parse("2026-11-18T10:00:00.400Z"));
  now = Date.now();
  renders.drawer = 0;
});

afterEach(() => {
  useFleetStore.setState({ agents: [], flavors: [] });
  vi.useRealTimers();
});

describe("AgentDrawer Open in swimlane", () => {
  it("is the plain button, its markup unchanged, with one run", async () => {
    seed([run(20 * S)]);
    await openDrawer();
    expect(button().outerHTML).toBe(plainMarkup());
  });

  it("is the plain button with no run, and with runs one after another", async () => {
    seed([]);
    const { unmount } = await openDrawer();
    expect(button().outerHTML).toBe(plainMarkup());
    unmount();
    // Two runs in the window that never run at once.
    seed([run(50 * S, 40 * S), run(30 * S, 10 * S)]);
    await openDrawer();
    expect(button().outerHTML).toBe(plainMarkup());
  });

  it.each([
    [2, "2"],
    [3, "3"],
    [10, "9+"],
  ])("names %i runs at once: label, accessible name, tooltip and number", async (n, shown) => {
    seed(Array.from({ length: n }, () => run(20 * S)));
    await openDrawer();
    const b = button();
    expect(b).toHaveTextContent(`Open in swimlane · ${shown} runs`);
    expect(b).toHaveAccessibleName(`Open general-purpose in swimlane, ${n} runs at once`);
    expect(b).toHaveAttribute("title", `${n} runs at once: each gets its own lane`);
    expect(b).toHaveAttribute("data-run-count", String(n));
    // The runs chip's accent, the text in --text.
    expect(b.style.background).toBe(RUNS_CHIP_TINT);
    expect(b.style.border).toBe(`1px solid ${RUNS_CHIP_BORDER}`);
    expect(b.style.color).toBe("var(--text)");
  });

  it("counts as the Fleet chip does: runs overlapping at one instant, not runs in the window", async () => {
    // Two at once, and a third that ended before they started.
    seed([run(55 * S, 45 * S), run(30 * S), run(25 * S)]);
    await openDrawer();
    expect(button()).toHaveAttribute("data-run-count", "2");
    expect(runsAtOnceShown).toHaveBeenLastCalledWith(2);
  });

  it("follows runs as they start and end, live", async () => {
    const first = run(20 * S);
    seed([first]);
    await openDrawer();
    expect(button().outerHTML).toBe(plainMarkup());
    const second = run(5 * S);
    const third = run(2 * S);
    act(() => seed([first, second, third]));
    expect(button()).toHaveTextContent("Open in swimlane · 3 runs");
    // Two end now: one run at once from here on, but the window still
    // holds the three overlapping.
    act(() =>
      seed([
        first,
        { ...second, state: "closed", ended_at: new Date(now).toISOString() },
        { ...third, state: "closed", ended_at: new Date(now).toISOString() },
      ]),
    );
    expect(button()).toHaveTextContent("Open in swimlane · 3 runs");
    // A minute on, the window holds the first run alone.
    act(() => {
      vi.advanceTimersByTime(61 * S);
    });
    expectPlain();
  });

  it("keeps the keyboard focus as the count appears: the same button, patched", async () => {
    const first = run(20 * S);
    seed([first]);
    await openDrawer();
    const before = button();
    before.focus();
    act(() => seed([first, run(5 * S)]));
    expect(button()).toBe(before);
    expect(button()).toHaveFocus();
    expect(button()).toHaveTextContent("Open in swimlane · 2 runs");
  });

  it("re-reads the window as it slides, re-rendering the button and not the drawer", async () => {
    // Two runs that overlapped and ended 50 s ago: in the 1m window for
    // ten more seconds.
    seed([run(58 * S, 50 * S), run(56 * S, 50 * S)]);
    await openDrawer();
    expect(button()).toHaveAttribute("data-run-count", "2");
    const drawerRenders = renders.drawer;
    act(() => {
      vi.advanceTimersByTime(5 * S);
    });
    expect(button()).toHaveAttribute("data-run-count", "2");
    act(() => {
      vi.advanceTimersByTime(6 * S);
    });
    expectPlain();
    // Eleven ticks of the button's clock, no drawer render.
    expect(renders.drawer).toBe(drawerRenders);
  });

  it("is not re-rendered by a drawer render it has nothing to do with", async () => {
    seed([run(20 * S), run(10 * S), run(5 * S)], [flavor("agent-2", [])]);
    await openDrawer();
    const shownCalls = vi.mocked(runsAtOnceShown).mock.calls.length;
    const drawerRenders = renders.drawer;
    // Another agent's runs change: the drawer, which reads the fleet
    // store, renders; the button, whose agent's runs did not change,
    // does not.
    const { flavors } = useFleetStore.getState();
    act(() =>
      useFleetStore.setState({ flavors: [flavors[0]!, flavor("agent-2", [run(1 * S)])] }),
    );
    expect(renders.drawer).toBeGreaterThan(drawerRenders);
    expect(vi.mocked(runsAtOnceShown).mock.calls.length).toBe(shownCalls);
    expect(button()).toHaveTextContent("Open in swimlane · 3 runs");
  });
});
