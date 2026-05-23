import type { SessionState } from "@/lib/types";
import { STATUS_LABEL, StatusDot } from "@/lib/agent-status";

// AgentStatusBadge renders the agent's rolled-up state at the
// right edge of a swimlane row's label strip, the /agents STATUS
// column chip, the per-agent swimlane modal header, and the agent
// drawer header. State is the max-priority value across the
// agent's runs (active > idle > stale > closed > lost), passed
// in by the call site. When state is ``"active"`` the inner
// ``StatusDot`` picks up the ``agent-status-active-ring`` class
// from ``globals.css`` which renders a rotating gradient arc on
// a ``::before`` pseudo-element. Theme-agnostic — both the dot
// colour and the ring colour resolve to ``--status-*`` custom
// properties defined in ``themes.css``.

export function AgentStatusBadge({
	state,
	testId = "swimlane-agent-status-badge",
}: {
	state: SessionState | "";
	testId?: string;
}) {
	const label = STATUS_LABEL[state];
	return (
		<span
			data-testid={testId}
			data-state={state || "unknown"}
			className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]"
			style={{ color: "var(--text-muted)" }}
		>
			<StatusDot state={state} testId="swimlane-agent-status-dot" />
			<span style={{ color: "var(--text)" }}>{label}</span>
		</span>
	);
}
