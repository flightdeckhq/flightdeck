import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EventFilterBar } from "@/components/fleet/EventFilterBar";

describe("EventFilterBar", () => {
  it("renders all 8 pills (incl Phase 4 Embeddings + Errors)", () => {
    render(<EventFilterBar activeFilter={null} onFilterChange={() => {}} />);
    expect(screen.getByTestId("filter-pill-All")).toBeInTheDocument();
    expect(screen.getByTestId("filter-pill-LLM Calls")).toBeInTheDocument();
    expect(screen.getByTestId("filter-pill-Tools")).toBeInTheDocument();
    expect(screen.getByTestId("filter-pill-Embeddings")).toBeInTheDocument();
    expect(screen.getByTestId("filter-pill-Errors")).toBeInTheDocument();
    expect(screen.getByTestId("filter-pill-Policy")).toBeInTheDocument();
    expect(screen.getByTestId("filter-pill-Directives")).toBeInTheDocument();
    expect(screen.getByTestId("filter-pill-Session")).toBeInTheDocument();
  });

  it("All pill is active by default when activeFilter is null", () => {
    const { container } = render(
      <EventFilterBar activeFilter={null} onFilterChange={() => {}} />
    );
    const allPill = screen.getByTestId("filter-pill-All");
    // Active All pill has accent-glow background
    expect(allPill.style.background).toBe("var(--accent-glow)");
  });

  it("clicking Tools activates it and calls onFilterChange", () => {
    const onFilterChange = vi.fn();
    render(<EventFilterBar activeFilter={null} onFilterChange={onFilterChange} />);
    fireEvent.click(screen.getByTestId("filter-pill-Tools"));
    expect(onFilterChange).toHaveBeenCalledWith("Tools");
  });

  it("clicking active Tools returns to All", () => {
    const onFilterChange = vi.fn();
    render(<EventFilterBar activeFilter="Tools" onFilterChange={onFilterChange} />);
    fireEvent.click(screen.getByTestId("filter-pill-Tools"));
    expect(onFilterChange).toHaveBeenCalledWith(null);
  });

  it("each non-All pill has a colored dot", () => {
    render(<EventFilterBar activeFilter={null} onFilterChange={() => {}} />);
    const dots = screen.getAllByTestId("filter-dot");
    // 8 non-All pills: LLM Calls, Tools, Embeddings, MCP (Phase 5),
    // Errors, Policy, Directives, Session.
    expect(dots).toHaveLength(8);
  });
});
