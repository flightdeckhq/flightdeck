import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import type { ScaleTime } from "d3-scale";
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
import { TruncatedText } from "@/components/ui/TruncatedText";
import { EVENT_CIRCLE_SIZE } from "@/lib/constants";
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
				    by agent — see SwimLaneProps), so this emits the
				    canonical agent_id UUID into ``/agents?focus=``;
				    the ``/agents`` page matches that param against
				    ``agent_id`` to scroll + highlight the row.
				    Truncates via native ``title`` tooltip when the
				    row is narrow. */}
				<Link
					to={`/agents?focus=${encodeURIComponent(flavor)}`}
					data-testid="swimlane-agent-name-link"
					className="flex min-w-0 items-center"
					style={{
						color: "var(--text)",
						textDecoration: "none",
						flex: "0 1 auto",
					}}
				>
					<TruncatedText
						className="text-[13px] font-medium"
						style={{ color: "var(--text)", minWidth: 0 }}
						text={agentName ?? flavor}
					/>
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
				<AgentStatusBadge state={agentState} />
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
						timelineWidth={timelineWidth}
						anchor={bracketAnchorMap.get(s.session_id) ?? "top"}
						onClick={(sid) => onSessionClick(sid)}
					/>
				))}
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
 * single non-expandable lane whose event circles are merged from
 * every session across every agent, so operators get a fleet-wide
 * view of activity without scanning each row.
 *
 * Unlike SwimLane, this row:
 *   - has no label-strip pills, no status badge, no run brackets
 *   - is shorter (36px vs 48px) to signal "summary, not an agent"
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
	 * True when any session has at least one cached event inside the
	 * current ``[scaleStart, scaleEnd]`` domain. Timeline.tsx computes
	 * this once for the whole fleet and hands it down so the ALL
	 * row's hide rule matches what the user sees — a row full of
	 * circles from closed sessions still surfaces, and an empty time
	 * window hides even while sessions are active.
	 */
	hasVisibleEventsInWindow: boolean;
}

function AllSwimLaneComponent({
	flavors,
	scale,
	onSessionClick,
	timelineWidth,
	leftPanelWidth,
	activeFilter,
	sessionVersions,
	hasVisibleEventsInWindow,
}: AllSwimLaneProps) {
	if (!hasVisibleEventsInWindow) return null;
	return (
		<div
			data-testid="swimlane-all"
			style={{
				display: "flex",
				alignItems: "center",
				height: 36,
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
					paddingLeft: 12,
				}}
			>
				<span
					data-testid="swimlane-all-label"
					style={{
						fontSize: 10,
						fontWeight: 700,
						letterSpacing: "0.08em",
						color: "var(--text-muted)",
						textTransform: "uppercase",
						fontFamily: "var(--font-ui)",
					}}
				>
					All
				</span>
			</div>
			<div
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
	if (prev.hasVisibleEventsInWindow !== next.hasVisibleEventsInWindow) return false;
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
