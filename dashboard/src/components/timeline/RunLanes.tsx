import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ScaleTime } from "d3-scale";
import type { AgentEvent, Session } from "@/lib/types";
import type { ClientType } from "@/lib/agent-identity";
import { eventsCache } from "@/hooks/useSessionEvents";
import { useEventsCacheEpoch } from "@/lib/events-cache-epoch";
import { truncateSessionId } from "@/lib/events";
import { formatTokens } from "@/lib/agents-format";
import { layoutRowLanes, runLanesInView, type RunLane } from "@/lib/swimlane-lanes";
import {
	RUN_LANE_CIRCLE_SIZE_PX,
	RUN_LANE_HEADING_HEIGHT_PX,
	RUN_LANE_ICON_SIZE_PX,
	RUN_LANE_MIN_HEIGHT_PX,
	chooseLaneModel,
	modelCallCounts,
} from "@/lib/run-lane-layout";
import { useLaneViewport, type LaneViewport } from "@/lib/lane-viewport";
import { useRunLit, useRunLitEvent, type RunLink } from "@/lib/run-link";
import { isKeyboardFocus } from "@/lib/keyboard-focus";
import {
	AgentLabelStrip,
	AggregatedSessionEvents,
	CHILD_LABEL_BACKGROUND,
	CHILD_ROW_LABEL_PADDING_PX,
	ROW_LABEL_PADDING_PX,
	segmentsFor,
} from "./SwimLane";
import { RunBracket, RunLine } from "./RunBracket";
import { AgentStatusBadge } from "./AgentStatusBadge";

// The per-agent swimlane modal draws an agent's row as run lanes: a
// heading with the row's label strip, then one lane per run in the
// window, each with its own label (run id, state, model, tokens) and
// its own panel (run line, glyphs, larger circles, marker text). The
// Fleet view keeps its compact 48 px row (SwimLane).

/** How far a lane's label sits right of its heading's text, so each
 *  run reads as belonging to the agent above it. */
const RUN_LANE_LABEL_OFFSET_PX = 12;

/** Space between the lane label's two lines. */
const LANE_LABEL_LINE_GAP_PX = 3;

/** A lit lane (its run hovered here or in the Live feed): an accent
 *  tint over the lane's own background, a little lighter than the
 *  feed's lit rows as it spans a far larger area. */
const LIT_LANE_TINT_LAYER =
	"linear-gradient(color-mix(in srgb, var(--accent) 10%, transparent), color-mix(in srgb, var(--accent) 10%, transparent))";

/** The label of the lane the Live feed is filtered to: an accent bar at
 *  its left edge, the pressed state of its button. */
const FILTERED_LABEL_BAR = "inset 3px 0 0 var(--accent)";

/** The label of a lit lane: the 2 px accent bar a lit Live feed row
 *  draws, so the lane and its rows read as one. */
const LIT_LABEL_BAR = "inset 2px 0 0 var(--accent)";

/** What a lane label's button does, for its tooltip and description. */
const LANE_FILTER_ACTION = "Show only this run in the Live feed";

export interface RunLanesProps {
	flavor: string;
	agentName?: string;
	clientType?: ClientType;
	telemetry?: string;
	agentType?: string;
	sessions: Session[];
	scale: ScaleTime<number, number>;
	onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
	timelineWidth: number;
	leftPanelWidth: number;
	activeFilter?: string | null;
	sessionVersions?: Record<string, number>;
	matchingSessionIds?: Set<string> | null;
	onScrollToAgent?: (agentId: string) => void;
	topology?: "root" | "child";
	/** Each lane's height, which Timeline sizes to the space it has. */
	laneHeight: number;
	/** The scroll viewport's width and horizontal scroll: the heading
	 *  spans the visible row, and marker text keeps to the part of each
	 *  panel it shows. Read here, so a sideways scroll re-renders the
	 *  lanes alone. */
	laneViewport?: LaneViewport;
	/** "Now" in panel coordinates: marker text never runs past it. */
	nowX: number;
	/** The modal's run link: a lane lights while its run is hovered here
	 *  or in the Live feed, and hovering a lane lights its feed rows. */
	runLink?: RunLink;
	/** The run the Live feed is filtered to: its label is pressed. */
	runFilter?: string | null;
	/** A lane label's click: filter the feed to that run (or clear it). */
	onRunFilter?: (sessionId: string) => void;
}

function RunLanesComponent({
	flavor,
	agentName,
	clientType,
	telemetry,
	agentType,
	sessions,
	scale,
	onSessionClick,
	timelineWidth,
	leftPanelWidth,
	activeFilter,
	sessionVersions,
	matchingSessionIds = null,
	onScrollToAgent,
	topology = "root",
	laneHeight,
	laneViewport,
	nowX,
	runLink,
	runFilter = null,
	onRunFilter,
}: RunLanesProps) {
	// One lane per run with a segment in the window, by run start. The
	// cache epoch catches a run's history landing, which can move its
	// segment boundaries.
	const cacheEpoch = useEventsCacheEpoch();
	const [domainStart, domainEnd] = scale.domain();
	const d0 = domainStart?.getTime() ?? 0;
	const d1 = domainEnd?.getTime() ?? 0;
	const lanes = useMemo(
		() =>
			runLanesInView(
				sessions.map((s) => ({
					sessionId: s.session_id,
					segments: segmentsFor(s, eventsCache.get(s.session_id)),
				})),
				d0,
				d1,
			),
		// ``cacheEpoch`` stands for the eventsCache reads.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[sessions, cacheEpoch, d0, d1],
	);
	const sessionById = useMemo(
		() => new Map(sessions.map((s) => [s.session_id, s])),
		[sessions],
	);
	// The heading's text starts at the label padding; the lanes' labels
	// sit a step further in.
	const indent =
		(topology === "child" ? CHILD_ROW_LABEL_PADDING_PX : ROW_LABEL_PADDING_PX) +
		RUN_LANE_LABEL_OFFSET_PX;
	const rowWidth = leftPanelWidth + timelineWidth;
	// The heading spans the visible row; marker text keeps to the part of
	// each panel the viewport shows: from the sticky label column's edge,
	// ``scrollLeft`` into the row, to the viewport's right edge, and never
	// past "now".
	const view = useLaneViewport(laneViewport);
	const headingWidth = view ? Math.min(view.width, rowWidth) : rowWidth;
	const textLeft = view?.scrollLeft ?? 0;
	const textRight = view ? Math.min(view.scrollLeft + view.width - leftPanelWidth, nowX) : nowX;
	const markerTextRange = useMemo(() => ({ left: textLeft, right: textRight }), [textLeft, textRight]);

	return (
		<div
			data-agent-id={flavor}
			data-topology={topology}
			data-run-lanes="true"
			data-lane-count={lanes.length}
			data-testid={`swimlane-agent-row-${agentName ?? flavor}`}
			className="flex w-full flex-col border-b"
			style={{ borderColor: "var(--border-subtle)" }}
		>
			<div
				data-testid="swimlane-run-lanes-heading"
				className="flex w-full items-stretch"
				style={{
					height: RUN_LANE_HEADING_HEIGHT_PX,
					// A root label strip inherits the row's opaque
					// ``--surface`` through here; a child's paints its own.
					background: topology === "root" ? "inherit" : undefined,
				}}
			>
				{/* The heading spans the visible row, its status badge
				    right after the pills, so the agent's name is not
				    cut at the label column while the rest of the row is
				    empty. */}
				<AgentLabelStrip
					flavor={flavor}
					agentName={agentName}
					clientType={clientType}
					telemetry={telemetry}
					agentType={agentType}
					sessions={sessions}
					leftPanelWidth={leftPanelWidth}
					onScrollToAgent={onScrollToAgent}
					topology={topology}
					width={headingWidth}
					inlineBadge
				/>
				<div style={{ width: Math.max(0, rowWidth - headingWidth), flexShrink: 0 }} />
			</div>
			{lanes.length === 0 ? (
				<div
					data-testid="swimlane-run-lanes-empty"
					className="flex w-full items-stretch"
					style={{
						height: RUN_LANE_MIN_HEIGHT_PX,
						borderTop: "1px solid var(--border-subtle)",
						background: topology === "root" ? "inherit" : undefined,
					}}
				>
					<div
						className="flex h-full items-center font-mono text-[11px]"
						style={{
							...laneLabelBox(leftPanelWidth, topology, indent),
							color: "var(--text-muted)",
						}}
					>
						No runs in this window
					</div>
					<div style={{ width: timelineWidth, flexShrink: 0 }} />
				</div>
			) : (
				lanes.map((lane, index) => {
					const session = sessionById.get(lane.sessionId);
					return session ? (
						<RunLaneRow
							key={lane.sessionId}
							lane={lane}
							index={index}
							session={session}
							scale={scale}
							d0={d0}
							d1={d1}
							flavor={flavor}
							onSessionClick={onSessionClick}
							timelineWidth={timelineWidth}
							leftPanelWidth={leftPanelWidth}
							activeFilter={activeFilter}
							version={sessionVersions?.[lane.sessionId] ?? 0}
							matchingSessionIds={matchingSessionIds}
							topology={topology}
							indent={indent}
							height={laneHeight}
							markerTextRange={markerTextRange}
							cacheEpoch={cacheEpoch}
							runLink={runLink}
							filtered={runFilter === lane.sessionId}
							onRunFilter={onRunFilter}
						/>
					) : null;
				})
			)}
		</div>
	);
}

/** The sticky label cell of a lane: the label column's width, pinned at
 *  the left edge, opaque so circles scrolled under it stay hidden. */
function laneLabelBox(
	leftPanelWidth: number,
	topology: "root" | "child",
	indent: number,
): React.CSSProperties {
	return {
		width: leftPanelWidth,
		flexShrink: 0,
		position: "sticky",
		left: 0,
		zIndex: 3,
		overflow: "hidden",
		// A root lane inherits the row's opaque ``--surface``; a child's
		// tint is translucent, so its label paints the same look opaquely,
		// as a child row's label does.
		background: topology === "child" ? CHILD_LABEL_BACKGROUND : "inherit",
		borderRight: "1px solid var(--border)",
		paddingLeft: indent,
		paddingRight: ROW_LABEL_PADDING_PX,
	};
}

function RunLaneRow({
	lane,
	index,
	session,
	scale,
	d0,
	d1,
	flavor,
	onSessionClick,
	timelineWidth,
	leftPanelWidth,
	activeFilter,
	version,
	matchingSessionIds,
	topology,
	indent,
	height,
	markerTextRange,
	cacheEpoch,
	runLink,
	filtered,
	onRunFilter,
}: {
	lane: RunLane;
	index: number;
	session: Session;
	scale: ScaleTime<number, number>;
	d0: number;
	d1: number;
	flavor: string;
	onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
	timelineWidth: number;
	leftPanelWidth: number;
	activeFilter?: string | null;
	version: number;
	matchingSessionIds: Set<string> | null;
	topology: "root" | "child";
	indent: number;
	height: number;
	markerTextRange: { left: number; right: number };
	/** The events cache's write count, which the run's model reads. */
	cacheEpoch: number;
	runLink?: RunLink;
	/** The Live feed is filtered to this run. */
	filtered: boolean;
	onRunFilter?: (sessionId: string) => void;
}) {
	// The run's own glyphs and line, laid out as a one-lane row that
	// draws its line, then centred on the lane.
	const layout = useMemo(
		() =>
			layoutRowLanes({
				segments: lane.segments,
				d0,
				d1,
				toX: (ms) => scale(new Date(ms)),
				visibleLeft: 0,
				visibleRight: timelineWidth,
				drawLines: true,
			}),
		// ``scale`` is a function of d0, d1 and timelineWidth.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[lane, d0, d1, timelineWidth],
	);
	const onGlyphClick = useCallback(
		(sessionId: string) => onSessionClick(sessionId),
		[onSessionClick],
	);
	// Any mark of the lane under the pointer or keyboard focus lights
	// the run's line, as on a split Fleet row.
	const [pointerLit, setPointerLit] = useState(false);
	const [focusLit, setFocusLit] = useState(false);
	const onMarkOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
		const mark = (e.target as HTMLElement).closest?.("[data-session-id]") ?? null;
		const onMark = mark !== null && e.currentTarget.contains(mark);
		setPointerLit((prev) => (prev === onMark ? prev : onMark));
	}, []);
	const id8 = truncateSessionId(session.session_id);
	// The model the lane names (and leaves out of its marker text): most
	// of the run's calls in the window on the lane's first render, then
	// held until another model leads by ``LANE_MODEL_SWITCH_LEAD`` calls
	// (``chooseLaneModel``). The lane holds it in its own state, keyed by
	// the run (the lane's React key), so only this lane re-renders when
	// it changes.
	const sessionId = session.session_id;
	const sessionModel = session.model ?? null;
	const counts = useMemo(
		() => modelCallCounts(eventsCache.get(sessionId), d0, d1),
		// ``cacheEpoch`` stands for the eventsCache read.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[sessionId, d0, d1, cacheEpoch],
	);
	const [heldModel, setHeldModel] = useState<string | null>(null);
	const model = chooseLaneModel(heldModel, counts, sessionModel);
	// Adjusted during render: the next render holds the model chosen now.
	if (model !== heldModel) setHeldModel(model);

	// Lit while its run is hovered here or in the Live feed, with the
	// hovered feed row's circle ringed; each re-renders this lane only
	// when it changes.
	const lit = useRunLit(runLink, sessionId);
	const linkedEventId = useRunLitEvent(runLink, sessionId);
	// The pointer in the lane, or the keyboard focus on its label, lights
	// the run. Either leaving puts it out unless the other holds it, or
	// another run took the light meanwhile (a feed row under the pointer).
	const pointerIn = useRef(false);
	const focusIn = useRef(false);
	const holdLight = (which: { current: boolean }, held: boolean) => {
		if (!runLink) return;
		which.current = held;
		if (held) runLink.set(sessionId);
		else if (!pointerIn.current && !focusIn.current && runLink.get().run === sessionId) runLink.set(null);
	};
	// A lane that leaves (its run out of the window) under the pointer
	// gets no leave event: it puts its light out as it goes.
	useEffect(
		() => () => {
			if ((pointerIn.current || focusIn.current) && runLink?.get().run === sessionId) runLink.set(null);
		},
		[runLink, sessionId],
	);
	const describedBy = useId();
	const rowBackground =
		topology === "root"
			? lit
				? `${LIT_LANE_TINT_LAYER}, var(--surface)`
				: "inherit"
			: lit
				? LIT_LANE_TINT_LAYER
				: undefined;
	const labelBox = laneLabelBox(leftPanelWidth, topology, indent);
	const labelStyle: React.CSSProperties = {
		...labelBox,
		background:
			topology === "child" && lit ? `${LIT_LANE_TINT_LAYER}, ${CHILD_LABEL_BACKGROUND}` : labelBox.background,
		gap: LANE_LABEL_LINE_GAP_PX,
		boxShadow: filtered ? FILTERED_LABEL_BAR : lit ? LIT_LABEL_BAR : undefined,
	};
	const labelContent = (
		<>
			<div className="flex min-w-0 items-center gap-2">
				<span
					data-testid="swimlane-run-lane-id"
					className="shrink-0 font-mono text-[11px] font-semibold"
					style={{ color: "var(--text)" }}
				>
					{id8}
				</span>
				<span id={`${describedBy}-state`} className="inline-flex">
					<AgentStatusBadge state={session.state} align="inline" testId="swimlane-run-lane-status" />
				</span>
			</div>
			<div
				id={`${describedBy}-details`}
				className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]"
				style={{ color: "var(--text-secondary)" }}
			>
				<span
					data-testid="swimlane-run-lane-model"
					title={model ?? undefined}
					style={{
						flex: "0 1 auto",
						minWidth: 0,
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
					}}
				>
					{model ?? "—"}
				</span>
				<span aria-hidden="true" className="shrink-0" style={{ color: "var(--text-muted)" }}>
					·
				</span>
				<span data-testid="swimlane-run-lane-tokens" className="shrink-0 whitespace-nowrap">
					{formatTokens(session.tokens_used ?? 0)} tokens
				</span>
			</div>
		</>
	);

	return (
		<div
			data-testid={`swimlane-run-lane-${id8}`}
			data-run-lane-row="true"
			// Not ``data-session-id``: that names a mark (circle, glyph,
			// line), and Timeline's hover lights the connectors of the
			// run whose mark is under the pointer, not of a lane's empty
			// space.
			data-run-id={session.session_id}
			data-lane-index={index}
			data-linked={lit ? "true" : undefined}
			onMouseEnter={runLink ? () => holdLight(pointerIn, true) : undefined}
			onMouseLeave={runLink ? () => holdLight(pointerIn, false) : undefined}
			className="flex w-full items-stretch"
			style={{
				height,
				borderTop: "1px solid var(--border-subtle)",
				background: rowBackground,
			}}
		>
			{/* A button that filters the Live feed to this run: pressed
			    while the feed is filtered to it, and a click again clears
			    it. Hover and keyboard focus light the run's feed rows. It
			    is named by the run, as its label shows it; its state, model
			    and tokens, and what it does, are its description. */}
			{onRunFilter ? (
				<button
					type="button"
					data-testid="swimlane-run-lane-label"
					aria-pressed={filtered}
					aria-label={`Run ${id8}`}
					aria-describedby={`${describedBy}-state ${describedBy}-details ${describedBy}-action`}
					title={LANE_FILTER_ACTION}
					onClick={() => onRunFilter(sessionId)}
					// Keyboard focus lights the run; a click's focus does not,
					// so the light goes with the pointer.
					onFocus={(e) => {
						if (isKeyboardFocus(e.currentTarget)) holdLight(focusIn, true);
					}}
					onBlur={() => holdLight(focusIn, false)}
					className="flex h-full cursor-pointer flex-col justify-center border-0 text-left focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
					style={{ ...labelStyle, font: "inherit", color: "inherit" }}
				>
					{labelContent}
					<span id={`${describedBy}-action`} className="sr-only">
						{LANE_FILTER_ACTION}
					</span>
				</button>
			) : (
				<div
					data-testid="swimlane-run-lane-label"
					className="flex h-full flex-col justify-center"
					style={labelStyle}
				>
					{labelContent}
				</div>
			)}
			<div
				className="relative h-full"
				data-testid="swimlane-timeline-panel"
				style={{ width: timelineWidth, flexShrink: 0, overflow: "hidden" }}
			>
				<div
					data-testid="swimlane-timeline-inset"
					onMouseOver={onMarkOver}
					onMouseLeave={() => setPointerLit(false)}
					onFocus={() => setFocusLit(true)}
					onBlur={() => setFocusLit(false)}
					style={{ position: "absolute", inset: 0 }}
				>
					<AggregatedSessionEvents
						session={session}
						scale={scale}
						onSessionClick={onSessionClick}
						flavor={flavor}
						activeFilter={activeFilter}
						version={version}
						matchingSessionIds={matchingSessionIds}
						size={RUN_LANE_CIRCLE_SIZE_PX}
						iconSize={RUN_LANE_ICON_SIZE_PX}
						markerTextRange={markerTextRange}
						laneHeight={height}
						runModel={model}
						linkedEventId={linkedEventId}
					/>
					{layout.lines.map((line) => (
						<RunLine
							key={line.key}
							line={line}
							session={session}
							highlighted={pointerLit || focusLit}
							onClick={onGlyphClick}
							centred
						/>
					))}
					{layout.glyphs.map((glyph) => (
						<RunBracket
							key={glyph.key}
							glyph={glyph}
							session={session}
							onClick={onGlyphClick}
							centred
						/>
					))}
				</div>
			</div>
		</div>
	);
}

/** Re-render when a prop changes, except a scale whose domain moved by
 *  less than a second (the Timeline floors its domain to whole seconds,
 *  as SwimLane's comparator assumes). */
export const RunLanes = memo(RunLanesComponent, (prev, next) => {
	const keys: (keyof RunLanesProps)[] = [
		"flavor",
		"agentName",
		"clientType",
		"telemetry",
		"agentType",
		"sessions",
		"onSessionClick",
		"timelineWidth",
		"leftPanelWidth",
		"activeFilter",
		"sessionVersions",
		"matchingSessionIds",
		"onScrollToAgent",
		"topology",
		"laneHeight",
		"laneViewport",
		"nowX",
		"runLink",
		"runFilter",
		"onRunFilter",
	];
	for (const key of keys) if (prev[key] !== next[key]) return false;
	const [ps, pe] = prev.scale.domain();
	const [ns, ne] = next.scale.domain();
	if (!ps || !pe || !ns || !ne) return false;
	return Math.abs(ns.getTime() - ps.getTime()) < 1000 && Math.abs(ne.getTime() - pe.getTime()) < 1000;
});
