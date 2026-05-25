import { useMemo } from "react";
import { useFleetStore } from "@/store/fleet";
import { deriveRelationship, scrollToAgentRow } from "@/lib/relationship";
import { TruncatedText } from "@/components/ui/TruncatedText";
import { cn } from "@/lib/utils";
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
//
// Visual contract (D163): all three modes render as a rounded
// tinted pill of the same shape so the column reads as a member
// of the same badge family as ClientTypePill / agent_type badge.
// child + parent use an accent tint (clickable), lone uses a
// muted tint (static).

const PILL_BASE_CLASS =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] whitespace-nowrap";

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

  // Accent pill style for child + parent. Foreground reads from
  // ``--topology-pill-fg`` (defined per theme block in themes.css)
  // so the colour tracks the live html.dark / html.light class
  // and recolours instantly on the Nav's theme toggle. Pre-fix
  // useTheme()'s per-component useState held a stale local copy
  // until the cell remounted, leaving the dark-theme lightened
  // accent on the light surface after a live toggle. Background
  // and border are color-mix derivatives of --accent (theme-
  // agnostic by construction) so only the foreground needs the
  // per-theme variable.
  const accentPillStyle = {
    color: "var(--topology-pill-fg)",
    background: "color-mix(in srgb, var(--accent) 15%, transparent)",
    border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
  } as const;

  if (topology === "lone" || rel.mode === "lone") {
    return (
      <span
        className={PILL_BASE_CLASS}
        style={{
          color: "var(--text-muted)",
          background: "color-mix(in srgb, var(--text) 6%, transparent)",
          border: "1px solid var(--border-subtle)",
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
        className={cn(PILL_BASE_CLASS, "cursor-pointer max-w-full min-w-0")}
        style={accentPillStyle}
        title={childLabel}
        aria-label={`scroll to parent agent ${rel.parentName}`}
      >
        <span className="flex-shrink-0">↳</span>
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
      className={cn(
        PILL_BASE_CLASS,
        rel.firstChildAgentId ? "cursor-pointer" : "cursor-default",
      )}
      style={accentPillStyle}
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
