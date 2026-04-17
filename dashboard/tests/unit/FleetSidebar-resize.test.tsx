import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import type { CustomDirective, FlavorSummary } from "@/lib/types";
import {
  FLEET_SIDEBAR_DEFAULT_WIDTH,
  FLEET_SIDEBAR_MAX_WIDTH,
  FLEET_SIDEBAR_MIN_WIDTH,
  FLEET_SIDEBAR_WIDTH_KEY,
  FLEET_PILL_HIDE_MIN_WIDTH,
} from "@/lib/constants";

vi.mock("@/lib/api", () => ({
  createDirective: vi.fn(() => Promise.resolve({ id: "dir-1" })),
  triggerCustomDirective: vi.fn(() => Promise.resolve()),
}));

let mockCustomDirectives: CustomDirective[] = [];
vi.mock("@/store/fleet", () => ({
  useFleetStore: (selector: (state: unknown) => unknown) =>
    selector({ customDirectives: mockCustomDirectives }),
}));

// Minimal two-flavor fixture covering the two pill cases: CODING
// AGENT for claude-code, DEV for developer-typed autonomous flavors.
// research-agent (14 chars) is the longest currently-observed name
// and is the stress-test for the 300px pill threshold.
const mkFlavors = (): FlavorSummary[] => [
  {
    flavor: "claude-code",
    agent_type: "developer",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 100,
    sessions: [
      {
        session_id: "s-cc",
        flavor: "claude-code",
        agent_type: "developer",
        host: null,
        framework: null,
        model: null,
        state: "active",
        started_at: "",
        last_seen_at: "",
        ended_at: null,
        tokens_used: 100,
        token_limit: null,
      },
    ],
  },
  {
    flavor: "research-agent",
    agent_type: "developer",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 50,
    sessions: [
      {
        session_id: "s-ra",
        flavor: "research-agent",
        agent_type: "developer",
        host: null,
        framework: null,
        model: null,
        state: "active",
        started_at: "",
        last_seen_at: "",
        ended_at: null,
        tokens_used: 50,
        token_limit: null,
      },
    ],
  },
];

beforeEach(() => {
  mockCustomDirectives = [];
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("FleetPanel sidebar width: localStorage init + clamp", () => {
  it("renders at the default width when localStorage is empty", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const sidebar = screen.getByTestId("fleet-sidebar");
    expect(sidebar.style.width).toBe(`${FLEET_SIDEBAR_DEFAULT_WIDTH}px`);
  });

  it("restores a valid stored width on mount", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "320");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe("320px");
  });

  it("clamps an oversize stored width to MAX on mount", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "9999");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe(
      `${FLEET_SIDEBAR_MAX_WIDTH}px`,
    );
  });

  it("clamps an undersize stored width to MIN on mount", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "50");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe(
      `${FLEET_SIDEBAR_MIN_WIDTH}px`,
    );
  });

  it("falls back to default when the stored value is not a number", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "not-a-number");
    expect(() => render(<FleetPanel flavors={mkFlavors()} />)).not.toThrow();
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe(
      `${FLEET_SIDEBAR_DEFAULT_WIDTH}px`,
    );
  });

  it("falls back to default when localStorage.getItem throws", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError: private mode");
      });
    expect(() => render(<FleetPanel flavors={mkFlavors()} />)).not.toThrow();
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe(
      `${FLEET_SIDEBAR_DEFAULT_WIDTH}px`,
    );
    spy.mockRestore();
  });
});

describe("FleetPanel sidebar width: resize handle", () => {
  it("renders a separator handle with the right aria attributes", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const handle = screen.getByTestId("fleet-sidebar-resize-handle");
    expect(handle).toBeInTheDocument();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize fleet sidebar");
    expect((handle as HTMLElement).style.cursor).toBe("col-resize");
  });

  it("drag updates sidebar width and persists to localStorage ONLY on mouseup", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    render(<FleetPanel flavors={mkFlavors()} />);
    const sidebar = screen.getByTestId("fleet-sidebar");
    const handle = screen.getByTestId("fleet-sidebar-resize-handle");

    expect(sidebar.style.width).toBe(`${FLEET_SIDEBAR_DEFAULT_WIDTH}px`);

    act(() => {
      fireEvent.mouseDown(handle, { clientX: 240 });
    });
    // Drag 80px to the right while the button is held. Width should
    // update live but the write should not have happened yet.
    act(() => {
      fireEvent.mouseMove(document, { clientX: 320 });
    });
    expect(sidebar.style.width).toBe("320px");
    expect(
      setItemSpy.mock.calls.filter(
        ([k]) => k === FLEET_SIDEBAR_WIDTH_KEY,
      ),
    ).toHaveLength(0);

    // Release -- now the single persist fires.
    act(() => {
      fireEvent.mouseUp(document);
    });
    const writes = setItemSpy.mock.calls.filter(
      ([k]) => k === FLEET_SIDEBAR_WIDTH_KEY,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe("320");
  });

  it("drag clamps to MAX when the pointer moves past the max", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const handle = screen.getByTestId("fleet-sidebar-resize-handle");
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 240 });
    });
    act(() => {
      fireEvent.mouseMove(document, { clientX: 9999 });
    });
    act(() => {
      fireEvent.mouseUp(document);
    });
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe(
      `${FLEET_SIDEBAR_MAX_WIDTH}px`,
    );
  });

  it("drag clamps to MIN when the pointer moves past the min", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const handle = screen.getByTestId("fleet-sidebar-resize-handle");
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 240 });
    });
    act(() => {
      fireEvent.mouseMove(document, { clientX: -9999 });
    });
    act(() => {
      fireEvent.mouseUp(document);
    });
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe(
      `${FLEET_SIDEBAR_MIN_WIDTH}px`,
    );
  });
});

describe("FleetPanel sidebar width: gradual pill truncation", () => {
  // The FLEET_PILL_HIDE_MIN_WIDTH hard floor is set below the sidebar
  // MIN so in normal operation the gate is always true and pills
  // render at every reachable width -- they just truncate to an
  // ellipsis as the sidebar narrows. These assertions read the pill's
  // inline style directly because jsdom does not run Tailwind; the
  // truncation CSS is deliberately kept inline so tests can observe
  // it.

  it("renders both pills at the 240 default with ellipsis styling", () => {
    // The supervisor's regression: pill used to hide at 240. The
    // correct behaviour is that the pill stays rendered and shrinks
    // first while the agent name stays full.
    expect(FLEET_SIDEBAR_DEFAULT_WIDTH).toBeGreaterThan(
      FLEET_PILL_HIDE_MIN_WIDTH,
    );
    render(<FleetPanel flavors={mkFlavors()} />);
    const codingPill = screen.getByTestId("coding-agent-badge");
    const devPill = screen.getByTestId("flavor-dev-badge");
    expect(codingPill).toBeInTheDocument();
    expect(devPill).toBeInTheDocument();
    // Pills carry the shrink-first + ellipsis inline styles so narrow
    // widths clip the pill text rather than the agent name.
    for (const pill of [codingPill, devPill]) {
      expect(pill.style.flexShrink).toBe("100");
      // jsdom normalises numeric 0 to "0" while browsers render "0px".
      expect(parseFloat(pill.style.minWidth || "0")).toBe(0);
      expect(pill.style.overflow).toBe("hidden");
      expect(pill.style.textOverflow).toBe("ellipsis");
    }
  });

  it("renders pills at a wide width (500) with the same truncation styles", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "500");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByTestId("coding-agent-badge")).toBeInTheDocument();
    expect(screen.getByTestId("flavor-dev-badge")).toBeInTheDocument();
  });

  it("renders pills at the sidebar MIN (180) — still above pill floor", () => {
    // FLEET_PILL_HIDE_MIN_WIDTH (150) is below sidebar MIN (180) by
    // design, so even the narrowest reachable sidebar still shows the
    // pill. At this width ellipsis does the heavy lifting.
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "180");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByTestId("coding-agent-badge")).toBeInTheDocument();
    expect(screen.getByTestId("flavor-dev-badge")).toBeInTheDocument();
  });

  it("agent name shrinks slower than the pill", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const ccName = screen.getByText("claude-code");
    const pill = screen.getByTestId("coding-agent-badge");
    // Name shrink = 1, pill shrink = 100 -> pill shrinks 100x faster,
    // so the pill truncates first while the name stays intact.
    expect(ccName.style.flexShrink).toBe("1");
    expect(pill.style.flexShrink).toBe("100");
  });

  it("CodingAgentBadge carries a descriptive title for hover disclosure", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const pill = screen.getByTestId("coding-agent-badge");
    const title = pill.getAttribute("title") ?? "";
    // The existing title is more informative than the literal pill
    // text; the supervisor asked for "full text on hover", which this
    // strictly over-delivers.
    expect(title.length).toBeGreaterThan(0);
    expect(title.toLowerCase()).toContain("coding agent");
  });

  it("DEV pill carries a title attribute", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByTestId("flavor-dev-badge").getAttribute("title")).toBe(
      "DEV",
    );
  });

  it("every flavor name carries a title attribute for the hover tooltip", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "200");
    render(<FleetPanel flavors={mkFlavors()} />);
    // getByText returns the span that directly contains the text.
    const ccName = screen.getByText("claude-code");
    const raName = screen.getByText("research-agent");
    expect(ccName.getAttribute("title")).toBe("claude-code");
    expect(raName.getAttribute("title")).toBe("research-agent");
  });

  it("name still carries a title attribute at wide widths", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "500");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByText("claude-code").getAttribute("title")).toBe(
      "claude-code",
    );
  });
});
