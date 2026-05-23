import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentStatusBadge } from "@/components/timeline/AgentStatusBadge";

describe("AgentStatusBadge", () => {
	it("applies the agent-status-active-ring class when state is active", () => {
		render(<AgentStatusBadge state="active" />);
		const dot = screen.getByTestId("swimlane-agent-status-dot");
		expect(dot.className).toContain("agent-status-active-ring");
	});

	it("does NOT apply the active-ring class on non-active states", () => {
		for (const state of ["idle", "stale", "closed", "lost", ""] as const) {
			const { unmount } = render(<AgentStatusBadge state={state} />);
			const dot = screen.getByTestId("swimlane-agent-status-dot");
			expect(dot.className).not.toContain("agent-status-active-ring");
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

	it("default align (auto-right) applies ml-auto", () => {
		// Default-prop coverage: SwimLane, AgentDrawer, and
		// AgentTableRow all rely on the default ``auto-right``
		// alignment to push the badge to the right edge of their
		// flex containers. If the default were accidentally
		// inverted to ``inline`` (e.g. during a merge resolution)
		// every one of those surfaces would silently lose its
		// right-anchored badge. This test pins the default class.
		render(<AgentStatusBadge state="active" />);
		expect(
			screen.getByTestId("swimlane-agent-status-badge").className,
		).toMatch(/\bml-auto\b/);
	});

	it("explicit align='inline' drops ml-auto", () => {
		// The per-agent modal opts into ``inline`` so the badge
		// hugs the topology pill on the left rather than
		// absorbing the space between topology and the close ×.
		render(<AgentStatusBadge state="active" align="inline" />);
		expect(
			screen.getByTestId("swimlane-agent-status-badge").className,
		).not.toMatch(/\bml-auto\b/);
	});
});
