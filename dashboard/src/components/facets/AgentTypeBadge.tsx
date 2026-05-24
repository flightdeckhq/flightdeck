import {
  AGENT_TYPE_COLOR,
  AGENT_TYPE_LABEL,
  type AgentType,
} from "@/lib/agent-identity";

/**
 * Small uppercase badge rendering the canonical label for an agent's
 * `agent_type` (`Coding` / `Production` from [AGENT_TYPE_LABEL]) with
 * an agent-type-specific colour treatment.
 *
 * Mirrors [ClientTypePill]'s shape (rounded-sm, 10px uppercase, 1px
 * border) so the two read as one pill family when rendered side by
 * side in the identity chrome of the Fleet swimlane label strip and
 * the Events table AGENT cell. `agent_type` is session-scoped, so the
 * badge applies to an event of any type.
 *
 * Callers narrow the nullable wire string with `isAgentType` from
 * `@/lib/agent-identity` before passing it here.
 */
export function AgentTypeBadge({
  agentType,
  testId,
}: {
  agentType: AgentType;
  testId?: string;
}) {
  const colors = AGENT_TYPE_COLOR[agentType];
  return (
    <span
      data-testid={testId}
      className="rounded-sm font-semibold uppercase tracking-wide"
      style={{
        padding: "0 4px",
        fontSize: 10,
        lineHeight: "14px",
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        letterSpacing: "0.04em",
        // The badge keeps its intrinsic width so it cannot be
        // squeezed by a constrained flex row — a sibling
        // `<TruncatedText/>` absorbs the truncation instead.
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
      title={`agent_type=${agentType}`}
    >
      {AGENT_TYPE_LABEL[agentType]}
    </span>
  );
}
