import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SummaryCards } from "@/components/analytics/SummaryCards";
import { fetchAnalytics } from "@/lib/api";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  fetchAnalytics: vi.fn(),
}));

const response = (series: { dimension: string; total: number }[], grand: number) => ({
  metric: "tokens",
  group_by: "provider",
  range: "30d",
  granularity: "day",
  series: series.map((s) => ({ ...s, data: [] })),
  totals: { grand_total: grand, period_change_pct: 0 },
});

beforeEach(() => {
  vi.mocked(fetchAnalytics).mockImplementation(async (params) =>
    params.metric === "tokens"
      ? response(
          [
            { dimension: "openai", total: 200 },
            { dimension: "deepseek", total: 500 },
            { dimension: "anthropic", total: 0 },
            { dimension: "some-gateway", total: 100 },
            { dimension: "other", total: 50 },
          ],
          850,
        )
      : response([{ dimension: "f", total: 10 }], 10),
  );
});

describe("SummaryCards", () => {
  it("renders one card per provider that used tokens, largest first", async () => {
    render(<SummaryCards range="30d" filterProvider={null} onSelectProvider={vi.fn()} />);
    await screen.findByTestId("summary-card-provider-deepseek");
    const cards = screen
      .getAllByTestId(/^summary-card-provider-/)
      .map((c) => c.getAttribute("data-testid"));
    expect(cards).toEqual([
      "summary-card-provider-deepseek",
      "summary-card-provider-openai",
      "summary-card-provider-other",
    ]);
    // A dimension outside the vocabulary folds into Other.
    expect(screen.getByTestId("summary-card-provider-other")).toHaveTextContent("150");
    expect(screen.getByTestId("summary-card-provider-deepseek")).toHaveTextContent("DeepSeek Tokens");
    expect(vi.mocked(fetchAnalytics)).toHaveBeenCalledWith(
      expect.objectContaining({ metric: "tokens", group_by: "provider" }),
    );
  });

  it("selects and clears a provider filter from its card", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <SummaryCards range="30d" filterProvider={null} onSelectProvider={onSelect} />,
    );
    fireEvent.click(await screen.findByTestId("summary-card-provider-openai"));
    expect(onSelect).toHaveBeenLastCalledWith("openai");
    rerender(<SummaryCards range="30d" filterProvider="openai" onSelectProvider={onSelect} />);
    expect(screen.getByTestId("summary-card-provider-openai")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("summary-card-provider-openai")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("summary-card-provider-openai"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("shows a share too small for one decimal as <0.1%, not 0.0%", async () => {
    vi.mocked(fetchAnalytics).mockImplementation(async (params) =>
      params.metric === "tokens"
        ? response(
            [
              { dimension: "anthropic", total: 1_000_000 },
              { dimension: "openai", total: 50 },
            ],
            1_000_050,
          )
        : response([{ dimension: "f", total: 1 }], 1),
    );
    render(<SummaryCards range="30d" filterProvider={null} onSelectProvider={vi.fn()} />);
    expect(await screen.findByTestId("summary-card-provider-openai")).toHaveTextContent("<0.1% of total");
    expect(screen.getByTestId("summary-card-provider-anthropic")).toHaveTextContent("100.0% of total");
  });

  it("says the summary failed to load and retries on request", async () => {
    vi.mocked(fetchAnalytics).mockRejectedValueOnce(new Error("500"));
    render(<SummaryCards range="30d" filterProvider={null} onSelectProvider={vi.fn()} />);
    const error = await screen.findByTestId("summary-cards-error");
    expect(error).toHaveTextContent("Could not load the summary.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("summary-card-provider-deepseek")).toBeVisible();
    expect(screen.queryByTestId("summary-cards-error")).toBeNull();
  });

  it("shows the loading state, not the previous window's cards, while a new range loads", async () => {
    const { rerender } = render(
      <SummaryCards range="30d" filterProvider={null} onSelectProvider={vi.fn()} />,
    );
    await screen.findByTestId("summary-card-provider-deepseek");
    vi.mocked(fetchAnalytics).mockImplementation(() => new Promise(() => {}));
    rerender(<SummaryCards range="7d" filterProvider={null} onSelectProvider={vi.fn()} />);
    expect(screen.getByTestId("summary-cards-loading")).toBeVisible();
    expect(screen.queryByTestId("summary-card-provider-deepseek")).toBeNull();
  });
});
