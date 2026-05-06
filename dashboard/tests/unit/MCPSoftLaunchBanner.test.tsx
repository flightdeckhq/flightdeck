import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { MCPSoftLaunchBanner } from "@/components/policy/MCPSoftLaunchBanner";
import { SOFT_LAUNCH_BANNER_DISMISS_KEY } from "@/lib/constants";

afterEach(() => {
  window.localStorage.clear();
});

describe("MCPSoftLaunchBanner", () => {
  it("renders the soft-launch heads-up with the FLIGHTDECK_MCP_POLICY_DEFAULT escape hatch when undismissed", () => {
    render(<MCPSoftLaunchBanner />);

    const banner = screen.getByTestId("mcp-soft-launch-banner");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("Soft launch.");
    expect(banner.textContent).toContain(
      "FLIGHTDECK_MCP_POLICY_DEFAULT=enforce",
    );
  });

  it("hides itself permanently after the dismiss button is clicked", () => {
    const { rerender } = render(<MCPSoftLaunchBanner />);

    fireEvent.click(screen.getByTestId("mcp-soft-launch-banner-dismiss"));
    expect(screen.queryByTestId("mcp-soft-launch-banner")).toBeNull();
    expect(
      window.localStorage.getItem(SOFT_LAUNCH_BANNER_DISMISS_KEY),
    ).toBe("1");

    rerender(<MCPSoftLaunchBanner />);
    expect(screen.queryByTestId("mcp-soft-launch-banner")).toBeNull();
  });

  it("stays hidden when the dismiss flag is already set in localStorage", () => {
    window.localStorage.setItem(SOFT_LAUNCH_BANNER_DISMISS_KEY, "1");
    render(<MCPSoftLaunchBanner />);

    expect(screen.queryByTestId("mcp-soft-launch-banner")).toBeNull();
  });
});
