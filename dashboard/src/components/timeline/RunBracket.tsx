import { memo, useCallback, useState } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session } from "@/lib/types";

// RunBracket renders the per-run boundary glyphs on a single agent's
// swimlane row:
//
//   * ``"start"`` is a filled play-button triangle (▶) at the run's
//     started_at X. Always rendered when the run's start is in the
//     visible time window.
//   * ``"end"`` is a filled solid square (■) at the run's ended_at X,
//     sized ~1.3× the triangle's bbox area so the closure reads as a
//     heavier visual signal at a glance. Rendered ONLY when the run
//     has actually ended; active / idle / stale / lost runs render no
//     end glyph (operators read absence as "still running").
//
// Hover surfaces a tooltip with the run's metadata (id prefix, start,
// end-or-"running", state, tokens); click opens the existing session
// drawer scoped to that run.
//
// Concurrent runs of the same agent (multi-pod K8s with collapsed
// FLIGHTDECK_HOSTNAME, etc.) render with a vertical offset so two
// overlapping pairs are visually distinguishable: ``anchor="top"``
// pins the glyphs to the row's top edge, ``anchor="bottom"`` pins
// them to the bottom. Three or more concurrent runs accept visual
// overlap; the hover tooltip disambiguates by run_id.

export type RunBracketAnchor = "top" | "bottom";

interface RunBracketProps {
	session: Session;
	scale: ScaleTime<number, number>;
	/**
	 * Right edge of the timeline panel in pixels. Kept on the prop
	 * surface for compatibility with the SwimLane row's clip math;
	 * the active-run end glyph is no longer rendered so the value is
	 * unused for that path.
	 */
	timelineWidth: number;
	/** Vertical anchor for staggering concurrent runs. */
	anchor: RunBracketAnchor;
	onClick: (sessionId: string) => void;
}

// Triangle (start glyph) base + height. Sized to roughly match the
// event-circle visual weight (~10 px) so the start doesn't dominate
// the row.
const TRIANGLE_WIDTH = 10;
const TRIANGLE_HEIGHT = 10;
// Square (end glyph) side. Bbox area is SQUARE_SIDE² which we size
// at ~1.3× the triangle's bbox area (TRIANGLE_WIDTH × TRIANGLE_HEIGHT)
// so the closure reads heavier than the start. sqrt(1.3 × 10 × 10) ≈
// 11.4 → 11 keeps the integer pixel grid honest while preserving the
// asymmetry.
const SQUARE_SIDE = 11;
// Vertical inset from the row edge so the glyph clears the row
// border. Same value start + end so the pair sits on a shared
// baseline.
const VERTICAL_MARGIN = 2;
// Horizontal gap between the glyph and its hover tooltip.
const TOOLTIP_OFFSET = 4;
// Hover tooltip layout. Kept inline (the tooltip lives only on
// this component) rather than pushed into the theme tokens
// because RunBracket is the sole consumer and the values are
// deliberately tighter than the page-level tooltip surface in
// SessionDrawer.
//
// 4px radius keeps the chip readable at the row-edge attach
// point without the rounded corners dominating an 11pt label.
// 4 / 8 padding asymmetric so the chip reads compact vertically
// (close to a single-line label height) while leaving horizontal
// air around the `run_id` + time strings. 11pt is the standard
// hover-chip size in this codebase (matches EventNode's tooltip)
// so the swimlane reads consistently across surfaces.
const TOOLTIP_BORDER_RADIUS = 4;
const TOOLTIP_PADDING_Y = 4;
const TOOLTIP_PADDING_X = 8;
const TOOLTIP_FONT_SIZE = 11;

function formatRunTime(iso: string): string {
	const d = new Date(iso);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function RunBracketComponent({
	session,
	scale,
	timelineWidth,
	anchor,
	onClick,
}: RunBracketProps) {
	const onMarkClick = useCallback(() => {
		onClick(session.session_id);
	}, [onClick, session.session_id]);

	const start = new Date(session.started_at);
	const xStart = scale(start);
	// ``endedAt`` is the narrowed local mirror of session.ended_at;
	// using it for the gate eliminates the ``session.ended_at as
	// string`` cast at the formatRunTime + end-Date construction
	// sites below.
	const endedAt: string | null = session.ended_at ?? null;
	const end = endedAt === null ? null : new Date(endedAt);
	const xEnd = end ? scale(end) : null;

	const domain = scale.domain();
	const domainStart = domain[0];
	const domainEnd = domain[1];
	// inWindow guards the START glyph specifically: if started_at is
	// off-screen, neither the triangle nor the square render (the
	// pair anchors on start). ``timelineWidth`` participates here
	// because the triangle's right edge can sit slightly inside the
	// visible band even when xStart is just past it.
	const inWindow =
		xStart >= -TRIANGLE_WIDTH && xStart <= timelineWidth + TRIANGLE_WIDTH;
	const startInDomain =
		!!domainStart &&
		!!domainEnd &&
		start.getTime() >= domainStart.getTime() &&
		start.getTime() <= domainEnd.getTime();
	if (!inWindow || !startInDomain) {
		// The start glyph is outside the visible window; nothing to
		// anchor the pair to. Skip the render entirely so a long-
		// running historical run that started before the visible
		// window doesn't clutter the row with a left-edge stub.
		return null;
	}

	const idPrefix = session.session_id.slice(0, 8);
	const startLabel = formatRunTime(session.started_at);
	const endLabel = endedAt ? formatRunTime(endedAt) : "running";
	const tokens = session.tokens_used ?? 0;
	const tooltipText = `run ${idPrefix}\nstart: ${startLabel}\nend:   ${endLabel}\nstate: ${session.state}\ntokens: ${tokens.toLocaleString()}`;

	// Symmetric clip guard for the end square mirroring the start
	// triangle's inWindow check. Without this, a closed run whose
	// ended_at scales to a value outside the visible pixel range
	// leaks an absolutely-positioned <button> outside the row's
	// horizontal bounds and a click target lands in nowhere-land.
	const endInWindow =
		xEnd !== null &&
		xEnd >= -SQUARE_SIDE &&
		xEnd <= timelineWidth + SQUARE_SIDE &&
		!!end &&
		!!domainStart &&
		!!domainEnd &&
		end.getTime() >= domainStart.getTime() &&
		end.getTime() <= domainEnd.getTime();

	return (
		<>
			<RunBoundaryMark
				kind="start"
				x={xStart}
				anchor={anchor}
				tooltip={tooltipText}
				sessionId={session.session_id}
				onClick={onMarkClick}
			/>
			{/* End square only renders for closed runs whose ended_at
			    is inside the visible pixel range AND the scale's
			    domain. Active / idle / stale / lost runs render the
			    start triangle alone so operators read "no end glyph"
			    as "still running" — no in-progress dashed tick at the
			    right edge. */}
			{endInWindow && xEnd !== null && (
				<RunBoundaryMark
					kind="end"
					x={xEnd}
					anchor={anchor}
					tooltip={tooltipText}
					sessionId={session.session_id}
					onClick={onMarkClick}
				/>
			)}
		</>
	);
}

// RunBoundaryMark renders one glyph (triangle OR square) anchored at
// ``x`` on the swimlane row. Uses SVG ``<polygon>`` for the start
// triangle and ``<rect>`` for the end square — D3 still does math
// only via the parent's scale; the glyph itself is React-rendered
// SVG (Rule 16).
function RunBoundaryMark({
	kind,
	x,
	anchor,
	tooltip,
	sessionId,
	onClick,
}: {
	kind: "start" | "end";
	x: number;
	anchor: RunBracketAnchor;
	tooltip: string;
	sessionId: string;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	const onHoverEnter = useCallback(() => setHovered(true), []);
	const onHoverLeave = useCallback(() => setHovered(false), []);

	const glyphSize = kind === "start" ? TRIANGLE_WIDTH : SQUARE_SIDE;
	const glyphHeight = kind === "start" ? TRIANGLE_HEIGHT : SQUARE_SIDE;
	const top = anchor === "top" ? VERTICAL_MARGIN : undefined;
	const bottom = anchor === "bottom" ? VERTICAL_MARGIN : undefined;

	return (
		<button
			type="button"
			data-testid={`swimlane-run-bracket-${kind}-${sessionId.slice(0, 8)}`}
			data-bracket-kind={kind}
			aria-label={`Open run ${sessionId.slice(0, 8)} (${kind})`}
			onClick={onClick}
			onMouseEnter={onHoverEnter}
			onMouseLeave={onHoverLeave}
			onFocus={onHoverEnter}
			onBlur={onHoverLeave}
			style={{
				position: "absolute",
				left: x - glyphSize / 2,
				top,
				bottom,
				width: glyphSize,
				height: glyphHeight,
				padding: 0,
				background: "transparent",
				border: "none",
				cursor: "pointer",
				zIndex: 2,
				opacity: hovered ? 1 : 0.85,
				transition: "opacity 120ms ease",
			}}
		>
			<svg
				width={glyphSize}
				height={glyphHeight}
				viewBox={`0 0 ${glyphSize} ${glyphHeight}`}
				style={{ display: "block" }}
				aria-hidden="true"
			>
				{kind === "start" ? (
					<polygon
						points={`0,0 ${TRIANGLE_WIDTH},${TRIANGLE_HEIGHT / 2} 0,${TRIANGLE_HEIGHT}`}
						fill="var(--accent)"
					/>
				) : (
					<rect
						width={SQUARE_SIDE}
						height={SQUARE_SIDE}
						fill="var(--accent)"
					/>
				)}
			</svg>
			{hovered && (
				<span
					role="tooltip"
					data-testid={`swimlane-run-bracket-tooltip-${sessionId.slice(0, 8)}`}
					style={{
						position: "absolute",
						left: glyphSize + TOOLTIP_OFFSET,
						top: 0,
						background: "var(--bg-elevated)",
						color: "var(--text)",
						border: "1px solid var(--border)",
						borderRadius: TOOLTIP_BORDER_RADIUS,
						padding: `${TOOLTIP_PADDING_Y}px ${TOOLTIP_PADDING_X}px`,
						fontFamily: "var(--font-mono)",
						fontSize: TOOLTIP_FONT_SIZE,
						lineHeight: 1.4,
						whiteSpace: "pre",
						pointerEvents: "none",
						zIndex: 5,
					}}
				>
					{tooltip}
				</span>
			)}
		</button>
	);
}

export const RunBracket = memo(RunBracketComponent);

// bracketAnchors returns "top" for the first run and "bottom"
// for every subsequent concurrent run anchored under the same agent
// row. Concurrent is defined as any run whose ``[started_at,
// ended_at OR open-ended]`` interval overlaps any earlier run's
// interval. Three or more concurrent runs collapse to "bottom" (we
// cap the vertical lanes at 2). Caller passes the agent's sessions
// in any order — they're sorted chronologically by start time
// internally.
//
// An active / idle run (no ``ended_at``) is treated as open-ended:
// its overlap interval extends to ``+Infinity``, so every later run
// sees it as still running. Using wall-clock now as a stand-in
// end would incorrectly mark an active run as "ended" relative to
// any test fixture that uses future timestamps.
export function bracketAnchors(
	sessions: Session[],
): Map<string, RunBracketAnchor> {
	const anchors = new Map<string, RunBracketAnchor>();
	const sorted = [...sessions].sort(
		(a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
	);
	const openIntervals: { id: string; endMs: number }[] = [];
	for (const s of sorted) {
		const startMs = new Date(s.started_at).getTime();
		const endMs = s.ended_at
			? new Date(s.ended_at).getTime()
			: Number.POSITIVE_INFINITY;
		// Drop intervals that ended before this run started.
		for (let i = openIntervals.length - 1; i >= 0; i--) {
			const iv = openIntervals[i];
			if (iv && iv.endMs < startMs) openIntervals.splice(i, 1);
		}
		const anchor: RunBracketAnchor = openIntervals.length === 0 ? "top" : "bottom";
		anchors.set(s.session_id, anchor);
		openIntervals.push({ id: s.session_id, endMs });
	}
	return anchors;
}
