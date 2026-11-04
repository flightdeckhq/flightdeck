import { memo, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@/lib/types";
import {
	END_GLYPH_SIZE_PX,
	START_GLYPH_SIZE_PX,
	type RowGlyph,
} from "@/lib/swimlane-lanes";

// RunBracket draws one run glyph that SwimLane placed with
// ``layoutRowGlyphs`` (lib/swimlane-lanes.ts):
//
//   * ``"start"``: a filled triangle (▶) whose flat base sits just
//     inside a segment's start, pointing into the segment.
//   * ``"end"``: a square whose right edge sits just inside a segment's
//     end. Filled for a closed segment; hollow with a ``--status-lost``
//     stroke for a lost one (a lost run, or one the orphan-timeout
//     reaper closed, ends at its last signal). An open segment has no
//     end glyph, so a missing square reads as "still running".
//
// The glyph sits on the row's top or bottom edge, at the left edge the
// layout packed it to. Hover or focus shows the run's tooltip; a click
// hands the run's id to ``onClick``.

interface RunBracketProps {
	glyph: RowGlyph;
	/** The run the glyph marks: its state and tokens fill the tooltip. */
	session: Session;
	onClick: (sessionId: string) => void;
}

// Vertical inset from the row edge so the glyph clears the row
// border. Same value start + end so the pair sits on a shared
// baseline.
const VERTICAL_MARGIN = 2;
// A lost segment's hollow square: the stroke width, and the inset that
// keeps the whole stroke inside the glyph's box.
const LOST_STROKE_PX = 1.5;
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
function endLabel(glyph: RowGlyph): string {
	const { segment } = glyph;
	if (segment.endKind === "open") return "running";
	if (segment.endKind === "lost") return `lost · last seen ${formatRunTime(segment.endMs)}`;
	return formatRunTime(segment.endMs);
}

/** The glyph's accessible name: the run, the glyph and its time. */
function ariaLabel(glyph: RowGlyph, idPrefix: string): string {
	const { segment } = glyph;
	const part = segment.count > 1 ? `, segment ${segment.index + 1} of ${segment.count}` : "";
	if (glyph.kind === "start") {
		return `Open run ${idPrefix}${part}, start ${formatRunTime(segment.startMs)}`;
	}
	if (segment.endKind === "lost") {
		return `Open run ${idPrefix}${part}, lost, last seen ${formatRunTime(segment.endMs)}`;
	}
	return `Open run ${idPrefix}${part}, end ${formatRunTime(segment.endMs)}`;
}

function RunBracketComponent({ glyph, session, onClick }: RunBracketProps) {
	const { segment, kind } = glyph;
	const sessionId = segment.sessionId;
	const idPrefix = sessionId.slice(0, 8);
	const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
	const onMarkClick = useCallback(() => onClick(sessionId), [onClick, sessionId]);
	const onHoverEnter = useCallback(
		(e: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>) => {
			// Anchor the tooltip to the button's viewport rect so
			// ``position: fixed`` takes it out of the timeline-panel's
			// ``overflow: hidden`` clip — the tooltip is taller than the
			// 48-px row, so an absolutely-positioned child of the panel
			// gets clipped at the top or the bottom whatever its edge.
			// The fixed-coordinate approach mirrors how ``EventNode``
			// positions its own tooltip and is the only way to render
			// off-clip.
			const rect = e.currentTarget.getBoundingClientRect();
			setTooltipPos({
				left: rect.right + TOOLTIP_OFFSET,
				top: rect.top + rect.height / 2,
			});
		},
		[],
	);
	const onHoverLeave = useCallback(() => setTooltipPos(null), []);
	// Note: the tooltip's left/top coordinates are snapshotted from
	// the button's viewport rect at hover time and are NOT refreshed
	// if the user scrolls or resizes the window while hovering. The
	// pointer must stay on the button to keep the tooltip visible,
	// so any active scroll already moves the operator off-button
	// and ``onMouseLeave`` fires. ``EventNode`` has the same
	// no-listener behaviour for the same reason.

	const size = kind === "start" ? START_GLYPH_SIZE_PX : END_GLYPH_SIZE_PX;
	const lost = kind === "end" && segment.endKind === "lost";
	const tokens = session.tokens_used ?? 0;
	const lines = [
		`run ${idPrefix}`,
		`start: ${formatRunTime(segment.startMs)}`,
		`end:   ${endLabel(glyph)}`,
		`state: ${session.state}`,
		`tokens: ${tokens.toLocaleString()}`,
	];
	if (segment.count > 1) lines.push(`segment ${segment.index + 1} of ${segment.count}`);

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
				aria-label={ariaLabel(glyph, idPrefix)}
				onClick={onMarkClick}
				onMouseEnter={onHoverEnter}
				onMouseLeave={onHoverLeave}
				onFocus={onHoverEnter}
				onBlur={onHoverLeave}
				className="focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent)"
				style={{
					position: "absolute",
					left: glyph.left,
					top: glyph.lane === 0 ? VERTICAL_MARGIN : undefined,
					bottom: glyph.lane === 1 ? VERTICAL_MARGIN : undefined,
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
					sessionId={sessionId}
					tooltip={lines.join("\n")}
					tooltipPos={tooltipPos}
				/>
			)}
		</>
	);
}

function RunBracketTooltipPortal({
	sessionId,
	tooltip,
	tooltipPos,
}: {
	sessionId: string;
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
			data-testid={`swimlane-run-bracket-tooltip-${sessionId.slice(0, 8)}`}
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
