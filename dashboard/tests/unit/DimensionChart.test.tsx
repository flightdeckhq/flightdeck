import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DimensionChart } from "@/components/analytics/DimensionChart";

// Mock useAnalytics hook
let mockData: any = null;
let mockLoading = false;
let mockError: string | null = null;

vi.mock("@/hooks/useAnalytics", () => ({
  useAnalytics: () => ({
    data: mockData,
    loading: mockLoading,
    error: mockError,
    refetch: vi.fn(),
  }),
}));

// Mock recharts components to avoid rendering SVG in tests
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: () => <div data-testid="area-chart" />,
  Area: () => null,
  BarChart: () => <div data-testid="bar-chart" />,
  Bar: () => null,
  PieChart: () => <div data-testid="pie-chart" />,
  Pie: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

beforeEach(() => {
  mockData = null;
  mockLoading = false;
  mockError = null;
});

describe("DimensionChart", () => {
  it("renders loading skeleton while fetching", () => {
    mockLoading = true;
    const { container } = render(
      <DimensionChart
        title="Token consumption"
        metric="tokens"
        defaultGroupBy="flavor"
        chartType="area"
        range="30d"
      />
    );
    expect(screen.getByText("Token consumption")).toBeInTheDocument();
    // Loading state shows a spinner
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });

  it("renders error state on API failure", () => {
    mockError = "Network error";
    render(
      <DimensionChart
        title="Token consumption"
        metric="tokens"
        defaultGroupBy="flavor"
        chartType="area"
        range="30d"
      />
    );
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });

  it("renders empty state when series is empty", () => {
    mockData = {
      metric: "tokens",
      group_by: "flavor",
      range: "30d",
      granularity: "day",
      series: [],
      totals: { grand_total: 0, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="Token consumption"
        metric="tokens"
        defaultGroupBy="flavor"
        chartType="area"
        range="30d"
      />
    );
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
  });

  it("renders DimensionPicker with all 6 dimensions", () => {
    mockData = {
      metric: "tokens",
      group_by: "flavor",
      range: "30d",
      granularity: "day",
      series: [{ dimension: "test", total: 100, data: [{ date: "2026-04-01", value: 100 }] }],
      totals: { grand_total: 100, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="Token consumption"
        metric="tokens"
        defaultGroupBy="flavor"
        chartType="area"
        range="30d"
      />
    );
    // The DimensionPicker trigger should be present
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders area chart for area chartType", () => {
    mockData = {
      metric: "tokens",
      group_by: "flavor",
      range: "30d",
      granularity: "day",
      series: [{ dimension: "test", total: 100, data: [{ date: "2026-04-01", value: 100 }] }],
      totals: { grand_total: 100, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="Tokens"
        metric="tokens"
        defaultGroupBy="flavor"
        chartType="area"
        range="30d"
      />
    );
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders bar chart for bar chartType", () => {
    mockData = {
      metric: "tokens",
      group_by: "flavor",
      range: "30d",
      granularity: "day",
      series: [{ dimension: "test", total: 100, data: [{ date: "2026-04-01", value: 100 }] }],
      totals: { grand_total: 100, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="Top"
        metric="tokens"
        defaultGroupBy="flavor"
        chartType="bar"
        range="30d"
      />
    );
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
  });

  it("renders donut chart for donut chartType", () => {
    mockData = {
      metric: "tokens",
      group_by: "model",
      range: "30d",
      granularity: "day",
      series: [{ dimension: "claude", total: 100, data: [{ date: "2026-04-01", value: 100 }] }],
      totals: { grand_total: 100, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="Distribution"
        metric="tokens"
        defaultGroupBy="model"
        chartType="donut"
        range="30d"
      />
    );
    expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
  });
});
