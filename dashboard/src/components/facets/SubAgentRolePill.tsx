import { AlertCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentTopology } from "@/lib/types";

/**
 * D126 sub-agent role pill. Renders ``↳ <role>`` with the
 * leftward-arrow glyph signaling "this row is a child agent" and
 * the framework-supplied role string (CrewAI Agent.role, LangGraph
 * node name, Claude Code Task agent_type) as the label. Sized to
 * match the existing ClientTypePill so the row chrome reads as one
 * family of metadata pills.
 *
 * The component is render-only — callers gate display on whether
 * the row's sessions actually carry parent_session_id (sub-agent)
 * and pass the resolved role string. Showing this pill on a root
 * agent would lie about topology, so the call sites guard
 * explicitly.
 */
export function SubAgentRolePill({
  role,
  topology,
  testId,
}: {
  role: string;
  /**
   * Drives the leading glyph. ``child`` → ``↳`` (this row is
   * spawned by a parent). ``parent`` → ``⤴`` (this row spawns
   * sub-agents). ``lone`` callers should not render this pill at
   * all; the type is included for AgentTable consumption where the
   * pill always reflects topology.
   */
  topology: AgentTopology;
  testId?: string;
}) {
  if (topology === "lone") return null;
  const glyph = topology === "child" ? "↳" : "⤴";
  const label =
    topology === "child" ? `${glyph} ${role}` : `${glyph} ${role || "parent"}`;
  return (
    <span
      data-testid={testId ?? "sub-agent-role-pill"}
      data-topology={topology}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        lineHeight: 1,
        padding: "2px 6px",
        borderRadius: 4,
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        color: "var(--accent)",
        border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
        textTransform: "none",
        letterSpacing: "0.02em",
      }}
    >
      {label}
    </span>
  );
}

/**
 * D126 § L8 red-dot indicator. Mirrors the pattern established by
 * the llm_error and mcp_error session-row dots: surface a row-level
 * failure cue so an operator scanning a list immediately spots
 * trouble without expanding the row.
 *
 * For sub-agents the failure mode is a child whose state landed in
 * ``lost`` — the SubagentStop / clean child end signal never fired
 * and the worker's state-revival path swept the row to lost. Per
 * METHODOLOGY.md L8 (Phase 5 lesson) the dot belongs on the row,
 * not buried inside the event detail.
 *
 * Optional ``role`` and ``sessionIdSuffix`` enrich the tooltip so
 * an operator can identify which sub-agent failed without having
 * to expand the row. Both arrive from the SwimLane / Investigate
 * call-site and are best-effort — the dot still renders without
 * them when the full context isn't available (the original step-7
 * call-site supplied neither).
 */
export function SubAgentLostDot({
  role,
  sessionIdSuffix,
  testId,
}: {
  role?: string;
  sessionIdSuffix?: string;
  testId?: string;
}) {
  const detail = [
    role ? `Role: ${role}` : null,
    sessionIdSuffix ? `Session: …${sessionIdSuffix}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={testId ?? "sub-agent-lost-dot"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              color: "var(--status-lost)",
              flexShrink: 0,
            }}
          >
            <AlertCircle size={12} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <div>
            Sub-agent ended in <strong>lost</strong> state — the
            clean end-of-life signal never arrived.
          </div>
          {detail && <div style={{ marginTop: 4 }}>{detail}</div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
