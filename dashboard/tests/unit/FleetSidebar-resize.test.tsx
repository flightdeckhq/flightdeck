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

// D115 pill-pair fixture covering the two client types: Claude Code
// (hook-based coding agent) and Python sensor (coding agent invoked
// from outside the Claude Code plugin). Both flavors carry
// agent_type=coding so the CodingAgentBadge fires for each; the
// second pill (``flavor-client-type-pill``) distinguishes the
// emitter.
const mkFlavors = (): FlavorSummary[] => [
  {
    flavor: "claude-code",
    agent_type: "coding",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 100,
    sessions: [
      {
        session_id: "s-cc",
        flavor: "claude-code",
        agent_type: "coding",
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
    agent_id: "11111111-1111-4111-8111-111111111111",
    agent_name: "claude-code",
    client_type: "claude_code",
  },
  {
    flavor: "research-agent",
    agent_type: "coding",
    session_count: 1,
    active_count: 1,
    tokens_used_total: 50,
    sessions: [
      {
        session_id: "s-ra",
        flavor: "research-agent",
        agent_type: "coding",
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
    agent_id: "22222222-2222-4222-8222-222222222222",
    agent_name: "research-agent",
    client_type: "flightdeck_sensor",
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
      // jsdom's PointerEvent constructor silently drops the clientX
      // init field; dispatch a MouseEvent with the pointer event type
      // instead — PointerEvent extends MouseEvent so the registered
      // pointerXXX listener fires and ev.clientX is honoured.
      handle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 240 }),
      );
    });
    // Drag 80px to the right while the button is held. Width should
    // update live but the write should not have happened yet.
    act(() => {
      document.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 320 }),
      );
    });
    expect(sidebar.style.width).toBe("320px");
    expect(
      setItemSpy.mock.calls.filter(
        ([k]) => k === FLEET_SIDEBAR_WIDTH_KEY,
      ),
    ).toHaveLength(0);

    // Release -- now the single persist fires.
    act(() => {
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
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
      // jsdom's PointerEvent constructor silently drops the clientX
      // init field; dispatch a MouseEvent with the pointer event type
      // instead — PointerEvent extends MouseEvent so the registered
      // pointerXXX listener fires and ev.clientX is honoured.
      handle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 240 }),
      );
    });
    act(() => {
      document.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 9999 }),
      );
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(screen.getByTestId("fleet-sidebar").style.width).toBe(
      `${FLEET_SIDEBAR_MAX_WIDTH}px`,
    );
  });

  it("drag clamps to MIN when the pointer moves past the min", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const handle = screen.getByTestId("fleet-sidebar-resize-handle");
    act(() => {
      // jsdom's PointerEvent constructor silently drops the clientX
      // init field; dispatch a MouseEvent with the pointer event type
      // instead — PointerEvent extends MouseEvent so the registered
      // pointerXXX listener fires and ev.clientX is honoured.
      handle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 240 }),
      );
    });
    act(() => {
      document.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: -9999 }),
      );
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
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

  it("pills never truncate at the 240 default (Phase 2 Supervisor smoke rule)", () => {
    // Pre-rule: pills carried flex-shrink-100 + ellipsis so they
    // collapsed under narrow widths, producing the "SENS…" bug. Post-
    // rule: pills are flexShrink: 0 + white-space: nowrap, and the
    // sibling <TruncatedText/> absorbs truncation instead.
    expect(FLEET_SIDEBAR_DEFAULT_WIDTH).toBeGreaterThan(
      FLEET_PILL_HIDE_MIN_WIDTH,
    );
    render(<FleetPanel flavors={mkFlavors()} />);
    const codingPills = screen.getAllByTestId("coding-agent-badge");
    const clientPills = screen.getAllByTestId("flavor-client-type-pill");
    expect(codingPills.length).toBe(2);
    expect(clientPills.length).toBe(2);
    for (const pill of [...codingPills, ...clientPills]) {
      expect(pill.style.flexShrink).toBe("0");
      expect(pill.style.whiteSpace).toBe("nowrap");
      // Explicitly NOT truncating any more.
      expect(pill.style.textOverflow).not.toBe("ellipsis");
    }
  });

  it("renders pills at a wide width (500) with the same truncation styles", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "500");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getAllByTestId("coding-agent-badge").length).toBe(2);
    expect(screen.getAllByTestId("flavor-client-type-pill").length).toBe(2);
  });

  it("renders pills at the sidebar MIN (180) — still above pill floor", () => {
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "180");
    render(<FleetPanel flavors={mkFlavors()} />);
    expect(screen.getAllByTestId("coding-agent-badge").length).toBe(2);
    expect(screen.getAllByTestId("flavor-client-type-pill").length).toBe(2);
  });

  it("agent name is the shrink target; pills hold their width", () => {
    // Inverse of the prior rule: the name absorbs narrowing via the
    // shared <TruncatedText/> primitive (overflow: hidden + ellipsis
    // + native ``title`` on hover) while the pills keep their full
    // intrinsic width. The old pre-Phase-2 "pills shrink first"
    // design produced the "SENS…" truncated-mid-character bug.
    render(<FleetPanel flavors={mkFlavors()} />);
    const pill = screen.getAllByTestId("coding-agent-badge")[0];
    expect(pill.style.flexShrink).toBe("0");
  });

  it("CodingAgentBadge carries a descriptive title for hover disclosure", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const pill = screen.getAllByTestId("coding-agent-badge")[0];
    const title = pill.getAttribute("title") ?? "";
    expect(title.length).toBeGreaterThan(0);
    expect(title.toLowerCase()).toContain("coding agent");
  });

  it("client-type pill carries a title attribute with client_type=<value>", () => {
    render(<FleetPanel flavors={mkFlavors()} />);
    const pills = screen.getAllByTestId("flavor-client-type-pill");
    // First row = claude-code; second = sensor.
    expect(pills[0].getAttribute("title")).toBe("client_type=claude_code");
    expect(pills[1].getAttribute("title")).toBe("client_type=flightdeck_sensor");
  });

  it("flavor name is rendered through the <TruncatedText/> primitive", () => {
    // Post-Phase-2: titles are now conditional (only when the
    // ellipsis is actually rendered) via the shared primitive, so a
    // strict ``title=flavor`` assertion no longer matches in jsdom
    // where layout collapses to 0x0 and the auto-detector sees no
    // truncation. The regression we care about is "every name has
    // the ellipsis + overflow CSS signature so truncation is
    // possible at all" -- assert that, plus the presence of the
    // primitive's inline-block + overflow-hidden defaults so the
    // primitive is the actual render path. Auto-truncation tooltip
    // behaviour is covered in TruncatedText.test.tsx with mocked
    // scrollWidth / clientWidth.
    localStorage.setItem(FLEET_SIDEBAR_WIDTH_KEY, "200");
    render(<FleetPanel flavors={mkFlavors()} />);
    for (const name of ["claude-code", "research-agent"]) {
      const el = screen.getByText(name);
      // TruncatedText carries ``overflow-hidden`` + ``whitespace-
      // nowrap`` as Tailwind classes (jsdom cannot read Tailwind
      // computed styles) and ``textOverflow: ellipsis`` inline.
      expect(el.className).toContain("overflow-hidden");
      expect(el.className).toContain("whitespace-nowrap");
      expect(el.style.textOverflow).toBe("ellipsis");
    }
  });
});
