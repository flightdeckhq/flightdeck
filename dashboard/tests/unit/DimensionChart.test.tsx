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

  it("hides the dimension picker when showDimensionPicker=false", () => {
    mockData = {
      metric: "sessions",
      group_by: "framework",
      range: "30d",
      granularity: "day",
      series: [{ dimension: "langchain/0.1.12", total: 3, data: [{ date: "2026-04-01", value: 3 }] }],
      totals: { grand_total: 3, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="Framework Distribution"
        metric="sessions"
        defaultGroupBy="framework"
        chartType="donut"
        range="30d"
        showDimensionPicker={false}
      />
    );
    expect(screen.getByText("Framework Distribution")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("renders a dynamic title via renderTitle using the current dimension label", async () => {
    mockData = {
      metric: "latency_avg",
      group_by: "model",
      range: "30d",
      granularity: "day",
      series: [{ dimension: "claude-sonnet-4-6", total: 420, data: [{ date: "2026-04-01", value: 420 }] }],
      totals: { grand_total: 420, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="fallback"
        renderTitle={(dimLabel) => `Avg Latency by ${dimLabel}`}
        metric="latency_avg"
        defaultGroupBy="model"
        chartType="area"
        range="30d"
      />
    );
    expect(screen.getByText("Avg Latency by Model")).toBeInTheDocument();
  });

  it("falls back to the static title when renderTitle is not supplied", () => {
    mockData = {
      metric: "tokens",
      group_by: "flavor",
      range: "30d",
      granularity: "day",
      series: [{ dimension: "coder", total: 100, data: [{ date: "2026-04-01", value: 100 }] }],
      totals: { grand_total: 100, period_change_pct: 0 },
    };
    render(
      <DimensionChart
        title="Static title"
        metric="tokens"
        defaultGroupBy="flavor"
        chartType="area"
        range="30d"
      />
    );
    expect(screen.getByText("Static title")).toBeInTheDocument();
  });
});
