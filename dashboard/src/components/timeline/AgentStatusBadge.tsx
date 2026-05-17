import type { SessionState } from "@/lib/types";

// AgentStatusBadge renders the agent's rolled-up state at the
// right edge of a swimlane row's label strip. State is the
// max-priority value across the agent's runs
// (active > idle > stale > closed > lost), passed in by the
// SwimLane parent. When state is ``"active"`` the dot picks up the
// ``swimlane-status-pulse`` class which adds a CSS keyframe pulse;
// every other state renders a static dot. Theme-agnostic — the
// colour comes from a ``--status-*`` CSS variable defined in
// themes.css, so the badge renders correctly under both
// ``neon-dark`` and ``clean-light``.

const STATUS_COLOR: Record<SessionState | "", string> = {
	active: "var(--status-active)",
	idle: "var(--status-idle)",
	stale: "var(--status-stale)",
	closed: "var(--status-closed)",
	lost: "var(--status-lost)",
	"": "var(--text-muted)",
};

const STATUS_LABEL: Record<SessionState | "", string> = {
	active: "Active",
	idle: "Idle",
	stale: "Stale",
	closed: "Closed",
	lost: "Lost",
	"": "—",
};

export function AgentStatusBadge({
	state,
	testId = "swimlane-agent-status-badge",
}: {
	state: SessionState | "";
	testId?: string;
}) {
	const color = STATUS_COLOR[state];
	const label = STATUS_LABEL[state];
	const pulse = state === "active";
	return (
		<span
			data-testid={testId}
			data-state={state || "unknown"}
			className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]"
			style={{ color: "var(--text-muted)" }}
		>
			<span
				data-testid="swimlane-agent-status-dot"
				className={pulse ? "swimlane-status-pulse" : ""}
				style={{
					display: "inline-block",
					width: 8,
					height: 8,
					borderRadius: "50%",
					background: color,
					flexShrink: 0,
				}}
			/>
			<span style={{ color: "var(--text)" }}>{label}</span>
		</span>
	);
}
