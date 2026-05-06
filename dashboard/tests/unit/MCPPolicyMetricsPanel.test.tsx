import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

describe("MCPPolicyMetricsPanel", () => {
  it("renders the empty-state copy verbatim from architecture when buckets are empty", async () => {
    metricsMock.mockResolvedValue({
      period: "24h",
      blocks_per_server: [],
      warns_per_server: [],
    });

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
    metricsMock.mockResolvedValue({
      period: "24h",
      blocks_per_server: [],
      warns_per_server: [],
    });

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

  it("aggregates buckets per server and renders the totals summary line", async () => {
    metricsMock.mockResolvedValue({
      period: "24h",
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
      expect(screen.queryByTestId("mcp-policy-metrics-empty")).toBeNull();
    });

    const block = screen
      .getByText("Blocks:")
      .parentElement?.textContent?.replace(/\s+/g, "");
    const warn = screen
      .getByText("Warns:")
      .parentElement?.textContent?.replace(/\s+/g, "");

    expect(block).toContain("Blocks:3");
    expect(warn).toContain("Warns:3");
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
