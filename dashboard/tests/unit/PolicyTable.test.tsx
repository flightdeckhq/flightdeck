import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PolicyTable } from "@/components/policy/PolicyTable";
import type { Policy } from "@/lib/types";

const mockPolicies: Policy[] = [
  {
    id: "p1",
    scope: "org",
    scope_value: "",
    token_limit: 1000000,
    warn_at_pct: 80,
    degrade_at_pct: null,
    degrade_to: null,
    block_at_pct: 100,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "p2",
    scope: "flavor",
    scope_value: "research-agent",
    token_limit: 50000,
    warn_at_pct: 70,
    degrade_at_pct: 90,
    degrade_to: "claude-haiku-4-5-20251001",
    block_at_pct: 95,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "p3",
    scope: "session",
    scope_value: "abc-123",
    token_limit: null,
    warn_at_pct: null,
    degrade_at_pct: null,
    degrade_to: null,
    block_at_pct: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

describe("PolicyTable", () => {
  it("renders policy list with correct scope badges", () => {
    render(
      <PolicyTable
        policies={mockPolicies}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        loading={false}
      />
    );

    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Run")).toBeInTheDocument();
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.getByText("1,000,000")).toBeInTheDocument();
  });

  it("shows empty state when policies is []", () => {
    render(
      <PolicyTable
        policies={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        loading={false}
      />
    );

    expect(
      screen.getByText(/No policies configured/)
    ).toBeInTheDocument();
  });

  it("delete button opens confirmation dialog", async () => {
    render(
      <PolicyTable
        policies={mockPolicies}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        loading={false}
      />
    );

    const deleteButtons = screen.getAllByText("Delete");
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Delete this policy?")).toBeInTheDocument();
      expect(screen.getByText("Confirm")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });
  });

  it("confirm calls onDelete with correct policy", async () => {
    const onDelete = vi.fn();
    render(
      <PolicyTable
        policies={mockPolicies}
        onEdit={vi.fn()}
        onDelete={onDelete}
        loading={false}
      />
    );

    const deleteButtons = screen.getAllByText("Delete");
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Confirm"));

    expect(onDelete).toHaveBeenCalledWith(mockPolicies[0]);
  });

  it("shows loading skeleton when loading=true", () => {
    const { container } = render(
      <PolicyTable
        policies={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        loading={true}
      />
    );

    // SkeletonRows renders 3 rows with animate-pulse divs
    const pulsingElements = container.querySelectorAll(".animate-pulse");
    expect(pulsingElements.length).toBeGreaterThan(0);

    // Should render 3 skeleton rows, each with 8 cells = 24 pulse elements
    expect(pulsingElements.length).toBe(24);

    // Should not show empty state text
    expect(screen.queryByText(/No policies configured/)).not.toBeInTheDocument();
  });
});
