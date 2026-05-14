import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { scaleTime } from "d3-scale";
import { RunBracket, bracketAnchors } from "@/components/timeline/RunBracket";
import type { Session } from "@/lib/types";

function makeSession(overrides: Partial<Session> = {}): Session {
	const start = new Date("2026-05-13T16:00:00Z").toISOString();
	return {
		session_id: "abcd1234-eeee-ffff-0000-111122223333",
		flavor: "research-agent",
		agent_type: "production",
		host: null,
		framework: null,
		model: null,
		state: "closed",
		started_at: start,
		last_seen_at: start,
		ended_at: new Date("2026-05-13T16:30:00Z").toISOString(),
		tokens_used: 1234,
		token_limit: null,
		...overrides,
	};
}

function makeScale() {
	return scaleTime()
		.domain([
			new Date("2026-05-13T15:30:00Z"),
			new Date("2026-05-13T17:00:00Z"),
		])
		.range([0, 900]);
}

describe("RunBracket", () => {
	it("renders a start triangle and an end square when the run has an ended_at", () => {
		render(
			<RunBracket
				session={makeSession()}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={vi.fn()}
			/>,
		);
		const startGlyph = screen.getByTestId(
			"swimlane-run-bracket-start-abcd1234",
		);
		const endGlyph = screen.getByTestId("swimlane-run-bracket-end-abcd1234");
		expect(startGlyph).toBeInTheDocument();
		expect(endGlyph).toBeInTheDocument();
		// Start renders the SVG triangle as a <polygon>; end renders
		// the SVG square as a <rect>. Glyph kind is structural, not
		// theme-dependent.
		expect(startGlyph.querySelector("polygon")).not.toBeNull();
		expect(endGlyph.querySelector("rect")).not.toBeNull();
	});

	it("end square's bbox area is larger than the start triangle's bbox area", () => {
		render(
			<RunBracket
				session={makeSession()}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={vi.fn()}
			/>,
		);
		const startGlyph = screen.getByTestId(
			"swimlane-run-bracket-start-abcd1234",
		);
		const endGlyph = screen.getByTestId("swimlane-run-bracket-end-abcd1234");
		const startW = parseFloat(getComputedStyle(startGlyph).width);
		const startH = parseFloat(getComputedStyle(startGlyph).height);
		const endW = parseFloat(getComputedStyle(endGlyph).width);
		const endH = parseFloat(getComputedStyle(endGlyph).height);
		expect(endW * endH).toBeGreaterThan(startW * startH);
	});

	it("active runs render only the start triangle — no end square", () => {
		render(
			<RunBracket
				session={makeSession({ ended_at: null, state: "active" })}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={vi.fn()}
			/>,
		);
		expect(
			screen.getByTestId("swimlane-run-bracket-start-abcd1234"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("swimlane-run-bracket-end-abcd1234"),
		).toBeNull();
	});

	it("renders BOTH glyphs when state=closed and both timestamps are inside the visible domain", () => {
		// The end-square only renders on closed runs whose
		// ended_at is set; the visible-domain gate is implicit in
		// the in-window check on the parent component. Pin all
		// these constraints in one case so a future refactor that
		// silently flips state-checking or domain-filtering surfaces
		// here, not on the live page.
		const closedSession = makeSession({
			state: "closed",
			started_at: new Date("2026-05-13T16:00:00Z").toISOString(),
			ended_at: new Date("2026-05-13T16:15:00Z").toISOString(),
		});
		render(
			<RunBracket
				session={closedSession}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={vi.fn()}
			/>,
		);
		const startGlyph = screen.getByTestId(
			"swimlane-run-bracket-start-abcd1234",
		);
		const endGlyph = screen.getByTestId(
			"swimlane-run-bracket-end-abcd1234",
		);
		expect(startGlyph).toBeInTheDocument();
		expect(endGlyph).toBeInTheDocument();
		expect(startGlyph.querySelector("polygon")).not.toBeNull();
		expect(endGlyph.querySelector("rect")).not.toBeNull();
	});

	it("idle / stale / lost runs also render only the start triangle", () => {
		for (const state of ["idle", "stale", "lost"] as const) {
			const { unmount } = render(
				<RunBracket
					session={makeSession({ ended_at: null, state })}
					scale={makeScale()}
					timelineWidth={900}
					anchor="top"
					onClick={vi.fn()}
				/>,
			);
			expect(
				screen.queryByTestId("swimlane-run-bracket-end-abcd1234"),
				`state=${state} must not render the end glyph`,
			).toBeNull();
			unmount();
		}
	});

	it("tooltip on hover surfaces run_id prefix, start, end, state, tokens", () => {
		render(
			<RunBracket
				session={makeSession()}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={vi.fn()}
			/>,
		);
		const startTick = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		fireEvent.mouseEnter(startTick);
		const tooltip = screen.getByTestId(
			"swimlane-run-bracket-tooltip-abcd1234",
		);
		expect(tooltip.textContent).toContain("run abcd1234");
		expect(tooltip.textContent).toContain("tokens: 1,234");
		expect(tooltip.textContent).toContain("state: closed");
	});

	it("active-run tooltip reports end:   running", () => {
		render(
			<RunBracket
				session={makeSession({ ended_at: null, state: "active" })}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={vi.fn()}
			/>,
		);
		const startTick = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		fireEvent.mouseEnter(startTick);
		const tooltip = screen.getByTestId(
			"swimlane-run-bracket-tooltip-abcd1234",
		);
		expect(tooltip.textContent).toContain("running");
	});

	it("click handler fires with the run's session_id", () => {
		const onClick = vi.fn();
		render(
			<RunBracket
				session={makeSession()}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={onClick}
			/>,
		);
		fireEvent.click(screen.getByTestId("swimlane-run-bracket-start-abcd1234"));
		expect(onClick).toHaveBeenCalledWith(
			"abcd1234-eeee-ffff-0000-111122223333",
		);
	});

	it("does not render when the run start is outside the visible window", () => {
		const old = makeSession({
			started_at: new Date("2026-05-13T10:00:00Z").toISOString(),
			ended_at: new Date("2026-05-13T10:30:00Z").toISOString(),
		});
		const { container } = render(
			<RunBracket
				session={old}
				scale={makeScale()}
				timelineWidth={900}
				anchor="top"
				onClick={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("bracketAnchors", () => {
	it("anchors the first run to top and concurrent runs to bottom", () => {
		const s1 = makeSession({
			session_id: "aaaaaaaa-1111-1111-1111-111111111111",
			started_at: new Date("2026-05-13T16:00:00Z").toISOString(),
			ended_at: new Date("2026-05-13T16:30:00Z").toISOString(),
		});
		const s2 = makeSession({
			session_id: "bbbbbbbb-2222-2222-2222-222222222222",
			started_at: new Date("2026-05-13T16:10:00Z").toISOString(),
			ended_at: new Date("2026-05-13T16:40:00Z").toISOString(),
		});
		const anchors = bracketAnchors([s1, s2]);
		expect(anchors.get(s1.session_id)).toBe("top");
		expect(anchors.get(s2.session_id)).toBe("bottom");
	});

	it("re-anchors to top once an earlier run has ended", () => {
		const s1 = makeSession({
			session_id: "aaaaaaaa-1111-1111-1111-111111111111",
			started_at: new Date("2026-05-13T16:00:00Z").toISOString(),
			ended_at: new Date("2026-05-13T16:10:00Z").toISOString(),
		});
		const s2 = makeSession({
			session_id: "bbbbbbbb-2222-2222-2222-222222222222",
			started_at: new Date("2026-05-13T16:20:00Z").toISOString(),
			ended_at: new Date("2026-05-13T16:40:00Z").toISOString(),
		});
		const anchors = bracketAnchors([s1, s2]);
		expect(anchors.get(s1.session_id)).toBe("top");
		expect(anchors.get(s2.session_id)).toBe("top");
	});

	it("caps a third concurrent run at bottom (no third lane)", () => {
		const base = new Date("2026-05-13T16:00:00Z").toISOString();
		const stillRunning = (id: string) =>
			makeSession({ session_id: id, started_at: base, ended_at: null });
		const a = stillRunning("aaaaaaaa-1111-1111-1111-111111111111");
		const b = stillRunning("bbbbbbbb-2222-2222-2222-222222222222");
		const c = stillRunning("cccccccc-3333-3333-3333-333333333333");
		const anchors = bracketAnchors([a, b, c]);
		expect(anchors.get(a.session_id)).toBe("top");
		expect(anchors.get(b.session_id)).toBe("bottom");
		expect(anchors.get(c.session_id)).toBe("bottom");
	});
});
