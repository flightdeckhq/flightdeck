import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunBracket } from "@/components/timeline/RunBracket";
import type { RowGlyph, RunSegment } from "@/lib/swimlane-lanes";
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

	it("sits on the top edge for lane 0 and the bottom edge for lane 1", () => {
		const { rerender } = render(
			<RunBracket glyph={makeGlyph("start")} session={makeSession()} onClick={vi.fn()} />,
		);
		let glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph.style.top).toBe("2px");
		expect(glyph.style.bottom).toBe("");
		rerender(
			<RunBracket
				glyph={makeGlyph("start", {}, { lane: 1 })}
				session={makeSession()}
				onClick={vi.fn()}
			/>,
		);
		glyph = screen.getByTestId("swimlane-run-bracket-start-abcd1234");
		expect(glyph.style.bottom).toBe("2px");
		expect(glyph.style.top).toBe("");
		expect(glyph).toHaveAttribute("data-run-lane", "1");
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
