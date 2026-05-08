// Unit tests for the shared InfoIcon primitive (D146 step 6.10).
//
// Step 6.9 shipped surface-presence-only assertions (button role,
// aria-label, derived test ID). Two-hat Chrome verification then
// surfaced two interaction defects those tests didn't cover:
//   - Dialog focus-trap auto-opened the tooltip on mount (focus
//     trigger + Radix Dialog's first-focusable rule).
//   - Subsequent clicks didn't reopen after dismissal (Radix
//     pointerDown-close on an already-focused button).
//
// Step 6.10 fixes both at the implementation layer (controlled
// ``open`` state + click-toggle here; ``onOpenAutoFocus`` override
// in MCPPolicyEntryDialog). These tests lock the interaction
// contract so the primitive can't regress to the broken shape:
//   - Mount → tooltip is NOT visible.
//   - First click → tooltip becomes visible.
//   - Escape → tooltip closes.
//   - Second click → tooltip reopens.
//   - Two InfoIcons in the same parent don't cross-trigger.
//
// Test environment caveat: Radix Tooltip portals to document.body.
// jsdom's microtask scheduling around portals + Radix's open-state
// settling means we use ``waitFor`` / ``findByTestId`` to settle the
// portal mount rather than ``waitForTimeout``-style fixed delays
// (project memory feedback_animatepresence_settle_poll.md +
// feedback_no_timeout_in_tests.md). Wrapping in
// ``<TooltipProvider delayDuration={0}>`` removes the 700ms hover
// delay so click-toggle tests don't race the default delay.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InfoIcon } from "@/components/ui/info-icon";
import { TooltipProvider } from "@/components/ui/tooltip";

// jsdom doesn't ship a layout engine, so Radix Popper's positioning
// libraries can call ``element.hasPointerCapture`` and friends that
// jsdom hasn't implemented. Stub them so the tests don't blow up
// inside Radix's internals before the assertion runs. These shims
// are safe — they're only used by Radix to decide where to position
// a tooltip, which the assertion layer doesn't care about.
if (typeof Element !== "undefined" && !("hasPointerCapture" in Element.prototype)) {
  Element.prototype.hasPointerCapture = () => false;
}

function renderInfoIcon(
  props: React.ComponentProps<typeof InfoIcon> = {
    content: "hello",
    ariaLabel: "Mode help",
  },
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <InfoIcon {...props} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("InfoIcon — surface", () => {
  it("renders a button trigger carrying the supplied aria-label", () => {
    renderInfoIcon();
    const trigger = screen.getByRole("button", { name: "Mode help" });
    expect(trigger).toBeInTheDocument();
  });

  it("derives a stable test ID from the aria-label when none is supplied", () => {
    renderInfoIcon();
    expect(screen.getByTestId("info-icon-mode-help")).toBeInTheDocument();
  });

  it("honours an explicit testId prop over the derived one", () => {
    renderInfoIcon({
      content: "hello",
      ariaLabel: "Mode help",
      testId: "custom-mode-info",
    });
    expect(screen.getByTestId("custom-mode-info")).toBeInTheDocument();
    expect(screen.queryByTestId("info-icon-mode-help")).not.toBeInTheDocument();
  });

  it("slugifies aria-labels with mixed case + non-alphanumerics for the derived test ID", () => {
    renderInfoIcon({
      content: "x",
      ariaLabel: "Block on Uncertainty (BOU) — help!",
    });
    expect(
      screen.getByTestId("info-icon-block-on-uncertainty-bou-help"),
    ).toBeInTheDocument();
  });

  it("merges the optional className onto the trigger button", () => {
    renderInfoIcon({
      content: "x",
      ariaLabel: "Mode help",
      className: "ml-2 align-baseline",
    });
    const trigger = screen.getByRole("button", { name: "Mode help" });
    expect(trigger.className).toContain("ml-2");
    expect(trigger.className).toContain("align-baseline");
  });

  it("uses type='button' on the trigger so a parent <form> doesn't submit on click", () => {
    renderInfoIcon();
    expect(
      screen.getByRole("button", { name: "Mode help" }).getAttribute("type"),
    ).toBe("button");
  });
});

describe("InfoIcon — interaction cycle (step 6.10 lock)", () => {
  it("does NOT render the tooltip on initial mount", () => {
    renderInfoIcon({
      content: "hello",
      ariaLabel: "Mode help",
    });
    // The trigger renders, but the tooltip body is portaled only
    // when ``open`` is true. Mount-time open === false ⇒ no body.
    expect(
      screen.queryByTestId("info-icon-mode-help-content"),
    ).not.toBeInTheDocument();
    // Trigger's aria-expanded reflects closed state.
    expect(
      screen
        .getByTestId("info-icon-mode-help")
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("opens the tooltip on click", async () => {
    renderInfoIcon({
      content: "hello",
      ariaLabel: "Mode help",
    });
    fireEvent.click(screen.getByTestId("info-icon-mode-help"));
    // Radix portals into document.body. Wait for the body element
    // to appear and the trigger's aria-expanded to flip.
    await waitFor(() => {
      expect(
        screen
          .getByTestId("info-icon-mode-help")
          .getAttribute("aria-expanded"),
      ).toBe("true");
    });
  });

  it("closes the tooltip on Escape after open", async () => {
    renderInfoIcon({
      content: "hello",
      ariaLabel: "Mode help",
    });
    const trigger = screen.getByTestId("info-icon-mode-help");
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("true"),
    );
    fireEvent.keyDown(trigger, { key: "Escape" });
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("reopens the tooltip on a second click after dismissal — the bug step 6.9 shipped", async () => {
    renderInfoIcon({
      content: "hello",
      ariaLabel: "Mode help",
    });
    const trigger = screen.getByTestId("info-icon-mode-help");

    // First open.
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("true"),
    );
    // Close (Escape stands in for click-outside in jsdom; both
    // funnel through Radix's onOpenChange(false)).
    fireEvent.keyDown(trigger, { key: "Escape" });
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
    // Second click MUST reopen — pre-fix Radix's pointerDown
    // handler closed on click and the focus-already-on-button
    // state meant no focus event re-triggered the tooltip.
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("true"),
    );
  });

  it("two InfoIcons in the same parent don't cross-trigger", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <InfoIcon content="A content" ariaLabel="A help" />
        <InfoIcon content="B content" ariaLabel="B help" />
      </TooltipProvider>,
    );
    const triggerA = screen.getByTestId("info-icon-a-help");
    const triggerB = screen.getByTestId("info-icon-b-help");

    expect(triggerA.getAttribute("aria-expanded")).toBe("false");
    expect(triggerB.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(triggerA);
    await waitFor(() =>
      expect(triggerA.getAttribute("aria-expanded")).toBe("true"),
    );
    // B remains closed when A opens.
    expect(triggerB.getAttribute("aria-expanded")).toBe("false");

    // Open B; A's state is unaffected by the open call on B
    // (independent ``open`` state in each InfoIcon).
    fireEvent.click(triggerB);
    await waitFor(() =>
      expect(triggerB.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(triggerA.getAttribute("aria-expanded")).toBe("true");
  });
});
