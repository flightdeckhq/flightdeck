import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { scaleTime } from "d3-scale";
import type { FlavorSummary, Session } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import {
  AllSwimLane,
  SWIMLANE_LABEL_BACKDROP_VAR,
  SwimLane,
  TIMELINE_LEFT_INSET_PX,
  splitRoleSuffix,
} from "@/components/timeline/SwimLane";
import { EVENT_CIRCLE_SIZE } from "@/lib/constants";

// SwimLane label strip and timeline inset. A sub-agent's name is
// {parent}/{role}; the role is the only part that differs from the
// parent's row, so the name renders as a head that gives way first
// and a role suffix that keeps its width. The relationship pill of a
// child row shrinks before the name does. The timeline panel's
// positioned wrapper is inset by the buffer plus half a circle, on
// agent rows and on the ALL row alike.

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: () => ({ events: [], loading: false }),
  attachmentsCache: new Map(),
  eventsCache: new Map(),
}));

const NOW = new Date("2026-11-02T10:00:00Z");

function mkSession(
  id: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    session_id: id,
    flavor: "e2e",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: new Date(NOW.getTime() - 30_000).toISOString(),
    last_seen_at: NOW.toISOString(),
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    ...overrides,
  };
}

const PARENT_ID = "agent-parent";
const CHILD_ID = "agent-child";
const PARENT_NAME = "omria@Omri-PC";
const parentSession = mkSession("p-1");

function flavor(agentId: string, agentName: string, sessions: Session[]): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: sessions.length,
    tokens_used_total: 0,
    sessions,
    agent_id: agentId,
    agent_name: agentName,
  };
}

function renderRow(agentName: string, sessions: Session[], agentId = CHILD_ID) {
  useFleetStore.setState({
    flavors: [
      flavor(PARENT_ID, PARENT_NAME, [parentSession]),
      flavor(agentId, agentName, sessions),
    ],
  });
  const scale = scaleTime()
    .domain([new Date(NOW.getTime() - 60_000), NOW])
    .range([0, 900]);
  return render(
    <MemoryRouter>
      <SwimLane
        flavor={agentId}
        agentName={agentName}
        clientType="claude_code"
        agentType="coding"
        sessions={sessions}
        scale={scale}
        onSessionClick={() => {}}
        timelineWidth={900}
        leftPanelWidth={460}
        topology={sessions.some((s) => s.parent_session_id) ? "child" : "root"}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useFleetStore.setState({ flavors: [] });
});

describe("splitRoleSuffix", () => {
  it("splits a name that ends in /role", () => {
    expect(splitRoleSuffix("omria@Omri-PC/claude", "claude")).toEqual({
      head: "omria@Omri-PC",
      role: "/claude",
    });
  });

  it("does not split without a role, without the suffix, or with nothing before it", () => {
    expect(splitRoleSuffix("omria@Omri-PC", null)).toBeNull();
    expect(splitRoleSuffix("omria@Omri-PC", "")).toBeNull();
    expect(splitRoleSuffix("custom-name", "claude")).toBeNull();
    expect(splitRoleSuffix("omria@Omri-PCclaude", "claude")).toBeNull();
    expect(splitRoleSuffix("/claude", "claude")).toBeNull();
  });
});

describe("SwimLane agent name", () => {
  it("renders a sub-agent's name as a head plus its /role suffix", () => {
    const name = `${PARENT_NAME}/worker`;
    renderRow(name, [
      mkSession("c-1", { parent_session_id: "p-1", agent_role: "worker" }),
    ]);
    const link = screen.getByTestId("swimlane-agent-name-link");
    expect(link.getAttribute("title")).toBe(name);
    expect(link.textContent).toBe(name);
    expect(link.style.display).toBe("flex");
    const head = within(link).getByTestId("swimlane-agent-name-head");
    const role = within(link).getByTestId("swimlane-agent-name-role");
    expect(head.textContent).toBe(PARENT_NAME);
    expect(role.textContent).toBe("/worker");
    // The head gives way; the role never shrinks below its own width
    // until it fills the link. A non-zero shrink share would cut the
    // role by a fraction of a pixel, enough for an ellipsis.
    expect(head.style.flexShrink).toBe("1");
    expect(head.style.minWidth).toBe("0px");
    expect(head.style.textOverflow).toBe("ellipsis");
    expect(role.style.flexShrink).toBe("0");
    expect(role.style.maxWidth).toBe("100%");
    expect(role.style.textOverflow).toBe("ellipsis");
    // The link keeps the anti-collapse floor and the ellipsis styles.
    expect(link.style.minWidth).toBe("3rem");
    expect(link.style.overflow).toBe("hidden");
  });

  it("keeps a root row's name as one text", () => {
    renderRow(PARENT_NAME, [mkSession("r-1")], "agent-root");
    const link = screen.getByTestId("swimlane-agent-name-link");
    expect(link.textContent).toBe(PARENT_NAME);
    expect(within(link).queryByTestId("swimlane-agent-name-role")).toBeNull();
    expect(link.style.display).not.toBe("flex");
  });

  it("does not split when the role is not the name's suffix", () => {
    renderRow("custom-agent-name", [
      mkSession("c-1", { parent_session_id: "p-1", agent_role: "worker" }),
    ]);
    const link = screen.getByTestId("swimlane-agent-name-link");
    expect(link.textContent).toBe("custom-agent-name");
    expect(within(link).queryByTestId("swimlane-agent-name-role")).toBeNull();
  });

  it("takes the role from the most recent run", () => {
    const name = `${PARENT_NAME}/worker`;
    renderRow(name, [
      mkSession("c-old", {
        parent_session_id: "p-1",
        agent_role: "reviewer",
        started_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
      }),
      mkSession("c-new", { parent_session_id: "p-1", agent_role: "worker" }),
    ]);
    const role = screen.getByTestId("swimlane-agent-name-role");
    expect(role.textContent).toBe("/worker");
  });

  it("lets the child row's relationship pill shrink first, down to a 1.75rem floor", () => {
    renderRow(`${PARENT_NAME}/worker`, [
      mkSession("c-1", { parent_session_id: "p-1", agent_role: "worker" }),
    ]);
    const pill = screen.getByTestId("swimlane-relationship-pill");
    expect(pill.dataset.mode).toBe("child");
    expect(pill.style.flexShrink).toBe("100");
    expect(pill.style.minWidth).toBe("1.75rem");
    expect(pill.style.overflow).toBe("hidden");
  });
});

describe("SwimLane label accessibility and background", () => {
  it("names a split link with the whole agent name", () => {
    const name = `${PARENT_NAME}/worker`;
    renderRow(name, [
      mkSession("c-1", { parent_session_id: "p-1", agent_role: "worker" }),
    ]);
    // The head and role spans are flex items, which read with a space
    // between them; the link carries the exact name instead.
    expect(screen.getByRole("link", { name })).toBe(
      screen.getByTestId("swimlane-agent-name-link"),
    );
  });

  it("leaves an unsplit link's name to its text", () => {
    renderRow(PARENT_NAME, [mkSession("r-1")], "agent-root");
    const link = screen.getByTestId("swimlane-agent-name-link");
    expect(link.getAttribute("aria-label")).toBeNull();
    expect(screen.getByRole("link", { name: PARENT_NAME })).toBe(link);
  });

  it("paints a child row's label opaquely: tint, accent line, tint, then the host's backdrop", () => {
    renderRow(`${PARENT_NAME}/worker`, [
      mkSession("c-1", { parent_session_id: "p-1", agent_role: "worker" }),
    ]);
    const label = document.querySelector<HTMLElement>(".swimlane-row-label")!;
    const tint = "linear-gradient(var(--swimlane-row-child-bg), var(--swimlane-row-child-bg))";
    expect(label.style.background).toBe(
      `${tint}, linear-gradient(to right, var(--accent) 2px, transparent 2px), ${tint}, ` +
        `var(${SWIMLANE_LABEL_BACKDROP_VAR}, var(--bg))`,
    );
  });

  it("keeps a root row's label on the row's own opaque surface", () => {
    renderRow(PARENT_NAME, [mkSession("r-1")], "agent-root");
    const label = document.querySelector<HTMLElement>(".swimlane-row-label")!;
    expect(label.style.background).toBe("inherit");
  });
});

describe("SwimLane timeline inset", () => {
  it("is the buffer plus half a circle", () => {
    expect(TIMELINE_LEFT_INSET_PX).toBe(8 + EVENT_CIRCLE_SIZE / 2);
  });

  it("insets the agent row's positioned wrapper by TIMELINE_LEFT_INSET_PX", () => {
    renderRow(PARENT_NAME, [mkSession("r-1")], "agent-root");
    const wrapper = screen.getByTestId("swimlane-timeline-inset");
    expect(wrapper.style.position).toBe("absolute");
    expect(wrapper.style.left).toBe(`${TIMELINE_LEFT_INSET_PX}px`);
    expect(wrapper.style.top).toBe("0px");
    expect(wrapper.style.right).toBe("0px");
    expect(wrapper.style.bottom).toBe("0px");
  });

  it("culls run glyphs at the inset wrapper's visible edge, not the old 8 px one", () => {
    // 60 s map onto 900 px. A run that started 350 ms ago sits at
    // x ≈ 894.75 in wrapper coordinates: more than a glyph's width
    // past the wrapper's visible right edge (900 - 19 = 881), so its
    // start glyph would be clipped anyway and is not rendered. With
    // the old 8 px subtraction (892) it was still rendered.
    renderRow(
      PARENT_NAME,
      [mkSession("r-late", { started_at: new Date(NOW.getTime() - 350).toISOString() })],
      "agent-late",
    );
    expect(screen.queryByTestId("swimlane-run-bracket-start-r-late")).toBeNull();
  });

  it("keeps the start glyph of a run that started well inside the window", () => {
    renderRow(
      PARENT_NAME,
      [mkSession("r-early", { started_at: new Date(NOW.getTime() - 30_000).toISOString() })],
      "agent-early",
    );
    const glyph = screen.getByTestId("swimlane-run-bracket-start-r-early");
    // Glyphs carry their run id for Timeline's hover handler.
    expect(glyph.getAttribute("data-session-id")).toBe("r-early");
  });

  it("insets the expanded ALL row's pulse by the same amount", () => {
    const scale = scaleTime()
      .domain([new Date(NOW.getTime() - 60_000), NOW])
      .range([0, 900]);
    render(
      <AllSwimLane
        flavors={[{ flavor: PARENT_ID, sessions: [parentSession] }]}
        scale={scale}
        onSessionClick={() => {}}
        timelineWidth={900}
        leftPanelWidth={460}
        collapsed={false}
        onToggle={() => {}}
      />,
    );
    const pulse = screen.getByTestId("swimlane-all-pulse");
    const wrapper = within(pulse).getByTestId("swimlane-timeline-inset");
    expect(wrapper.style.left).toBe(`${TIMELINE_LEFT_INSET_PX}px`);
    expect(wrapper.style.top).toBe("0px");
    expect(wrapper.style.bottom).toBe("0px");
  });
});
