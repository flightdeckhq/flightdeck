import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunBracket, RunLine } from "@/components/timeline/RunBracket";
import type { RowGlyph, RowLine, RunSegment } from "@/lib/swimlane-lanes";
import type { Session } from "@/lib/types";

const SESSION_ID = "abcd1234-eeee-ffff-0000-111122223333";
const START_MS = Date.parse("2026-05-13T16:00:00Z");
const END_MS = Date.parse("2026-05-13T16:30:00Z");

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		session_id: SESSION_ID,
		flavor: "research-agent",
		agent_type: "production",
		host: null,
		framework: null,
		model: null,
		state: "closed",
		started_at: new Date(START_MS).toISOString(),
		last_seen_at: new Date(END_MS).toISOString(),
		ended_at: new Date(END_MS).toISOString(),
		tokens_used: 1234,
		token_limit: null,
		...overrides,
	};
}

function makeGlyph(
	kind: "start" | "end",
	segment: Partial<RunSegment> = {},
	overrides: Partial<RowGlyph> = {},
): RowGlyph {
	return {
		key: `${SESSION_ID}#0:${kind}`,
		kind,
		lane: 0,
		laneCount: 1,
		sharedBy: 1,
		left: 120,
		width: kind === "start" ? 10 : 11,
		segment: {
			sessionId: SESSION_ID,
			index: 0,
			count: 1,
			startMs: START_MS,
			endMs: END_MS,
			endKind: "closed",
			...segment,
		},
		...overrides,
	};
}

function hhmmss(ms: number): string {
	const d = new Date(ms);
	return [d.getHours(), d.getMinutes(), d.getSeconds()]
		.map((n) => String(n).padStart(2, "0"))
		.join(":");
}

describe("RunBracket", () => {
	it("draws a start glyph as a triangle at the left edge the layout packed it to", () => {
		render(<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />);
		const glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph.querySelector("polygon")).not.toBeNull();
		expect(glyph).toHaveAttribute("data-bracket-kind", "start");
		expect(glyph).toHaveAttribute("data-session-id", SESSION_ID);
		expect(glyph).toHaveAttribute("data-run-lane", "0");
		expect(glyph).not.toHaveAttribute("data-end-kind");
		expect(glyph.style.left).toBe("120px");
	});

	it("sits on the row's top edge on a one-line row", () => {
		render(<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />);
		const glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph.style.top).toBe("2px");
		expect(glyph).toHaveAttribute("data-run-lane", "0");
	});

	it("centres on its lane on a split row", () => {
		const { rerender } = render(
			<RunBracket
				glyph={makeGlyph("start", {}, { lane: 1, laneCount: 3 })}
				session={makeSession()}
				onClick={vi.fn()}
			/>,
		);
		let glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph.style.top).toBe("calc(50% - 5px)");
		expect(glyph).toHaveAttribute("data-run-lane", "1");
		rerender(
			<RunBracket
				glyph={makeGlyph("end", {}, { lane: 3, laneCount: 4, width: 9 })}
				session={makeSession()}
				onClick={vi.fn()}
			/>,
		);
		glyph = screen.getByTestId("swimlane-run-bracket-end-abcd1234");
		expect(glyph.style.top).toBe("calc(87.5% - 4.5px)");
	});

	it("draws 8 px and 9 px glyphs at the size the layout gives them on a four-lane row", () => {
		render(
			<>
				<RunBracket
					glyph={makeGlyph("start", {}, { laneCount: 4, width: 8 })}
					session={makeSession()}
					onClick={vi.fn()}
				/>
				<RunBracket
					glyph={makeGlyph("end", {}, { laneCount: 4, width: 9 })}
					session={makeSession()}
					onClick={vi.fn()}
				/>
			</>,
		);
		const start = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		const end = screen.getByTestId("swimlane-run-bracket-end-abcd1234");
		expect([start.style.width, start.style.height]).toEqual(["8px", "8px"]);
		expect([end.style.width, end.style.height]).toEqual(["9px", "9px"]);
		expect(start.querySelector("svg")).toHaveAttribute("width", "8");
		expect(end.querySelector("rect")).toHaveAttribute("width", "9");
	});

	it("names its lane on a split row, and how many runs share the overflow lane", () => {
		const { rerender } = render(
			<RunBracket
				glyph={makeGlyph("start", {}, { lane: 1, laneCount: 3 })}
				session={makeSession()}
				onClick={vi.fn()}
			/>,
		);
		let glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, lane 2 of 3, start ${hhmmss(START_MS)}`,
		);
		fireEvent.mouseEnter(glyph);
		expect(screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234").textContent).toContain(
			"lane 2 of 3",
		);
		fireEvent.mouseLeave(glyph);
		rerender(
			<RunBracket
				glyph={makeGlyph("start", {}, { lane: 3, laneCount: 4, sharedBy: 2, width: 8 })}
				session={makeSession()}
				onClick={vi.fn()}
			/>,
		);
		glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, lane 4 of 4, shared by 2 runs, start ${hhmmss(START_MS)}`,
		);
		fireEvent.mouseEnter(glyph);
		expect(screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234").textContent).toContain(
			"lane 4 of 4 · shared by 2 runs",
		);
	});

	it("draws a closed segment's end as a filled square", () => {
		render(<RunBracket glyph={makeGlyph("end")} session={makeSession()} onClick={vi.fn()} />);
		const glyph = screen.getByTestId("swimlane-run-bracket-end-abcd1234");
		const rect = glyph.querySelector("rect");
		expect(rect).toHaveAttribute("fill", "var(--accent)");
		expect(glyph).toHaveAttribute("data-end-kind", "closed");
	});

	it("draws a lost segment's end as a hollow square with the lost stroke", () => {
		render(
			<RunBracket
				glyph={makeGlyph("end", { endKind: "lost" })}
				session={makeSession({ state: "lost", ended_at: null })}
				onClick={vi.fn()}
			/>,
		);
		const glyph = screen.getByTestId("swimlane-run-bracket-end-abcd1234");
		const rect = glyph.querySelector("rect");
		expect(rect).toHaveAttribute("fill", "none");
		expect(rect).toHaveAttribute("stroke", "var(--status-lost)");
		expect(glyph).toHaveAttribute("data-end-kind", "lost");
	});

	it("makes the end square's box larger than the start triangle's", () => {
		render(
			<>
				<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />
				<RunBracket glyph={makeGlyph("end")} session={makeSession()} onClick={vi.fn()} />
			</>,
		);
		const start = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		const end = screen.getByTestId("swimlane-run-bracket-end-abcd1234");
		const area = (el: HTMLElement) => parseFloat(el.style.width) * parseFloat(el.style.height);
		expect(area(end)).toBeGreaterThan(area(start));
	});

	it("shows the run's id, start, end, state and tokens on hover", () => {
		render(<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />);
		fireEvent.mouseEnter(screen.getByTestId("swimlane-run-bracket-start-abcd1234"));
		const text = screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234").textContent ?? "";
		expect(text).toContain("run abcd1234");
		expect(text).toContain(`start: ${hhmmss(START_MS)}`);
		expect(text).toContain(`end:   ${hhmmss(END_MS)}`);
		expect(text).toContain("state: closed");
		expect(text).toContain("tokens: 1,234");
		expect(text).not.toContain("segment");
	});

	it("reads an open segment's end as running", () => {
		render(
			<RunBracket
				glyph={makeGlyph("start", { endKind: "open", endMs: Number.POSITIVE_INFINITY })}
				session={makeSession({ state: "active", ended_at: null })}
				onClick={vi.fn()}
			/>,
		);
		fireEvent.mouseEnter(screen.getByTestId("swimlane-run-bracket-start-abcd1234"));
		expect(screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234").textContent).toContain(
			"end:   running",
		);
	});

	it("reads a lost segment's end as lost at its last signal", () => {
		render(
			<RunBracket
				glyph={makeGlyph("end", { endKind: "lost" })}
				session={makeSession({ state: "lost", ended_at: null })}
				onClick={vi.fn()}
			/>,
		);
		fireEvent.mouseEnter(screen.getByTestId("swimlane-run-bracket-end-abcd1234"));
		expect(screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234").textContent).toContain(
			`end:   lost · last seen ${hhmmss(END_MS)}`,
		);
	});

	it("names the segment of a resumed run", () => {
		render(
			<RunBracket
				glyph={makeGlyph("start", { index: 1, count: 3 })}
				session={makeSession()}
				onClick={vi.fn()}
			/>,
		);
		const glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph).toHaveAttribute("data-segment-index", "1");
		fireEvent.mouseEnter(glyph);
		expect(screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234").textContent).toContain(
			"segment 2 of 3",
		);
		expect(glyph).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, segment 2 of 3, start ${hhmmss(START_MS)}`,
		);
	});

	it("labels each glyph with the run, the glyph and its time", () => {
		render(
			<>
				<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />
				<RunBracket glyph={makeGlyph("end")} session={makeSession()} onClick={vi.fn()} />
			</>,
		);
		expect(screen.getByTestId("swimlane-run-bracket-start-abcd1234")).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, start ${hhmmss(START_MS)}`,
		);
		expect(screen.getByTestId("swimlane-run-bracket-end-abcd1234")).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, end ${hhmmss(END_MS)}`,
		);
	});

	it("labels a lost end with its last signal", () => {
		render(
			<RunBracket
				glyph={makeGlyph("end", { endKind: "lost" })}
				session={makeSession({ state: "lost" })}
				onClick={vi.fn()}
			/>,
		);
		expect(screen.getByTestId("swimlane-run-bracket-end-abcd1234")).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, lost, last seen ${hhmmss(END_MS)}`,
		);
	});

	it("shows a focus ring and the tooltip on keyboard focus", () => {
		render(<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />);
		const glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph.className).toContain("focus-visible:outline-2");
		expect(glyph.className).toContain("focus-visible:outline-(--accent)");
		fireEvent.focus(glyph);
		expect(screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234")).toBeInTheDocument();
		fireEvent.blur(glyph);
		expect(screen.queryByTestId("swimlane-run-bracket-tooltip-abcd1234")).toBeNull();
	});

	it("renders the tooltip in a portal on document.body", () => {
		const { container } = render(
			<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />,
		);
		fireEvent.mouseEnter(screen.getByTestId("swimlane-run-bracket-start-abcd1234"));
		const tooltip = screen.getByTestId("swimlane-run-bracket-tooltip-abcd1234");
		expect(tooltip.parentElement).toBe(document.body);
		expect(container.contains(tooltip)).toBe(false);
	});

	it("hands the run's id to onClick", () => {
		const onClick = vi.fn();
		render(<RunBracket glyph={makeGlyph("end")} session={makeSession()} onClick={onClick} />);
		fireEvent.click(screen.getByTestId("swimlane-run-bracket-end-abcd1234"));
		expect(onClick).toHaveBeenCalledWith(SESSION_ID);
	});
});

function makeLine(segment: Partial<RunSegment> = {}, overrides: Partial<RowLine> = {}): RowLine {
	return {
		key: `${SESSION_ID}#0:line`,
		lane: 1,
		laneCount: 2,
		sharedBy: 1,
		x1: 100,
		x2: 400,
		quietX: null,
		focusable: false,
		segment: {
			sessionId: SESSION_ID,
			index: 0,
			count: 1,
			startMs: START_MS,
			endMs: END_MS,
			endKind: "closed",
			...segment,
		},
		...overrides,
	};
}

describe("RunLine", () => {
	const line = () => screen.getByTestId("swimlane-run-line-abcd1234");

	it("spans its segment on its lane's centre", () => {
		render(<RunLine line={makeLine()} session={makeSession()} highlighted={false} onClick={vi.fn()} />);
		expect(line().style.left).toBe("100px");
		expect(line().style.width).toBe("300px");
		expect(line().style.top).toBe("calc(75% - 4px)");
		expect(line()).toHaveAttribute("data-run-lane", "1");
		expect(line()).toHaveAttribute("data-session-id", SESSION_ID);
		expect(line()).toHaveAttribute("data-tail", "live");
		expect(screen.getByTestId("swimlane-run-solid-part").style.width).toBe("300px");
		expect(screen.queryByTestId("swimlane-run-quiet-tail")).toBeNull();
	});

	it("splits into a solid line and a dashed tail where the run went quiet", () => {
		const quietSince = START_MS + 60_000;
		render(
			<RunLine
				line={makeLine(
					{ endKind: "open", endMs: Number.POSITIVE_INFINITY, quietSinceMs: quietSince },
					{ quietX: 250 },
				)}
				session={makeSession({ state: "stale", ended_at: null })}
				highlighted={false}
				onClick={vi.fn()}
			/>,
		);
		expect(line()).toHaveAttribute("data-tail", "quiet");
		expect(screen.getByTestId("swimlane-run-solid-part").style.width).toBe("150px");
		const tail = screen.getByTestId("swimlane-run-quiet-tail");
		expect(tail.style.left).toBe("150px");
		expect(tail.style.width).toBe("150px");
		expect(tail.style.background).toContain("repeating-linear-gradient");
		expect(line()).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, lane 2 of 2, running, quiet since ${hhmmss(quietSince)}`,
		);
		fireEvent.mouseEnter(line());
		expect(screen.getByTestId("swimlane-run-line-tooltip-abcd1234").textContent).toContain(
			`end:   running · quiet since ${hhmmss(quietSince)}`,
		);
	});

	it("takes keyboard focus only when neither of its glyphs is in view", () => {
		const { rerender } = render(
			<RunLine line={makeLine()} session={makeSession()} highlighted={false} onClick={vi.fn()} />,
		);
		expect(line().tabIndex).toBe(-1);
		rerender(
			<RunLine
				line={makeLine({}, { focusable: true })}
				session={makeSession()}
				highlighted={false}
				onClick={vi.fn()}
			/>,
		);
		expect(line().tabIndex).toBe(0);
		expect(line().className).toContain("focus-visible:outline-(--accent)");
	});

	it("rises to full opacity while its run is highlighted", () => {
		const { rerender } = render(
			<RunLine line={makeLine()} session={makeSession()} highlighted={false} onClick={vi.fn()} />,
		);
		expect(line().style.opacity).toBe("0.6");
		rerender(<RunLine line={makeLine()} session={makeSession()} highlighted onClick={vi.fn()} />);
		expect(line().style.opacity).toBe("1");
		expect(line()).toHaveAttribute("data-highlighted", "true");
	});

	it("opens its run on click, and takes no pointer input in the overflow lane", () => {
		const onClick = vi.fn();
		const { rerender } = render(
			<RunLine line={makeLine()} session={makeSession()} highlighted={false} onClick={onClick} />,
		);
		fireEvent.click(line());
		expect(onClick).toHaveBeenCalledWith(SESSION_ID);
		expect(line().style.pointerEvents).toBe("auto");
		rerender(
			<RunLine
				line={makeLine({}, { lane: 3, laneCount: 4, sharedBy: 2 })}
				session={makeSession()}
				highlighted={false}
				onClick={onClick}
			/>,
		);
		expect(line().style.pointerEvents).toBe("none");
		expect(line()).toHaveAttribute("data-shared", "true");
		expect(line()).toHaveAttribute(
			"aria-label",
			`Open run abcd1234, lane 4 of 4, shared by 2 runs, end ${hhmmss(END_MS)}`,
		);
	});
});
