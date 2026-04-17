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

describe("FleetPanel sidebar width: narrow-width pill degradation", () => {
  it("hides both pills at the 240 default (below the 300 threshold)", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    // Default is 240, which is below FLEET_PILL_HIDE_MIN_WIDTH (300).
    expect(FLEET_SIDEBAR_DEFAULT_WIDTH).toBeLessThan(
      FLEET_PILL_HIDE_MIN_WIDTH,
    );
    expect(
      screen.queryByTestId("coding-agent-badge"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("flavor-dev-badge")).not.toBeInTheDocument();
    // Icon and name still render.
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("research-agent")).toBeInTheDocument();
  });

  it("shows pills once dragged to the pill threshold", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const handle = screen.getByTestId("fleet-sidebar-resize-handle");
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 240 });
    });
    // Drag to exactly FLEET_PILL_HIDE_MIN_WIDTH (300). The gate is
    // ``sidebarWidth >= threshold`` so pills appear at equality.
    act(() => {
      fireEvent.mouseMove(document, {
        clientX: 240 + (FLEET_PILL_HIDE_MIN_WIDTH - FLEET_SIDEBAR_DEFAULT_WIDTH),
      });
    });
    act(() => {
      fireEvent.mouseUp(document);
    });
    expect(screen.getByTestId("coding-agent-badge")).toBeInTheDocument();
    // research-agent has agent_type=developer and is not claude-code,
    // so it takes the DEV branch of the same gate.
    expect(screen.getByTestId("flavor-dev-badge")).toBeInTheDocument();
    // Names still render in full.
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("research-agent")).toBeInTheDocument();
  });

  it("shows pills comfortably above threshold (350)", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "350");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getByTestId("coding-agent-badge")).toBeInTheDocument();
    expect(screen.getByTestId("flavor-dev-badge")).toBeInTheDocument();
  });

  it("hides pills when the user has dragged narrower than default", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "200");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(
      screen.queryByTestId("coding-agent-badge"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("flavor-dev-badge")).not.toBeInTheDocument();
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
