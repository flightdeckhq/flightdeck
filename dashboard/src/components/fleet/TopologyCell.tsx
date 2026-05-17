import { useMemo } from "react";
import { useFleetStore } from "@/store/fleet";
import { deriveRelationship, scrollToAgentRow } from "@/lib/relationship";
import { TruncatedText } from "@/components/ui/TruncatedText";
import type { AgentTopology } from "@/lib/types";

// TopologyCell renders the per-agent topology pill (``lone`` /
// ``↳ child of <parent>`` / ``⤴ spawns N``) used by any agent
// listing surface. Extracted into its own module so the same
// primitive backs both the legacy fleet view (during the Phase 2
// reshape transition) and the Phase 3 /agents page without
// duplicating the relationship lookup.
//
// ``deriveRelationship`` resolves the relationship from the fleet
// store on every render; the AgentSummary's pre-computed
// ``topology`` field is consulted first as the cheap-fast hint so
// the relationship walk runs only for non-lone rows.
export function TopologyCell({
	agentId,
	topology,
}: {
	agentId: string;
	topology: AgentTopology;
}) {
	const flavors = useFleetStore((s) => s.flavors);
	const ownSessions = useMemo(() => {
		return flavors.find((f) => f.flavor === agentId)?.sessions ?? [];
	}, [flavors, agentId]);
	const rel = useMemo(
		() => deriveRelationship(agentId, ownSessions, flavors),
		[agentId, ownSessions, flavors],
	);
	if (topology === "lone" || rel.mode === "lone") {
		return (
			<span
				style={{
					fontSize: 11,
					color: "var(--text-muted)",
					fontFamily: "var(--font-mono)",
				}}
				data-testid="agent-table-topology-pill-lone"
			>
				lone
			</span>
		);
	}
	if (rel.mode === "child") {
		const childLabel = `child of ${rel.parentName}`;
		return (
			<button
				type="button"
				data-testid={`agent-table-topology-pill-child-${agentId}`}
				onClick={(e) => {
					e.stopPropagation();
					scrollToAgentRow(rel.parentAgentId);
				}}
				style={{
					background: "transparent",
					border: "none",
					padding: 0,
					cursor: "pointer",
					fontFamily: "var(--font-mono)",
					fontSize: 10,
					color: "var(--accent)",
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
					maxWidth: "100%",
					minWidth: 0,
				}}
				title={childLabel}
				aria-label={`scroll to parent agent ${rel.parentName}`}
			>
				<span style={{ flexShrink: 0 }}>↳</span>
				<TruncatedText text={childLabel} />
			</button>
		);
	}
	return (
		<button
			type="button"
			data-testid={`agent-table-topology-pill-parent-${agentId}`}
			onClick={(e) => {
				e.stopPropagation();
				if (rel.firstChildAgentId) scrollToAgentRow(rel.firstChildAgentId);
			}}
			style={{
				background: "transparent",
				border: "none",
				padding: 0,
				cursor: rel.firstChildAgentId ? "pointer" : "default",
				fontFamily: "var(--font-mono)",
				fontSize: 10,
				color: "var(--accent)",
			}}
			title={`spawns ${rel.childCount} sub-agent${rel.childCount === 1 ? "" : "s"}`}
			aria-label={
				rel.firstChildAgentId
					? `scroll to first sub-agent — this agent spawns ${rel.childCount} sub-agent${rel.childCount === 1 ? "" : "s"}`
					: `this agent spawns ${rel.childCount} sub-agent${rel.childCount === 1 ? "" : "s"}`
			}
		>
			⤴ spawns {rel.childCount}
		</button>
	);
}
