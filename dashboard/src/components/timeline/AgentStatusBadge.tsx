import type { SessionState } from "@/lib/types";
import { STATUS_LABEL, StatusDot } from "@/lib/agent-status";
import { cn } from "@/lib/utils";

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
//
// ``align`` controls the badge's flex behaviour. The default
// ``"auto-right"`` keeps ``ml-auto`` so the badge claims any
// remaining horizontal space and parks at the right edge — the
// swimlane row's label strip wants this so the badge sits flush
// with the panel's right border regardless of how many siblings
// (icons, pills) precede it. ``"inline"`` drops ``ml-auto`` so
// the badge sits immediately after its preceding sibling — used
// by the per-agent modal header where the badge must hug the
// agent name + topology pill on the left, leaving the close ×
// (own ``marginLeft: auto``) to anchor the right edge.

export function AgentStatusBadge({
	state,
	testId = "swimlane-agent-status-badge",
	align = "auto-right",
}: {
	state: SessionState | "";
	testId?: string;
	align?: "auto-right" | "inline";
}) {
	const label = STATUS_LABEL[state];
	return (
		<span
			data-testid={testId}
			data-state={state || "unknown"}
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]",
				align === "auto-right" && "ml-auto",
			)}
			style={{ color: "var(--text-muted)" }}
		>
			<StatusDot state={state} testId="swimlane-agent-status-dot" />
			<span style={{ color: "var(--text)" }}>{label}</span>
		</span>
	);
}
