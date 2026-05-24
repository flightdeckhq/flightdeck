import type { SessionState } from "@/lib/types";

/**
 * Single source of truth for agent / session state colour + label.
 * Every surface that surfaces state (Fleet swimlane status badge,
 * /agents STATUS column chip, per-agent swimlane modal header
 * badge, agent drawer header badge) reads these two maps via
 * ``StatusDot`` below so the colour-to-state mapping cannot drift
 * between rendering call sites.
 *
 * Colour values are CSS custom-property references defined in
 * ``themes.css`` — the badge is theme-agnostic in both
 * ``neon-dark`` and ``clean-light``.
 */
export const STATUS_COLOR: Record<SessionState | "", string> = {
  active: "var(--status-active)",
  idle: "var(--status-idle)",
  stale: "var(--status-stale)",
  closed: "var(--status-closed)",
  lost: "var(--status-lost)",
  "": "var(--text-muted)",
};

export const STATUS_LABEL: Record<SessionState | "", string> = {
  active: "Active",
  idle: "Idle",
  stale: "Stale",
  closed: "Closed",
  lost: "Lost",
  "": "—",
};

interface StatusDotProps {
  state: SessionState | "";
  /** Diameter in pixels. Defaults to 8, matching the historical
   *  ``AgentStatusBadge`` size. The active-ring decoration scales
   *  off this via the CSS rule's ``inset: -3px`` so the ring sits
   *  ~3 px outside the dot's edge at any size. */
  size?: number;
  /** Test-id stamp for the dot element. The label-bearing badge
   *  sets a stable name (``swimlane-agent-status-dot``); call
   *  sites that render the bare dot pass their own. Optional —
   *  when omitted the dot carries no test-id. */
  testId?: string;
}

/**
 * Atomic agent-status indicator dot. Active state adds the
 * ``agent-status-active-ring`` decoration (a rotating gradient
 * arc on a ``::before`` pseudo-element, defined in
 * ``globals.css``). The dot itself is the relative-positioned
 * container the pseudo-element anchors to.
 *
 * Used by ``AgentStatusBadge`` (the labeled badge that ships
 * across Fleet swimlane / /agents STATUS column / modal /
 * drawer) and by any caller wanting the dot without the label.
 */
export function StatusDot({ state, size = 8, testId }: StatusDotProps) {
  const isActive = state === "active";
  return (
    <span
      data-testid={testId}
      data-state={state || "unknown"}
      className={isActive ? "agent-status-active-ring" : ""}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: STATUS_COLOR[state],
        flexShrink: 0,
        position: "relative",
      }}
    />
  );
}
