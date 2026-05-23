import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import type { ScaleTime } from "d3-scale";
import { ChevronRight } from "lucide-react";
import type { Session, AgentEvent } from "@/lib/types";
import { deriveRelationship } from "@/lib/relationship";
import { findLostSubAgent } from "@/lib/swimlane-lost-sub-agent";
import {
	ClientType,
	type ClientType as ClientTypeT,
} from "@/lib/agent-identity";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { SubAgentLostDot } from "@/components/facets/SubAgentRolePill";
import { RelationshipPill } from "@/components/facets/RelationshipPill";
import {
	ALL_ROW_HEIGHT_COLLAPSED,
	ALL_ROW_HEIGHT_EXPANDED,
	EVENT_CIRCLE_SIZE,
} from "@/lib/constants";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { OSIcon } from "@/components/ui/OSIcon";
import { OrchestrationIcon } from "@/components/ui/OrchestrationIcon";
import { EventNode } from "./EventNode";
import { RunBracket, bracketAnchors } from "./RunBracket";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { useSessionEvents, attachmentsCache } from "@/hooks/useSessionEvents";
import { isAttachmentStartEvent, isDiscoveryEvent, isEventVisible } from "@/lib/events";
import { useShowDiscoveryEvents } from "@/lib/discoveryEventsPref";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { useFleetStore } from "@/store/fleet";
import { getProvider, type Provider } from "@/lib/models";

// Per-agent state ordinal. Maximum across the agent's runs picks
// the badge state shown at the right edge of the label strip:
// active > idle > stale > closed > lost. Mirrors the server-side
// ordering in api/internal/store/agents.go.
const STATE_ORDINAL: Record<string, number> = {
	active: 5,
	idle: 4,
	stale: 3,
	closed: 2,
	lost: 1,
};

type AgentState = "active" | "idle" | "stale" | "closed" | "lost" | "";

// Sessions carry a free-form ``context: Record<string, unknown>``.
// The label-strip's OS / orchestration icons render only when the
// most-recent session reported a string for that key.
function readContextString(
	session: Session | null,
	key: string,
): string | null {
	if (!session?.context) return null;
	const v = session.context[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

interface SwimLaneProps {
	flavor: string;
	/** Human-readable label for the row. When absent (legacy data
	 *  without an agent name), falls back to rendering ``flavor``
	 *  directly. */
	agentName?: string;
	/** Client_type, surfaced as a small pill beside the label. */
	clientType?: ClientTypeT;
	/** Agent_type — coding / production — surfaced as a muted badge
	 *  next to the pill. */
	agentType?: string;
	sessions: Session[];
	scale: ScaleTime<number, number>;
	onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
	/**
	 * Width of the event-circles area in pixels. The full row width is
	 * leftPanelWidth + timelineWidth. The right (event circles) panel
	 * is sized exactly to this value so xScale.range = [0, timelineWidth]
	 * and circles cannot escape into adjacent layout space.
	 */
	timelineWidth: number;
	/**
	 * Current resizable width of the left label panel. Flows from
	 * Timeline.tsx's useState into every SwimLane so drag updates on
	 * the Flavors header row resize every row in lockstep.
	 */
	leftPanelWidth: number;
	activeFilter?: string | null;
	sessionVersions?: Record<string, number>;
	/**
	 * Set of session IDs that match the active CONTEXT sidebar filter.
	 * null = no filters active, every session is fully visible.
	 * Sessions not in the set render at opacity 0.15 with
	 * pointer-events: none.
	 */
	matchingSessionIds?: Set<string> | null;
	/**
	 * Invoked when the user clicks the always-on relationship pill
	 * (parent or child). The argument is the target agent_id; the
	 * caller scrolls that agent's swimlane row into view. Optional
	 * so legacy callers without sub-agent awareness still mount the
	 * component without a navigation handler.
	 */
	onScrollToAgent?: (agentId: string) => void;
	/**
	 * Row topology, drives the ``data-topology`` attribute on the row
	 * container. ``"child"`` activates the indent + bg-tint styling
	 * defined in globals.css via the ``[data-topology="child"]``
	 * selector. Defaults to ``"root"``.
	 */
	topology?: "root" | "child";
}

const ROW_HEIGHT = 48;

// Visual breathing-room buffer between the label strip's right
// edge (where the AgentStatusBadge sits via ``ml-auto``) and the
// leftmost event circles / run brackets in the timeline panel.
// Without this buffer, circles render flush against the badge
// boundary and read as "overlapping" the badge — particularly
// when the label strip's content is wide enough that the badge
// itself sits at the very right edge of its container. The
// buffer is applied to the timeline-panel's inner positioned
// wrapper rather than to xScale.range so the grid line overlay
// (rendered by Timeline.tsx, not this component) stays aligned
// with absolute time positions.
const TIMELINE_LEFT_BUFFER_PX = 8;

function SwimLaneComponent({
	flavor,
	agentName,
	clientType,
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
}: SwimLaneProps) {
	// Derive the always-on relationship pill from the same session-
	// linkage scan used elsewhere, so the swimlane stays in lock-step.
	// ``flavor`` is the agent_id (the swimlane row keys by agent).
	const fleetFlavors = useFleetStore((s) => s.flavors);
	const relationship = useMemo(() => {
		return deriveRelationship(flavor, sessions, fleetFlavors);
	}, [flavor, sessions, fleetFlavors]);

	// Surfaces a sub-agent whose latest run ended in ``lost`` state
	// as a red dot on the row label. See findLostSubAgent for the
	// recency rule; the unit tests for that helper live in
	// tests/unit/SwimLane-lost-dot-recency.test.ts.
	const lostSubAgent = useMemo(() => findLostSubAgent(sessions), [sessions]);

	// Per-agent rolled-up state: max ordinal across all runs.
	// Drives AgentStatusBadge at the right edge of the label strip.
	const agentState: AgentState = useMemo(() => {
		let bestState: AgentState = "";
		let bestOrd = 0;
		for (const s of sessions) {
			const ord = STATE_ORDINAL[s.state] ?? 0;
			if (ord > bestOrd) {
				bestOrd = ord;
				bestState = s.state as AgentState;
			}
		}
		return bestState;
	}, [sessions]);

	// Most-recent session for the agent — drives the provider / OS /
	// orchestration icons in the label strip. Per-event provider
	// logos on the event circles below carry the granular per-call
	// attribution; the label-strip icon answers "what does this
	// agent look like right now."
	const mostRecentSession = useMemo<Session | null>(() => {
		if (sessions.length === 0) return null;
		let best: Session | null = null;
		let bestMs = -Infinity;
		for (const s of sessions) {
			const ms = new Date(s.started_at).getTime();
			if (ms > bestMs) {
				bestMs = ms;
				best = s;
			}
		}
		return best;
	}, [sessions]);

	const providerName = useMemo<Provider | null>(() => {
		const model = mostRecentSession?.model ?? null;
		if (!model) return null;
		const p = getProvider(model);
		return p === "other" ? null : p;
	}, [mostRecentSession]);

	const osName = readContextString(mostRecentSession, "os");
	const orchestration = readContextString(mostRecentSession, "orchestration");

	// Anchor staggering for concurrent runs of the same agent
	// (multi-pod K8s with collapsed FLIGHTDECK_HOSTNAME, etc.).
	// First run on the row's top edge, second + on the bottom.
	const bracketAnchorMap = useMemo(() => bracketAnchors(sessions), [sessions]);

	return (
		<div
			data-agent-id={flavor}
			data-topology={topology}
			data-testid={`swimlane-agent-row-${agentName ?? flavor}`}
			className="flex w-full items-stretch border-b"
			style={{
				borderColor: "var(--border-subtle)",
				height: ROW_HEIGHT,
				// Background lives in the CSS rules for
				// ``[data-topology="root"]`` and
				// ``[data-topology="child"]`` so the child-row tint
				// can override the root surface colour. An inline
				// ``background: var(--surface)`` here would beat the
				// data-attribute selector by specificity and the
				// child rows would render the same colour as root.
			}}
		>
			{/* Left panel — sticky so it stays pinned during horizontal
			    scroll. Width tracks the resizable leftPanelWidth state
			    owned by Timeline.tsx. The ``swimlane-row-label`` class
			    is the indent target for ``[data-topology="child"]`` rows;
			    the CSS rule lives in globals.css so the same class works
			    for swimlane + Events page sub-rows. */}
			<div
				className="swimlane-row-label flex h-full items-center gap-2 px-3"
				style={{
					width: leftPanelWidth,
					flexShrink: 0,
					// Background lives on the row container via the
					// ``[data-topology="..."]`` CSS rules; pulling the
					// surface colour through ``inherit`` keeps the
					// sticky panel matching the row tint (otherwise
					// the panel pin-fights with the row's child tint
					// and a thin seam of var(--surface) shows under
					// horizontal scroll).
					background: "inherit",
					borderRight: "1px solid var(--border)",
					position: "sticky",
					left: 0,
					zIndex: 3,
					overflow: "hidden",
				}}
			>
				{(clientType === ClientType.ClaudeCode || flavor === "claude-code") && (
					<ClaudeCodeLogo size={14} className="shrink-0" />
				)}
				{/* Agent name — primary label. The row's ``flavor``
				    prop carries the agent_id (the swimlane keys rows
				    by agent — see SwimLaneProps). Clicking it sets
				    the ``?agent_drawer=`` URL param, which the
				    app-level AgentDrawerHost reads to open this
				    agent's drawer inline — no route change, the
				    Fleet view stays mounted underneath.
				    Ellipsis-truncates at any width with an
				    always-on native ``title`` tooltip carrying the
				    full name, so a hover always reveals the
				    complete value — even when the text fits. The
				    ellipsis styles live on the link itself (not a
				    nested TruncatedText) because the user-facing
				    contract is "the link clips with an ellipsis";
				    keeping the styles on the named test-id element
				    makes the computed-style assertion in T92
				    point at the same element a designer would
				    inspect.

				    The ``minWidth: "3rem"`` floor (~6 chars + the
				    ellipsis glyph at 13 px) is the contract that
				    the name never collapses to zero. ``min-w-0``
				    on a flex item lets the browser shrink the
				    element below its content's intrinsic width;
				    without an explicit floor, the trailing
				    ``shrink-0`` pills + icons + status badge would
				    claim every available pixel and the name link
				    would collapse to 0 at the 200 px panel floor.
				    The 3-rem floor flips the precedence: as the
				    column narrows the trailing siblings clip
				    against the parent's ``overflow: hidden``
				    boundary BEFORE the name shrinks below
				    readability. Above ~125 px content width
				    (which all 460-default and 640-max layouts
				    are well above) the floor never engages, so
				    those verified layouts are unchanged. */}
				<Link
					to={{ search: `agent_drawer=${encodeURIComponent(flavor)}` }}
					data-testid="swimlane-agent-name-link"
					title={agentName ?? flavor}
					className="block text-[13px] font-medium"
					style={{
						color: "var(--text)",
						textDecoration: "none",
						flex: "0 1 auto",
						minWidth: "3rem",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{agentName ?? flavor}
				</Link>
				{clientType && (
					<ClientTypePill
						clientType={clientType}
						size="compact"
						testId="swimlane-client-type-pill"
					/>
				)}
				{agentType && (
					<span
						className="shrink-0 font-mono text-[10px] uppercase tracking-wide"
						style={{ color: "var(--text-muted)" }}
						data-testid="swimlane-agent-type-badge"
					>
						{agentType}
					</span>
				)}
				{providerName && (
					<ProviderLogo
						provider={providerName}
						size={14}
						className="shrink-0"
					/>
				)}
				{osName && <OSIcon os={osName} size={14} className="shrink-0" />}
				{orchestration && (
					<OrchestrationIcon
						orchestration={orchestration}
						size={14}
						className="shrink-0"
					/>
				)}
				{relationship.mode === "child" && (
					<RelationshipPill
						mode="child"
						parentName={relationship.parentName}
						testId="swimlane-relationship-pill"
						onClick={
							onScrollToAgent && relationship.parentAgentId
								? () => onScrollToAgent(relationship.parentAgentId!)
								: undefined
						}
					/>
				)}
				{relationship.mode === "parent" && relationship.childCount > 0 && (
					<RelationshipPill
						mode="parent"
						childCount={relationship.childCount}
						testId="swimlane-relationship-pill"
						onClick={
							onScrollToAgent && relationship.firstChildAgentId
								? () => onScrollToAgent(relationship.firstChildAgentId!)
								: undefined
						}
					/>
				)}
				{lostSubAgent && (
					<SubAgentLostDot
						role={lostSubAgent.role}
						sessionIdSuffix={lostSubAgent.sessionIdSuffix}
						testId="swimlane-sub-agent-lost-dot"
					/>
				)}
				{/* Badge is absolutely positioned at the label strip's
				    right edge so it always reads as a fully visible
				    anchor even when the strip's flex content (name
				    + pills + icons + topology pill) overflows the
				    strip width — the pre-fix in-flex ``ml-auto``
				    placement let a wide topology pill push the badge
				    past the strip's right edge, where
				    ``overflow: hidden`` either clipped it entirely
				    or left it crowded by the first event circle in
				    the timeline panel. The wrapper paints the
				    SAME bg colour the row container paints — keyed
				    directly off ``topology`` (NOT via
				    ``background: inherit``, which resolved to a
				    subtly-different shade on child rows and read
				    as a visible grey rectangle around the badge).
				    Full row-height ``inset: 0 0 0 auto`` so the
				    occluded area covers overflowing pills above
				    AND below the badge text vertically. */}
				<div
					data-testid="swimlane-badge-wrapper"
					style={{
						position: "absolute",
						top: 0,
						right: 0,
						bottom: 0,
						background:
							topology === "child"
								? "var(--swimlane-row-child-bg)"
								: "var(--surface)",
						paddingLeft: 12,
						paddingRight: 12,
						display: "flex",
						alignItems: "center",
						zIndex: 4,
					}}
				>
					<AgentStatusBadge state={agentState} />
				</div>
			</div>

			{/* Right panel — aggregated events + run boundary brackets.
			    Sized to exactly timelineWidth so xScale.range =
			    [0, timelineWidth] and circles cannot escape into
			    adjacent layout. overflow: hidden clips any visual that
			    would otherwise leak into the next row. */}
			<div
				className="relative h-full flex items-center px-1"
				data-testid="swimlane-timeline-panel"
				style={{
					width: timelineWidth,
					flexShrink: 0,
					overflow: "hidden",
				}}
			>
				{/* Inner positioned wrapper that shifts the entire
				    event-circles + run-brackets content right by
				    ``TIMELINE_LEFT_BUFFER_PX`` so circles and brackets
				    never crowd the label-strip / timeline-panel
				    boundary (which is where the AgentStatusBadge sits
				    via ``ml-auto`` at the label strip's right edge).
				    Absolute children inside this wrapper position via
				    ``left: x`` relative to its left edge, so the buffer
				    shifts the leftmost circle inward by 8 px. The
				    rightmost circles (events at NOW) shift right by the
				    same 8 px and are clipped by the panel's
				    ``overflow: hidden`` — acceptable since the now-pole
				    visual is rendered by Timeline.tsx's grid overlay,
				    not by this row. */}
				<div
					style={{
						position: "absolute",
						inset: `0 0 0 ${TIMELINE_LEFT_BUFFER_PX}px`,
					}}
				>
					<AggregatedSwimLane
						sessions={sessions}
						scale={scale}
						onSessionClick={onSessionClick}
						flavor={flavor}
						activeFilter={activeFilter}
						sessionVersions={sessionVersions}
						matchingSessionIds={matchingSessionIds}
					/>
					{/* Run boundary brackets overlay the aggregated event
					    circles. Each run renders one bracket pair (start +
					    end); concurrent runs stagger on top / bottom anchors
					    so they remain distinguishable. */}
					{sessions.map((s) => (
						<RunBracket
							key={`run-bracket-${s.session_id}`}
							session={s}
							scale={scale}
							// RunBracket's ``inWindow`` / ``endInWindow``
							// guards use ``timelineWidth`` to decide
							// which brackets to render. The buffer
							// wrapper above shifts every rendered child
							// 8 px right; a bracket at xStart ≈
							// timelineWidth would land 8 px past
							// panel.right and be clipped by
							// ``overflow: hidden`` — a wasted render.
							// Subtracting ``TIMELINE_LEFT_BUFFER_PX``
							// from the effective width tightens the
							// guards to match the wrapper's reduced
							// visible-rendering region.
							timelineWidth={timelineWidth - TIMELINE_LEFT_BUFFER_PX}
							anchor={bracketAnchorMap.get(s.session_id) ?? "top"}
							onClick={(sid) => onSessionClick(sid)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

export const SwimLane = memo(SwimLaneComponent, (prev, next) => {
	if (prev.flavor !== next.flavor) return false;
	if (prev.agentName !== next.agentName) return false;
	if (prev.clientType !== next.clientType) return false;
	if (prev.agentType !== next.agentType) return false;
	if (prev.topology !== next.topology) return false;
	if (prev.sessions !== next.sessions) return false;
	if (prev.activeFilter !== next.activeFilter) return false;
	if (prev.timelineWidth !== next.timelineWidth) return false;
	if (prev.leftPanelWidth !== next.leftPanelWidth) return false;
	if (prev.matchingSessionIds !== next.matchingSessionIds) return false;
	if (prev.sessionVersions !== next.sessionVersions) return false;
	if (prev.onSessionClick !== next.onSessionClick) return false;
	if (prev.onScrollToAgent !== next.onScrollToAgent) return false;
	// Shallow scale comparison: identical domain bounds reuse memo.
	const prevDomain = prev.scale.domain();
	const nextDomain = next.scale.domain();
	const prevStart = prevDomain[0];
	const prevEnd = prevDomain[1];
	const nextStart = nextDomain[0];
	const nextEnd = nextDomain[1];
	if (!prevStart || !prevEnd || !nextStart || !nextEnd) return false;
	const domainDeltaEnd = Math.abs(nextEnd.getTime() - prevEnd.getTime());
	const domainDeltaStart = Math.abs(nextStart.getTime() - prevStart.getTime());
	if (domainDeltaEnd < 1000 && domainDeltaStart < 1000) return true;
	return false;
});

/**
 * Aggregate "ALL" row that sits above the per-agent rows. Renders a
 * single collapsible lane whose event circles are merged from every
 * session across every agent, so operators get a fleet-wide view of
 * activity without scanning each row.
 *
 * Default state is collapsed — the row reduces to a thin toggle
 * bar (``ALL_ROW_HEIGHT_COLLAPSED``, matching the AGENTS section
 * header height directly below) carrying a chevron + "All"
 * label. Clicking the toggle expands the row to
 * ``ALL_ROW_HEIGHT_EXPANDED`` with the pulse-line of aggregated
 * event circles; the preference persists to localStorage via
 * ``persistAllRowCollapsed`` so the operator's choice survives
 * reloads. Once the ``/agents`` page exists as a dedicated
 * fleet-overview surface, the pulse line is redundant for most
 * operators — hiding it by default keeps the swimlane dense
 * without removing the affordance.
 *
 * Unlike SwimLane, this row:
 *   - has no label-strip pills, no status badge, no run brackets
 *   - is shorter than a per-agent row (expanded =
 *     ``ALL_ROW_HEIGHT_EXPANDED``; collapsed =
 *     ``ALL_ROW_HEIGHT_COLLAPSED``) to signal "summary, not an
 *     agent"
 *   - is NOT affected by the CONTEXT sidebar filter (always shows
 *     everything — it's a fleet-wide overview)
 *   - DOES respect the event-type filter bar, like SwimLane does,
 *     because dimming filtered event types is a per-circle concern
 *     handled inside EventNode via ``isVisible``
 */
interface AllSwimLaneProps {
	flavors: { flavor: string; sessions: Session[] }[];
	scale: ScaleTime<number, number>;
	onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
	timelineWidth: number;
	leftPanelWidth: number;
	activeFilter?: string | null;
	sessionVersions?: Record<string, number>;
	/**
	 * Whether the ALL row is in collapsed (toggle-bar-only) mode.
	 * Owned by Timeline.tsx via ``useAllRowCollapsed`` so the
	 * preference is shared with any future second consumer through
	 * localStorage + a same-tab CustomEvent. Default is collapsed.
	 */
	collapsed: boolean;
	/**
	 * Fires when the operator clicks the toggle button. Timeline.tsx
	 * persists the negated value via ``persistAllRowCollapsed``;
	 * this prop intentionally takes no argument so the consumer
	 * decides the next state (and persists it) in one place.
	 */
	onToggle: () => void;
}

function AllSwimLaneComponent({
	flavors,
	scale,
	onSessionClick,
	timelineWidth,
	leftPanelWidth,
	activeFilter,
	sessionVersions,
	collapsed,
	onToggle,
}: AllSwimLaneProps) {
	const rowHeight = collapsed
		? ALL_ROW_HEIGHT_COLLAPSED
		: ALL_ROW_HEIGHT_EXPANDED;
	return (
		<div
			data-testid="swimlane-all"
			data-collapsed={collapsed ? "true" : "false"}
			style={{
				display: "flex",
				alignItems: "center",
				height: rowHeight,
				borderBottom: "1px solid var(--border-subtle)",
				background: "var(--bg)",
			}}
		>
			<div
				style={{
					width: leftPanelWidth,
					flexShrink: 0,
					height: "100%",
					background: "var(--surface)",
					borderRight: "1px solid var(--border)",
					position: "sticky",
					left: 0,
					zIndex: 3,
					display: "flex",
					alignItems: "center",
					paddingLeft: 8,
				}}
			>
				<button
					type="button"
					data-testid="swimlane-all-toggle"
					aria-expanded={!collapsed}
					aria-label={collapsed ? "Expand ALL row" : "Collapse ALL row"}
					onClick={onToggle}
					className="flex h-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
					style={{
						color: "var(--text-muted)",
						fontFamily: "var(--font-ui)",
					}}
				>
					<ChevronRight
						size={12}
						aria-hidden="true"
						style={{
							transition: "transform 0.15s",
							transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
						}}
					/>
					<span
						data-testid="swimlane-all-label"
						style={{
							fontSize: 10,
							fontWeight: 700,
							letterSpacing: "0.08em",
							textTransform: "uppercase",
						}}
					>
						All
					</span>
				</button>
			</div>
			{!collapsed && (
				<div
					data-testid="swimlane-all-pulse"
					className="relative flex items-center px-1"
					style={{
						width: timelineWidth,
						flexShrink: 0,
						height: "100%",
						overflow: "hidden",
					}}
				>
					{flavors.flatMap((f) =>
						f.sessions.map((session) => (
							<AggregatedSessionEvents
								key={`${f.flavor}:${session.session_id}`}
								session={session}
								scale={scale}
								onSessionClick={onSessionClick}
								flavor={f.flavor}
								activeFilter={activeFilter}
								version={sessionVersions?.[session.session_id] ?? 0}
							/>
						)),
					)}
				</div>
			)}
		</div>
	);
}

export const AllSwimLane = memo(AllSwimLaneComponent, (prev, next) => {
	if (prev.flavors !== next.flavors) return false;
	if (prev.activeFilter !== next.activeFilter) return false;
	if (prev.sessionVersions !== next.sessionVersions) return false;
	if (prev.timelineWidth !== next.timelineWidth) return false;
	if (prev.leftPanelWidth !== next.leftPanelWidth) return false;
	if (prev.onSessionClick !== next.onSessionClick) return false;
	if (prev.collapsed !== next.collapsed) return false;
	if (prev.onToggle !== next.onToggle) return false;
	const nextDomain = next.scale.domain();
	const prevDomain = prev.scale.domain();
	const nextStart = nextDomain[0];
	const nextEnd = nextDomain[1];
	const prevStart = prevDomain[0];
	const prevEnd = prevDomain[1];
	if (!nextStart || !nextEnd || !prevStart || !prevEnd) return false;
	const domainDeltaEnd = Math.abs(nextEnd.getTime() - prevEnd.getTime());
	const domainDeltaStart = Math.abs(nextStart.getTime() - prevStart.getTime());
	if (domainDeltaEnd < 1000 && domainDeltaStart < 1000) return true;
	return false;
});

/** Aggregated 20px event circles from all sessions of an agent. */
function AggregatedSwimLane({
	sessions,
	scale,
	onSessionClick,
	flavor,
	activeFilter,
	sessionVersions,
	matchingSessionIds,
}: {
	sessions: Session[];
	scale: ScaleTime<number, number>;
	onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
	flavor: string;
	activeFilter?: string | null;
	sessionVersions?: Record<string, number>;
	matchingSessionIds?: Set<string> | null;
}) {
	return (
		<div className="relative h-full w-full">
			{sessions.map((session) => (
				<AggregatedSessionEvents
					key={session.session_id}
					session={session}
					scale={scale}
					onSessionClick={onSessionClick}
					flavor={flavor}
					activeFilter={activeFilter}
					version={sessionVersions?.[session.session_id] ?? 0}
					matchingSessionIds={matchingSessionIds}
				/>
			))}
		</div>
	);
}

function AggregatedSessionEvents({
	session,
	scale,
	onSessionClick,
	flavor,
	activeFilter,
	version = 0,
	matchingSessionIds,
}: {
	session: Session;
	scale: ScaleTime<number, number>;
	onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
	flavor: string;
	activeFilter?: string | null;
	version?: number;
	matchingSessionIds?: Set<string> | null;
}) {
	const isActive = session.state === "active";
	const { events } = useSessionEvents(session.session_id, isActive, version);
	const [showDiscovery] = useShowDiscoveryEvents();

	// Honour the active CONTEXT facet filter: sessions not in the
	// matching set render at low opacity and ignore pointer events.
	const matches =
		matchingSessionIds === null || matchingSessionIds === undefined
			? true
			: matchingSessionIds.has(session.session_id);

	// Clip events to the current scale domain before building nodes.
	// useSessionEvents caches every event ever fetched, so without
	// this filter a 50-agent fleet at a 1-minute view could render
	// thousands of off-canvas EventNodes that still cost full style
	// recalc.
	const nodes = useMemo(() => {
		const [domainStart, domainEnd] = scale.domain();
		if (!domainStart || !domainEnd) return [];
		const startMs = domainStart.getTime();
		const endMs = domainEnd.getTime();
		const attachments = attachmentsCache.get(session.session_id) ?? [];
		return events
			.filter((event) => {
				const t = new Date(event.occurred_at).getTime();
				return t >= startMs && t <= endMs;
			})
			.map((event) => ({
				id: event.id,
				x: scale(new Date(event.occurred_at)),
				eventType: event.event_type,
				model: event.model,
				toolName: event.tool_name,
				tokensTotal: event.tokens_total,
				latencyMs: event.latency_ms,
				occurredAt: event.occurred_at,
				directiveName: event.payload?.directive_name,
				directiveStatus: event.payload?.directive_status,
				isAttachment: isAttachmentStartEvent(event, attachments),
			}));
		// ``attachments`` is intentionally omitted from the dep array;
		// its identity flips on every parent render and adding it
		// thrashes the memo. The single field we read from it is a
		// function of ``events`` and stable reference equality of the
		// entries, so events-as-dep is sufficient.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [events, scale, session.session_id, version]);

	return (
		<div
			style={{
				opacity: matches ? 1 : 0.15,
				pointerEvents: matches ? "auto" : "none",
				position: "absolute",
				inset: 0,
			}}
		>
			{nodes.map((node) => (
				<EventNode
					key={node.id}
					x={node.x}
					eventType={node.eventType}
					sessionId={session.session_id}
					flavor={flavor}
					model={node.model}
					toolName={node.toolName}
					tokensTotal={node.tokensTotal}
					latencyMs={node.latencyMs}
					occurredAt={node.occurredAt}
					eventId={node.id}
					directiveName={node.directiveName}
					directiveStatus={node.directiveStatus}
					onClick={(eid) => {
						const fullEvent = events.find((e) => e.id === eid);
						onSessionClick(session.session_id, eid, fullEvent);
					}}
					size={EVENT_CIRCLE_SIZE}
					isVisible={
						isEventVisible(node.eventType, activeFilter) &&
						(showDiscovery || !isDiscoveryEvent(node.eventType))
					}
					isAttachment={node.isAttachment}
				/>
			))}
		</div>
	);
}
