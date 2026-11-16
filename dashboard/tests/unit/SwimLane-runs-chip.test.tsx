import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { scaleTime } from "d3-scale";
import type { Session, SessionDetail } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { SwimLane } from "@/components/timeline/SwimLane";
import { eventsCache } from "@/hooks/useSessionEvents";

// A Fleet row whose agent has two or more runs at once shows the runs
// chip under its status badge: the count and an expand icon. A click
// opens the per-agent swimlane modal for that agent.

const { fetchSession } = vi.hoisted(() => ({
  fetchSession: vi.fn<(id: string) => Promise<SessionDetail>>(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSession,
}));

const NOW = Date.parse("2026-11-16T10:00:00Z");
const S = 1000;
const MIN = 60 * S;

let idSeq = 0;
function runId(): string {
  idSeq += 1;
  return `c${String(idSeq).padStart(7, "0")}-0000-4000-8000-000000000000`;
}

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: runId(),
    flavor: "e2e",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: at(-30 * S),
    last_seen_at: at(0),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    ...overrides,
  };
}

function renderRow(
  sessions: Session[],
  onExpandRuns?: (agentId: string) => void,
  onAncestorClick?: () => void,
) {
  const scale = scaleTime()
    .domain([new Date(NOW - 5 * MIN), new Date(NOW)])
    .range([0, 900]);
  return render(
    <MemoryRouter>
      {/* An ancestor with its own click handler, as a row's host may have. */}
      <div onClick={onAncestorClick}>
      <SwimLane
        flavor="agent-7"
        agentName="row"
        agentType="coding"
        sessions={sessions}
        scale={scale}
        onSessionClick={() => {}}
        timelineWidth={900}
        leftPanelWidth={460}
        onExpandRuns={onExpandRuns}
      />
      </div>
    </MemoryRouter>,
  );
}

function row() {
  return screen.getByTestId("swimlane-agent-row-row");
}

beforeEach(() => {
  useFleetStore.setState({ flavors: [] });
  eventsCache.clear();
  fetchSession.mockReset();
  fetchSession.mockImplementation(() => new Promise<SessionDetail>(() => {}));
});

describe("SwimLane runs chip", () => {
  it("shows the number of runs at once with a matching tooltip and accessible name", () => {
    renderRow([mkSession(), mkSession(), mkSession()], () => {});
    const chip = within(row()).getByTestId("swimlane-runs-chip");
    expect(chip).toHaveTextContent("3 runs");
    expect(chip).toHaveAttribute("data-run-count", "3");
    expect(chip).toHaveAttribute("title", "3 runs at once: expand in swimlane");
    expect(chip).toHaveAccessibleName("3 runs at once: expand in swimlane");
    // A button, so it is in the tab order and Enter / Space press it.
    expect(chip.tagName).toBe("BUTTON");
    expect(chip).toHaveAttribute("type", "button");
    expect(chip.tabIndex).toBe(0);
  });

  it("opens the modal for this agent on click, without reaching the row", () => {
    const onExpandRuns = vi.fn();
    const onAncestorClick = vi.fn();
    renderRow([mkSession(), mkSession()], onExpandRuns, onAncestorClick);
    fireEvent.click(within(row()).getByTestId("swimlane-runs-chip"));
    expect(onExpandRuns).toHaveBeenCalledWith("agent-7");
    expect(onAncestorClick).not.toHaveBeenCalled();
  });

  it("counts every run at once, past the four lanes the row draws", () => {
    renderRow(Array.from({ length: 5 }, () => mkSession()), () => {});
    expect(row()).toHaveAttribute("data-lane-count", "4");
    expect(within(row()).getByTestId("swimlane-runs-chip")).toHaveTextContent("5 runs");
  });

  it("is absent on a row with one run", () => {
    renderRow([mkSession()], () => {});
    expect(within(row()).queryByTestId("swimlane-runs-chip")).toBeNull();
  });

  it("is absent on a row whose runs ran one after another", () => {
    renderRow(
      [
        mkSession({ state: "closed", started_at: at(-4 * MIN), ended_at: at(-3 * MIN), last_seen_at: at(-3 * MIN) }),
        mkSession({ started_at: at(-2 * MIN) }),
      ],
      () => {},
    );
    expect(row()).toHaveAttribute("data-lane-count", "1");
    expect(within(row()).queryByTestId("swimlane-runs-chip")).toBeNull();
  });

  it("is absent without a handler (the modal's own rows)", () => {
    renderRow([mkSession(), mkSession(), mkSession()]);
    expect(within(row()).queryByTestId("swimlane-runs-chip")).toBeNull();
  });

  it("sits in the badge column under the status badge, leaving the row's height", () => {
    renderRow([mkSession(), mkSession()], () => {});
    const wrapper = within(row()).getByTestId("swimlane-badge-wrapper");
    const children = Array.from(wrapper.children).map((c) => c.getAttribute("data-testid"));
    expect(children).toEqual(["swimlane-agent-status-badge", "swimlane-runs-chip"]);
    expect(wrapper.style.flexDirection).toBe("column");
    expect(wrapper.style.position).toBe("absolute");
    expect(row().style.height).toBe("48px");
  });
});
