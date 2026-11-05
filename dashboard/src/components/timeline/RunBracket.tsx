import { memo, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@/lib/types";
import {
	laneCentrePct,
	type RowGlyph,
	type RowLine,
	type RunSegment,
} from "@/lib/swimlane-lanes";

// RunBracket draws one run glyph that SwimLane placed with
// ``layoutRowLanes`` (lib/swimlane-lanes.ts):
//
//   * ``"start"``: a filled triangle (▶) whose flat base sits just
//     inside a segment's start, pointing into the segment.
//   * ``"end"``: a square whose right edge sits just inside a segment's
//     end. Filled for a closed segment; hollow with a ``--status-lost``
//     stroke for a lost one (a lost run, or one the orphan-timeout
//     reaper closed, ends at its last signal). An open segment has no
//     end glyph, so a missing square reads as "still running".
//
// On a one-line row the glyph sits on the row's top edge; on a row
// split into run lanes it sits on its lane's centre. Either way it sits
// at the left edge the layout packed it to, at the size the row's lane
// count gives it. Hover or focus shows the run's tooltip; a click hands
// the run's id to ``onClick``.
//
// ``RunLine`` draws a segment's line along its lane on a split row.

interface RunBracketProps {
	glyph: RowGlyph;
	/** The run the glyph marks: its state and tokens fill the tooltip. */
	session: Session;
	onClick: (sessionId: string) => void;
}

// Vertical inset from the row's top edge, where a one-line row's glyphs
// sit, so the glyph clears the row border. Same value start + end so
// the pair sits on a shared baseline.
const VERTICAL_MARGIN = 2;
// A lost segment's hollow square: the stroke width, and the inset that
// keeps the whole stroke inside the glyph's box.
const LOST_STROKE_PX = 1.5;
// A run line's drawn thickness: thin enough to read as a thread joining
// the run's circles rather than a bar competing with them.
const RUN_LINE_PX = 2;
// The run line's resting opacity, rising to 1 while its run is hovered
// or focused: present enough to follow along a lane, quiet enough that
// the circles on it stay the focus.
const RUN_LINE_REST_OPACITY = 0.6;
// The run line's pointer band: tall enough to hit a 2 px line, and
// inside the 11.75 px lane of a four-lane row so it never reaches a
// neighbouring lane's line.
const RUN_LINE_HIT_PX = 8;
// A quiet tail's dash and gap: long enough to read as dashed at the
// 2 px thickness, short enough that a tail a few seconds wide still
// shows a gap.
const QUIET_DASH_PX = 4;
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
// Renders above the swimlane row buttons (zIndex 2), the
// per-agent swimlane modal's backdrop / chrome, and any other
// portal layer the dashboard stacks. Matches ``EventNode``'s
// tooltip z-index so the two hover surfaces never disagree on
// stacking when both happen to be open against the same modal.
// The repo has no global z-index token file; this constant is
// the single source of truth for the bracket tooltip.
const TOOLTIP_Z_INDEX = 9999;

function formatRunTime(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

/** The tooltip's end line for a segment. */
function endLabel(segment: RunSegment): string {
	if (segment.endKind === "open") {
		return segment.quietSinceMs !== undefined
			? `running · quiet since ${formatRunTime(segment.quietSinceMs)}`
			: "running";
	}
	if (segment.endKind === "lost") return `lost · last seen ${formatRunTime(segment.endMs)}`;
	return formatRunTime(segment.endMs);
}

/** Where a mark sits. */
interface MarkLane {
	lane: number;
	laneCount: number;
	sharedBy: number;
}

/** Where a mark sits on a split row (``lane 2 of 3``, and in the
 *  overflow lane how many runs share it), joined by ``joiner``; null on
 *  a one-line row. */
function laneLabel(mark: MarkLane, joiner: string): string | null {
	if (mark.laneCount <= 1) return null;
	const lane = `lane ${mark.lane + 1} of ${mark.laneCount}`;
	return mark.sharedBy > 1 ? `${lane}${joiner}shared by ${mark.sharedBy} runs` : lane;
}

/** The run's tooltip, shared by its glyphs and its line. */
function tooltipText(segment: RunSegment, session: Session, mark: MarkLane): string {
	const lines = [
		`run ${segment.sessionId.slice(0, 8)}`,
		`start: ${formatRunTime(segment.startMs)}`,
		`end:   ${endLabel(segment)}`,
		`state: ${session.state}`,
		`tokens: ${(session.tokens_used ?? 0).toLocaleString()}`,
	];
	if (segment.count > 1) lines.push(`segment ${segment.index + 1} of ${segment.count}`);
	const lane = laneLabel(mark, " · ");
	if (lane) lines.push(lane);
	return lines.join("\n");
}

/** The opening of a mark's accessible name: the run, its segment on a
 *  resumed run, and its lane on a split row. */
function runLabel(segment: RunSegment, mark: MarkLane): string {
	const part = segment.count > 1 ? `, segment ${segment.index + 1} of ${segment.count}` : "";
	const lane = laneLabel(mark, ", ");
	return `Open run ${segment.sessionId.slice(0, 8)}${part}${lane ? `, ${lane}` : ""}`;
}

/** The glyph's accessible name: the run, the glyph, its time and, on
 *  a split row, its lane. */
function ariaLabel(glyph: RowGlyph): string {
	const { segment } = glyph;
	const run = runLabel(segment, glyph);
	if (glyph.kind === "start") return `${run}, start ${formatRunTime(segment.startMs)}`;
	if (segment.endKind === "lost") {
		return `${run}, lost, last seen ${formatRunTime(segment.endMs)}`;
	}
	return `${run}, end ${formatRunTime(segment.endMs)}`;
}

/** The top of a mark ``size`` px tall: the row's top edge on a
 *  one-line row, else centred on its lane. */
function markTop(lane: number, laneCount: number, size: number): string | number {
	if (laneCount <= 1) return VERTICAL_MARGIN;
	return `calc(${laneCentrePct(lane, laneCount)}% - ${size / 2}px)`;
}

/**
 * Hover and focus open the tooltip. It is anchored to the button's
 * viewport rect so ``position: fixed`` takes it out of the
 * timeline-panel's ``overflow: hidden`` clip — the tooltip is taller
 * than the 48-px row, so an absolutely-positioned child of the panel
 * gets clipped at the top or the bottom whatever its lane. The
 * fixed-coordinate approach mirrors how ``EventNode`` positions its own
 * tooltip and is the only way to render off-clip.
 *
 * The coordinates are snapshotted at hover time and are NOT refreshed
 * if the user scrolls or resizes the window while hovering. The
 * pointer must stay on the button to keep the tooltip visible, so any
 * active scroll already moves the operator off-button and
 * ``onMouseLeave`` fires. ``EventNode`` has the same no-listener
 * behaviour for the same reason.
 */
function useMarkTooltip() {
	const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
	const onHoverEnter = useCallback(
		(e: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>) => {
			const rect = e.currentTarget.getBoundingClientRect();
			setTooltipPos({
				left: rect.right + TOOLTIP_OFFSET,
				top: rect.top + rect.height / 2,
			});
		},
		[],
	);
	const onHoverLeave = useCallback(() => setTooltipPos(null), []);
	return { tooltipPos, onHoverEnter, onHoverLeave };
}

function RunBracketComponent({ glyph, session, onClick }: RunBracketProps) {
	const { segment, kind } = glyph;
	const sessionId = segment.sessionId;
	const idPrefix = sessionId.slice(0, 8);
	const onMarkClick = useCallback(() => onClick(sessionId), [onClick, sessionId]);
	const { tooltipPos, onHoverEnter, onHoverLeave } = useMarkTooltip();

	const size = glyph.width;
	const lost = kind === "end" && segment.endKind === "lost";

	return (
		<>
			<button
				type="button"
				data-testid={`swimlane-run-bracket-${kind}-${idPrefix}`}
				data-bracket-kind={kind}
				// The run this glyph marks; Timeline's delegated hover
				// and focus handlers read it to light the run's
				// sub-agent connectors.
				data-session-id={sessionId}
				data-run-lane={glyph.lane}
				data-segment-index={segment.index}
				data-end-kind={kind === "end" ? segment.endKind : undefined}
				aria-label={ariaLabel(glyph)}
				onClick={onMarkClick}
				onMouseEnter={onHoverEnter}
				onMouseLeave={onHoverLeave}
				onFocus={onHoverEnter}
				onBlur={onHoverLeave}
				className="focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent)"
				style={{
					position: "absolute",
					left: glyph.left,
					top: markTop(glyph.lane, glyph.laneCount, size),
					width: size,
					height: size,
					padding: 0,
					background: "transparent",
					border: "none",
					cursor: "pointer",
					zIndex: 2,
					opacity: tooltipPos ? 1 : 0.85,
					transition: "opacity 120ms ease",
				}}
			>
				<svg
					width={size}
					height={size}
					viewBox={`0 0 ${size} ${size}`}
					style={{ display: "block" }}
					aria-hidden="true"
				>
					{kind === "start" ? (
						<polygon
							points={`0,0 ${size},${size / 2} 0,${size}`}
							fill="var(--accent)"
						/>
					) : lost ? (
						<rect
							x={LOST_STROKE_PX / 2}
							y={LOST_STROKE_PX / 2}
							width={size - LOST_STROKE_PX}
							height={size - LOST_STROKE_PX}
							fill="none"
							stroke="var(--status-lost)"
							strokeWidth={LOST_STROKE_PX}
						/>
					) : (
						<rect width={size} height={size} fill="var(--accent)" />
					)}
				</svg>
			</button>
			{tooltipPos && (
				<RunBracketTooltipPortal
					testId={`swimlane-run-bracket-tooltip-${idPrefix}`}
					tooltip={tooltipText(segment, session, glyph)}
					tooltipPos={tooltipPos}
				/>
			)}
		</>
	);
}

function RunBracketTooltipPortal({
	testId,
	tooltip,
	tooltipPos,
}: {
	testId: string;
	tooltip: string;
	tooltipPos: { left: number; top: number };
}) {
	// Render the tooltip in a portal anchored to ``document.body`` so
	// the ``position: fixed`` coordinates resolve against the actual
	// viewport (not a transformed ancestor's containing block) AND
	// the tooltip escapes every parent stacking context — the
	// per-agent swimlane modal, the timeline panel's
	// ``overflow: hidden`` clip, any motion (Framer Motion) transform layer
	// in between. Mirrors the pattern ``EventNode`` already uses.
	return createPortal(
		<span
			role="tooltip"
			data-testid={testId}
			style={{
				position: "fixed",
				left: tooltipPos.left,
				top: tooltipPos.top,
				transform: "translateY(-50%)",
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
				zIndex: TOOLTIP_Z_INDEX,
			}}
		>
			{tooltip}
		</span>,
		document.body,
	);
}

export const RunBracket = memo(RunBracketComponent);

interface RunLineProps {
	line: RowLine;
	/** The run the line joins: its state and tokens fill the tooltip. */
	session: Session;
	/** A mark of the line's run is hovered or focused on the row. */
	highlighted: boolean;
	onClick: (sessionId: string) => void;
}

/** A line's accessible end: how its segment ends. */
function lineEnd(segment: RunSegment): string {
	if (segment.endKind === "open") {
		return segment.quietSinceMs !== undefined
			? `running, quiet since ${formatRunTime(segment.quietSinceMs)}`
			: "running";
	}
	if (segment.endKind === "lost") return `lost, last seen ${formatRunTime(segment.endMs)}`;
	return `end ${formatRunTime(segment.endMs)}`;
}

/**
 * One segment's line along its lane on a split row: solid
 * ``var(--accent)``, dashed from where a stale run went quiet. It is a
 * button under the circles and glyphs that opens the run like a glyph.
 * It takes keyboard focus only when neither of the segment's glyphs is
 * in view, so the segment keeps one tab stop. In the overflow lane the
 * lines overlap, so they take no pointer input there.
 */
function RunLineComponent({ line, session, highlighted, onClick }: RunLineProps) {
	const { segment } = line;
	const sessionId = segment.sessionId;
	const idPrefix = sessionId.slice(0, 8);
	const onLineClick = useCallback(() => onClick(sessionId), [onClick, sessionId]);
	const { tooltipPos, onHoverEnter, onHoverLeave } = useMarkTooltip();
	const width = line.x2 - line.x1;
	const solidWidth = line.quietX === null ? width : line.quietX - line.x1;
	const shared = line.sharedBy > 1;
	const lit = highlighted || tooltipPos !== null;
	const bar: React.CSSProperties = {
		position: "absolute",
		top: "50%",
		height: RUN_LINE_PX,
		transform: "translateY(-50%)",
		pointerEvents: "none",
	};
	return (
		<>
			<button
				type="button"
				data-testid={`swimlane-run-line-${idPrefix}`}
				// Timeline's delegated hover handler reads the run to light
				// its sub-agent connectors, as for a glyph.
				data-session-id={sessionId}
				data-run-lane={line.lane}
				data-segment-index={segment.index}
				data-tail={line.quietX === null ? "live" : "quiet"}
				data-shared={shared ? "true" : undefined}
				data-highlighted={lit ? "true" : "false"}
				tabIndex={line.focusable ? 0 : -1}
				aria-label={`${runLabel(segment, line)}, ${lineEnd(segment)}`}
				onClick={onLineClick}
				onMouseEnter={onHoverEnter}
				onMouseLeave={onHoverLeave}
				onFocus={onHoverEnter}
				onBlur={onHoverLeave}
				className="focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent)"
				style={{
					position: "absolute",
					left: line.x1,
					width,
					top: markTop(line.lane, line.laneCount, RUN_LINE_HIT_PX),
					height: RUN_LINE_HIT_PX,
					padding: 0,
					background: "transparent",
					border: "none",
					cursor: "pointer",
					// Under the circles and glyphs (zIndex 2), so every mark
					// on the lane stays the pointer's target.
					zIndex: 1,
					pointerEvents: shared ? "none" : "auto",
					opacity: lit ? 1 : RUN_LINE_REST_OPACITY,
					transition: "opacity 120ms ease",
				}}
			>
				{solidWidth > 0 && (
					<span
						aria-hidden="true"
						data-testid="swimlane-run-solid-part"
						style={{ ...bar, left: 0, width: solidWidth, background: "var(--accent)" }}
					/>
				)}
				{width - solidWidth > 0 && (
					<span
						aria-hidden="true"
						data-testid="swimlane-run-quiet-tail"
						style={{
							...bar,
							left: solidWidth,
							width: width - solidWidth,
							background: `repeating-linear-gradient(90deg, var(--accent) 0 ${QUIET_DASH_PX}px, transparent ${QUIET_DASH_PX}px ${2 * QUIET_DASH_PX}px)`,
						}}
					/>
				)}
			</button>
			{tooltipPos && (
				<RunBracketTooltipPortal
					testId={`swimlane-run-line-tooltip-${idPrefix}`}
					tooltip={tooltipText(segment, session, line)}
					tooltipPos={tooltipPos}
				/>
			)}
		</>
	);
}

export const RunLine = memo(RunLineComponent);
