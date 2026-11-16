import { memo, useCallback, useMemo, useState } from "react";
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
} from "@/lib/run-lane-layout";
import {
	AgentLabelStrip,
	AggregatedSessionEvents,
	CHILD_LABEL_BACKGROUND,
	segmentsFor,
} from "./SwimLane";
import { RunBracket, RunLine } from "./RunBracket";
import { AgentStatusBadge } from "./AgentStatusBadge";

// The per-agent swimlane modal draws an agent's row as run lanes: a
// heading with the row's label strip, then one lane per run in the
// window, each with its own label (run id, state, model, tokens) and
// its own panel (run line, glyphs, larger circles, marker text). The
// Fleet view keeps its compact 48 px row (SwimLane).

/** How far a lane's label sits right of the heading's text (its 12 px
 *  padding plus 12), so each run reads as belonging to the agent above. */
const RUN_LANE_LABEL_INDENT_PX = 24;

/** The extra indent of a sub-agent's lanes, as a child row's label is
 *  indented under its parent's. */
const CHILD_INDENT_PX = 28;

/** Space between the lane label's two lines. */
const LANE_LABEL_LINE_GAP_PX = 3;

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
	const indent = RUN_LANE_LABEL_INDENT_PX + (topology === "child" ? CHILD_INDENT_PX : 0);

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
				/>
				<div style={{ width: timelineWidth, flexShrink: 0 }} />
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
		paddingRight: 12,
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
	const model = session.model ?? null;

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
			className="flex w-full items-stretch"
			style={{
				height,
				borderTop: "1px solid var(--border-subtle)",
				background: topology === "root" ? "inherit" : undefined,
			}}
		>
			<div
				data-testid="swimlane-run-lane-label"
				className="flex h-full flex-col justify-center"
				style={{ ...laneLabelBox(leftPanelWidth, topology, indent), gap: LANE_LABEL_LINE_GAP_PX }}
			>
				<div className="flex min-w-0 items-center gap-2">
					<span
						data-testid="swimlane-run-lane-id"
						className="shrink-0 font-mono text-[11px] font-semibold"
						style={{ color: "var(--text)" }}
					>
						{id8}
					</span>
					<AgentStatusBadge
						state={session.state}
						align="inline"
						testId="swimlane-run-lane-status"
					/>
				</div>
				<div
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
			</div>
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
						markerTextRight={timelineWidth}
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
	];
	for (const key of keys) if (prev[key] !== next[key]) return false;
	const [ps, pe] = prev.scale.domain();
	const [ns, ne] = next.scale.domain();
	if (!ps || !pe || !ns || !ne) return false;
	return Math.abs(ns.getTime() - ps.getTime()) < 1000 && Math.abs(ne.getTime() - pe.getTime()) < 1000;
});
