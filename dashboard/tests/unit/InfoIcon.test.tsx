// Unit tests for the shared InfoIcon primitive (D146 step 6.9).
// The Radix Tooltip portal renders the content lazily on hover /
// focus; jsdom doesn't fire pointer events the way Radix expects,
// so the assertions here cover the trigger surface (icon, button
// role, aria-label, derived test ID, optional className) rather
// than driving the popover open. Live tooltip rendering is covered
// by the consumer tests in MCPPolicyHeader.test.tsx where the
// existing test scaffolding already exercises Radix portals.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { InfoIcon } from "@/components/ui/info-icon";

describe("InfoIcon", () => {
  it("renders a button trigger carrying the supplied aria-label", () => {
    render(<InfoIcon content="hello" ariaLabel="Mode help" />);
    const trigger = screen.getByRole("button", { name: "Mode help" });
    expect(trigger).toBeInTheDocument();
  });

  it("derives a stable test ID from the aria-label when none is supplied", () => {
    render(<InfoIcon content="hello" ariaLabel="Mode help" />);
    expect(
      screen.getByTestId("info-icon-mode-help"),
    ).toBeInTheDocument();
  });

  it("honours an explicit testId prop over the derived one", () => {
    render(
      <InfoIcon
        content="hello"
        ariaLabel="Mode help"
        testId="custom-mode-info"
      />,
    );
    expect(screen.getByTestId("custom-mode-info")).toBeInTheDocument();
    expect(
      screen.queryByTestId("info-icon-mode-help"),
    ).not.toBeInTheDocument();
  });

  it("slugifies aria-labels with mixed case + non-alphanumerics for the derived test ID", () => {
    render(
      <InfoIcon
        content="x"
        ariaLabel="Block on Uncertainty (BOU) — help!"
      />,
    );
    // Each run of non-alphanumerics collapses to a single hyphen;
    // leading + trailing hyphens are stripped. The result is grep-
    // friendly and stable across copy tweaks that don't change
    // the load-bearing words.
    expect(
      screen.getByTestId("info-icon-block-on-uncertainty-bou-help"),
    ).toBeInTheDocument();
  });

  it("merges the optional className onto the trigger button", () => {
    render(
      <InfoIcon
        content="x"
        ariaLabel="Mode help"
        className="ml-2 align-baseline"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Mode help" });
    expect(trigger.className).toContain("ml-2");
    expect(trigger.className).toContain("align-baseline");
  });

  it("uses type='button' on the trigger so a parent <form> doesn't submit on click", () => {
    render(<InfoIcon content="x" ariaLabel="Mode help" />);
    expect(
      screen.getByRole("button", { name: "Mode help" }).getAttribute("type"),
    ).toBe("button");
  });
});
