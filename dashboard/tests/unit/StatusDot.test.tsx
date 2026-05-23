import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  STATUS_COLOR,
  STATUS_LABEL,
  StatusDot,
} from "@/lib/agent-status";
import type { SessionState } from "@/lib/types";

// StatusDot is the single rendering primitive for the agent
// status indicator. AgentStatusBadge wraps it with a label; the
// /agents STATUS column chip and the modal / drawer badges all
// render it via the badge. These tests lock the colour-to-state
// mapping + the active-ring class gating contract so a future
// refactor that drops or renames the active class fails fast in
// the unit suite rather than waiting for E2E.

describe("StatusDot", () => {
  it("applies the agent-status-active-ring class iff state is active", () => {
    render(<StatusDot state="active" testId="dot-active" />);
    expect(screen.getByTestId("dot-active").className).toContain(
      "agent-status-active-ring",
    );
  });

  it("does NOT apply the active-ring class on non-active states", () => {
    for (const state of ["idle", "stale", "closed", "lost", ""] as const) {
      const { unmount } = render(<StatusDot state={state} testId="dot-x" />);
      expect(screen.getByTestId("dot-x").className).not.toContain(
        "agent-status-active-ring",
      );
      unmount();
    }
  });

  it("stamps data-state and reads colour from the STATUS_COLOR map", () => {
    const states: (SessionState | "")[] = [
      "active",
      "idle",
      "stale",
      "closed",
      "lost",
      "",
    ];
    for (const state of states) {
      const { unmount } = render(<StatusDot state={state} testId="dot-s" />);
      const dot = screen.getByTestId("dot-s");
      expect(dot).toHaveAttribute("data-state", state || "unknown");
      // Browser computed-style resolves the inline ``background``
      // string; jsdom preserves it verbatim, which is enough to
      // lock that the dot reads from STATUS_COLOR rather than a
      // hard-coded value at the call site.
      expect((dot as HTMLElement).style.background).toBe(STATUS_COLOR[state]);
      unmount();
    }
  });

  it("respects the size prop for width + height", () => {
    render(<StatusDot state="active" testId="dot-size" size={12} />);
    const dot = screen.getByTestId("dot-size");
    expect((dot as HTMLElement).style.width).toBe("12px");
    expect((dot as HTMLElement).style.height).toBe("12px");
  });

  it("exports STATUS_LABEL with the full state vocabulary", () => {
    // Lock-in: the badge consumes STATUS_LABEL and the modal /
    // drawer headers re-use the same map. A drop or rename of a
    // canonical state would surface here before any caller breaks.
    expect(STATUS_LABEL).toMatchObject({
      active: "Active",
      idle: "Idle",
      stale: "Stale",
      closed: "Closed",
      lost: "Lost",
      "": "—",
    });
  });
});
