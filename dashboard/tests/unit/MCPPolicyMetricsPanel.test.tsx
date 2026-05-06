import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    getMCPPolicyMetrics: vi.fn(),
  };
});

import { getMCPPolicyMetrics } from "@/lib/api";
import { MCPPolicyMetricsPanel } from "@/components/policy/MCPPolicyMetricsPanel";

const metricsMock = getMCPPolicyMetrics as unknown as Mock;

beforeEach(() => {
  metricsMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const EMPTY_24H = {
  period: "24h" as const,
  granularity: "hour",
  buckets: [
    { timestamp: "2026-05-05T20:00:00Z", blocks: [], warns: [] },
    { timestamp: "2026-05-05T21:00:00Z", blocks: [], warns: [] },
  ],
  blocks_per_server: [],
  warns_per_server: [],
};

describe("MCPPolicyMetricsPanel", () => {
  it("renders the empty-state copy verbatim from architecture when buckets carry no events", async () => {
    metricsMock.mockResolvedValue(EMPTY_24H);

    render(
      <MCPPolicyMetricsPanel flavorOrGlobal="global" scopeKey="global" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-metrics-empty").textContent,
      ).toBe("No enforcement events recorded yet for this period.");
    });
  });

  it("re-fetches when the period picker changes", async () => {
    metricsMock.mockResolvedValue(EMPTY_24H);

    render(
      <MCPPolicyMetricsPanel flavorOrGlobal="global" scopeKey="global" />,
    );

    await waitFor(() => {
      expect(metricsMock).toHaveBeenCalledWith("global", "24h");
    });

    fireEvent.click(screen.getByTestId("mcp-policy-metrics-period-global-7d"));

    await waitFor(() => {
      expect(metricsMock).toHaveBeenCalledWith("global", "7d");
    });
  });

  it("renders both the time-bucketed sparkline AND the per-server aggregate table when events exist", async () => {
    metricsMock.mockResolvedValue({
      period: "24h",
      granularity: "hour",
      buckets: [
        {
          timestamp: "2026-05-05T20:00:00Z",
          blocks: [{ fingerprint: "fp-a", server_name: "alpha", count: 1 }],
          warns: [{ fingerprint: "fp-b", server_name: "beta", count: 2 }],
        },
        {
          timestamp: "2026-05-05T21:00:00Z",
          blocks: [{ fingerprint: "fp-a", server_name: "alpha", count: 2 }],
          warns: [],
        },
      ],
      blocks_per_server: [
        { fingerprint: "fp-a", server_name: "alpha", count: 3 },
      ],
      warns_per_server: [
        { fingerprint: "fp-a", server_name: "alpha", count: 1 },
        { fingerprint: "fp-b", server_name: "beta", count: 2 },
      ],
    });

    render(
      <MCPPolicyMetricsPanel flavorOrGlobal="global" scopeKey="global" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-metrics-sparkline"),
      ).toBeTruthy();
    });

    const aggregate = screen.getByTestId(
      "mcp-policy-metrics-aggregate-global",
    );
    const alphaRow = within(aggregate).getByTestId(
      "mcp-policy-metrics-aggregate-row-fp-a",
    );
    const betaRow = within(aggregate).getByTestId(
      "mcp-policy-metrics-aggregate-row-fp-b",
    );

    // alpha = 3 blocks + 1 warn → total 4 (cells render concatenated
    // in jsdom without inter-cell whitespace, so assert the sequence
    // ``alpha314`` rather than space-delimited values).
    expect(alphaRow.textContent?.replace(/\s+/g, "")).toContain("alpha314");
    // beta = 0 blocks + 2 warns → total 2.
    expect(betaRow.textContent?.replace(/\s+/g, "")).toContain("beta022");
  });

  it("renders one aggregate row per distinct server when multiple servers fire", async () => {
    metricsMock.mockResolvedValue({
      period: "7d",
      granularity: "day",
      buckets: [
        {
          timestamp: "2026-05-04T00:00:00Z",
          blocks: [
            { fingerprint: "fp-a", server_name: "alpha", count: 1 },
            { fingerprint: "fp-b", server_name: "beta", count: 1 },
          ],
          warns: [],
        },
      ],
      blocks_per_server: [
        { fingerprint: "fp-a", server_name: "alpha", count: 1 },
        { fingerprint: "fp-b", server_name: "beta", count: 1 },
      ],
      warns_per_server: [],
    });

    render(
      <MCPPolicyMetricsPanel flavorOrGlobal="global" scopeKey="global" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-metrics-sparkline"),
      ).toBeTruthy();
    });

    // Recharts renders SVG inside ResponsiveContainer that jsdom
    // doesn't lay out, so the sparkline lines themselves aren't
    // queryable. The aggregate table is the testable proxy: one
    // row per server is the contract that gates whether the
    // sparkline ALSO has one line per server (both are derived
    // from the same ``aggregateRows`` memo).
    expect(
      screen.getByTestId("mcp-policy-metrics-aggregate-row-fp-a"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("mcp-policy-metrics-aggregate-row-fp-b"),
    ).toBeTruthy();
  });

  it("renders an error pill when the metrics fetch fails", async () => {
    metricsMock.mockRejectedValue(new Error("boom"));

    render(
      <MCPPolicyMetricsPanel flavorOrGlobal="global" scopeKey="global" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-metrics-error").textContent,
      ).toContain("boom");
    });
  });
});
