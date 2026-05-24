import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

describe("AgentSparkline — hover tooltip + read-only click", () => {
  function plot(values: number[]): AgentSummarySeriesPoint[] {
    return values.map((v, i) =>
      point({
        ts: `2026-05-${String(14 + i).padStart(2, "0")}T00:00:00Z`,
        tokens: v,
      }),
    );
  }

  // jsdom returns a zero-width bounding rect because it doesn't lay
  // out elements. The sparkline hover lookup picks the nearest data
  // point by x-pixel; we stub the tile's rect so the lookup is
  // deterministic and the test asserts the value at a known index.
  function stubTileRect(width = 80, height = 24) {
    const tile = screen.getByTestId("agent-sparkline");
    tile.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      }) as DOMRect;
    return tile;
  }

  it("renders no tooltip at rest", () => {
    render(<AgentSparkline series={plot([100, 200, 300])} axis="tokens" />);
    expect(
      screen.queryByTestId("agent-sparkline-tooltip"),
    ).not.toBeInTheDocument();
  });

  it("renders the tooltip on hover with the formatted value + date", () => {
    render(<AgentSparkline series={plot([1500, 2500])} axis="tokens" />);
    const tile = stubTileRect();
    // First data point sits at x ≈ 2 (margin-left). Hover at
    // clientX=2 lands on idx=0 → value=1500 → ``1.5k``.
    fireEvent.mouseMove(tile, { clientX: 2, clientY: 12 });
    const tooltip = screen.getByTestId("agent-sparkline-tooltip");
    expect(tooltip.textContent).toContain("1.5k");
    expect(tooltip.textContent).toContain("May 14");
  });

  it("formats latency_p95_ms values via formatLatencyMs", () => {
    const series: AgentSummarySeriesPoint[] = [
      point({ latency_p95_ms: 1200, ts: "2026-05-14T00:00:00Z" }),
      point({ latency_p95_ms: 800, ts: "2026-05-15T00:00:00Z" }),
    ];
    render(<AgentSparkline series={series} axis="latency_p95_ms" />);
    const tile = stubTileRect();
    fireEvent.mouseMove(tile, { clientX: 2, clientY: 12 });
    // idx=0 → 1200 ms → ``1.2s`` per formatLatencyMs.
    expect(
      screen.getByTestId("agent-sparkline-tooltip").textContent,
    ).toContain("1.2s");
  });

  it("formats cost_usd values via formatCost ($N.NN branch)", () => {
    const series: AgentSummarySeriesPoint[] = [
      point({ cost_usd: 4.2, ts: "2026-05-14T00:00:00Z" }),
      point({ cost_usd: 1.5, ts: "2026-05-15T00:00:00Z" }),
    ];
    render(<AgentSparkline series={series} axis="cost_usd" />);
    const tile = stubTileRect();
    fireEvent.mouseMove(tile, { clientX: 2, clientY: 12 });
    // idx=0 → 4.2 → `formatCost` returns ``$4.20`` for values
    // between 1 and 100. Asserts the shared formatter is being
    // used (no inline duplicate).
    expect(
      screen.getByTestId("agent-sparkline-tooltip").textContent,
    ).toContain("$4.20");
  });

  it("formats sessions as a bare integer (default integer branch)", () => {
    const series: AgentSummarySeriesPoint[] = [
      point({ sessions: 12, ts: "2026-05-14T00:00:00Z" }),
      point({ sessions: 5, ts: "2026-05-15T00:00:00Z" }),
    ];
    render(<AgentSparkline series={series} axis="sessions" />);
    const tile = stubTileRect();
    fireEvent.mouseMove(tile, { clientX: 2, clientY: 12 });
    const text = screen.getByTestId("agent-sparkline-tooltip").textContent ?? "";
    // idx=0 → 12 sessions. Bare integer; no $, no k.
    expect(text).toMatch(/\b12\b/);
    expect(text).not.toContain("$");
    expect(text).not.toContain("k");
  });

  it("formats errors as a bare integer", () => {
    const series: AgentSummarySeriesPoint[] = [
      point({ errors: 3, ts: "2026-05-14T00:00:00Z" }),
      point({ errors: 7, ts: "2026-05-15T00:00:00Z" }),
    ];
    render(<AgentSparkline series={series} axis="errors" />);
    const tile = stubTileRect();
    fireEvent.mouseMove(tile, { clientX: 2, clientY: 12 });
    const text = screen.getByTestId("agent-sparkline-tooltip").textContent ?? "";
    // idx=0 → 3 errors. Plain integer; no ``k``, no ``$``.
    expect(text).toMatch(/\b3\b/);
    expect(text).not.toContain("k");
    expect(text).not.toContain("$");
  });

  it("hides the tooltip on mouse leave", () => {
    render(<AgentSparkline series={plot([1000, 2000])} axis="tokens" />);
    const tile = stubTileRect();
    fireEvent.mouseMove(tile, { clientX: 2, clientY: 12 });
    expect(
      screen.getByTestId("agent-sparkline-tooltip"),
    ).toBeInTheDocument();
    fireEvent.mouseLeave(tile);
    expect(
      screen.queryByTestId("agent-sparkline-tooltip"),
    ).not.toBeInTheDocument();
  });

  it("swallows clicks — no event reaches the wrapping handler", () => {
    const wrapperClick = vi.fn();
    render(
      <div onClick={wrapperClick} data-testid="wrapper">
        <AgentSparkline series={plot([100, 200])} axis="tokens" />
      </div>,
    );
    fireEvent.click(screen.getByTestId("agent-sparkline"));
    expect(wrapperClick).not.toHaveBeenCalled();
  });

  it("clicks elsewhere on the parent still propagate", () => {
    const wrapperClick = vi.fn();
    render(
      <div onClick={wrapperClick} data-testid="wrapper">
        <span data-testid="sibling">other</span>
        <AgentSparkline series={plot([100, 200])} axis="tokens" />
      </div>,
    );
    fireEvent.click(screen.getByTestId("sibling"));
    expect(wrapperClick).toHaveBeenCalledTimes(1);
  });

  it("renders the tooltip via createPortal on document.body (escapes overflow:hidden)", () => {
    render(
      <div
        data-testid="clip-parent"
        style={{ overflow: "hidden", width: 40, height: 12 }}
      >
        <AgentSparkline series={plot([100, 200])} axis="tokens" />
      </div>,
    );
    const tile = stubTileRect();
    fireEvent.mouseMove(tile, { clientX: 2, clientY: 12 });
    const tooltip = screen.getByTestId("agent-sparkline-tooltip");
    // Tooltip mounts as a child of document.body, NOT of the
    // clipped parent — that's what lets it visually escape the
    // overflow.
    expect(tooltip.parentElement).toBe(document.body);
  });

  it("placeholder dash never renders a tooltip on hover", () => {
    render(<AgentSparkline series={[]} axis="tokens" />);
    const dash = screen.getByTestId("agent-sparkline-empty");
    fireEvent.mouseMove(dash, { clientX: 0, clientY: 0 });
    expect(
      screen.queryByTestId("agent-sparkline-tooltip"),
    ).not.toBeInTheDocument();
  });
});
