import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentSparkline } from "@/components/agents/AgentSparkline";
import type { AgentSummarySeriesPoint } from "@/lib/types";

function point(p: Partial<AgentSummarySeriesPoint>): AgentSummarySeriesPoint {
  return {
    ts: "2026-05-14T00:00:00Z",
    tokens: 0,
    errors: 0,
    sessions: 0,
    cost_usd: 0,
    latency_p95_ms: 0,
    ...p,
  };
}

describe("AgentSparkline", () => {
  it("renders the placeholder when the series is empty", () => {
    render(<AgentSparkline series={[]} axis="tokens" />);
    expect(screen.getByTestId("agent-sparkline-empty")).toBeInTheDocument();
  });

  it("renders the placeholder when every value on the axis is zero", () => {
    const series = [point({ tokens: 0 }), point({ tokens: 0 })];
    render(<AgentSparkline series={series} axis="tokens" />);
    expect(screen.getByTestId("agent-sparkline-empty")).toBeInTheDocument();
  });

  it("renders the placeholder when only one non-zero point exists (sparse data)", () => {
    // Sparse-data guard: a single non-zero point would render as
    // a stray accent dot rather than a meaningful line. The
    // placeholder dash is the deliberate fallback so the column
    // reads consistently regardless of seed-data density.
    const series = [point({ tokens: 100 }), point({ tokens: 0 })];
    render(<AgentSparkline series={series} axis="tokens" />);
    expect(screen.getByTestId("agent-sparkline-empty")).toBeInTheDocument();
  });

  it("renders the chart when two or more non-zero points exist", () => {
    const series = [point({ tokens: 100 }), point({ tokens: 200 })];
    render(<AgentSparkline series={series} axis="tokens" />);
    expect(screen.getByTestId("agent-sparkline")).toBeInTheDocument();
  });

  it("renders the chart on a longer series with intermittent zeros (>=2 non-zero)", () => {
    const series = [
      point({ tokens: 0 }),
      point({ tokens: 50 }),
      point({ tokens: 0 }),
      point({ tokens: 200 }),
      point({ tokens: 0 }),
    ];
    render(<AgentSparkline series={series} axis="tokens" />);
    expect(screen.getByTestId("agent-sparkline")).toBeInTheDocument();
  });

  it("respects the axis prop — tokens has two non-zero points, errors has none", () => {
    const series = [
      point({ tokens: 100, errors: 0 }),
      point({ tokens: 200, errors: 0 }),
    ];
    const { unmount } = render(<AgentSparkline series={series} axis="tokens" />);
    expect(screen.getByTestId("agent-sparkline")).toBeInTheDocument();
    unmount();
    render(<AgentSparkline series={series} axis="errors" />);
    expect(screen.getByTestId("agent-sparkline-empty")).toBeInTheDocument();
  });
});
