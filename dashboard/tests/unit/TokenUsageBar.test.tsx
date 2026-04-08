import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenUsageBar } from "@/components/session/TokenUsageBar";

describe("TokenUsageBar", () => {
  it("renders markers at correct positions when thresholds are provided", () => {
    const { container } = render(
      <TokenUsageBar
        tokensUsed={5000}
        tokenLimit={10000}
        warn_at_pct={80}
        degrade_at_pct={90}
        block_at_pct={100}
      />
    );

    const warnMarker = screen.getByTestId("marker-warn-at-80%");
    const degradeMarker = screen.getByTestId("marker-degrade-at-90%");
    const blockMarker = screen.getByTestId("marker-block-at-100%");

    expect(warnMarker).toBeInTheDocument();
    expect(degradeMarker).toBeInTheDocument();
    expect(blockMarker).toBeInTheDocument();

    expect(warnMarker.style.left).toBe("80%");
    expect(degradeMarker.style.left).toBe("90%");
    expect(blockMarker.style.left).toBe("100%");
  });

  it("does not render markers when thresholds are null", () => {
    render(
      <TokenUsageBar
        tokensUsed={5000}
        tokenLimit={10000}
        warn_at_pct={null}
        degrade_at_pct={null}
        block_at_pct={null}
      />
    );

    expect(screen.queryByTestId(/^marker-/)).not.toBeInTheDocument();
  });

  it("does not render markers when tokenLimit is null", () => {
    render(
      <TokenUsageBar
        tokensUsed={5000}
        tokenLimit={null}
        warn_at_pct={80}
        degrade_at_pct={90}
        block_at_pct={100}
      />
    );

    // Should show the "no limit" text, no progress bar at all
    expect(screen.getByText(/no limit/)).toBeInTheDocument();
    expect(screen.queryByTestId(/^marker-/)).not.toBeInTheDocument();
  });

  it("bar color changes at warning threshold", () => {
    const { container } = render(
      <TokenUsageBar
        tokensUsed={85}
        tokenLimit={100}
        warn_at_pct={80}
        degrade_at_pct={90}
        block_at_pct={100}
      />
    );

    // 85/100 = 85%, which is >= 70 but < 90, so bar should be bg-warning
    const bar = container.querySelector(".bg-warning");
    expect(bar).toBeInTheDocument();
    expect(container.querySelector(".bg-danger")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-primary")).not.toBeInTheDocument();
  });

  it("bar clamps at 100% when usage exceeds limit", () => {
    const { container } = render(
      <TokenUsageBar
        tokensUsed={120}
        tokenLimit={100}
        warn_at_pct={80}
        degrade_at_pct={90}
        block_at_pct={100}
      />
    );

    // 120/100 = 120% but clamped to 100% via Math.min
    const bar = container.querySelector(".rounded-full.transition-all");
    expect(bar).toHaveStyle({ width: "100%" });

    // The displayed percentage text should show 100%
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
