import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentStatusBadge } from "@/components/timeline/AgentStatusBadge";

describe("AgentStatusBadge", () => {
	it("applies the swimlane-status-pulse class when state is active", () => {
		render(<AgentStatusBadge state="active" />);
		const dot = screen.getByTestId("swimlane-agent-status-dot");
		expect(dot.className).toContain("swimlane-status-pulse");
	});

	it("does NOT apply the pulse class on non-active states", () => {
		for (const state of ["idle", "stale", "closed", "lost", ""] as const) {
			const { unmount } = render(<AgentStatusBadge state={state} />);
			const dot = screen.getByTestId("swimlane-agent-status-dot");
			expect(dot.className).not.toContain("swimlane-status-pulse");
			unmount();
		}
	});

	it("renders the state label capitalised", () => {
		render(<AgentStatusBadge state="idle" />);
		expect(screen.getByText("Idle")).toBeInTheDocument();
	});

	it("stamps data-state attribute for spec-side filtering", () => {
		const { unmount } = render(<AgentStatusBadge state="stale" />);
		expect(screen.getByTestId("swimlane-agent-status-badge")).toHaveAttribute(
			"data-state",
			"stale",
		);
		unmount();
		render(<AgentStatusBadge state="" />);
		expect(screen.getByTestId("swimlane-agent-status-badge")).toHaveAttribute(
			"data-state",
			"unknown",
		);
	});
});
