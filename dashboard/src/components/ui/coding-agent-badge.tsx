/** ``CODING AGENT`` pill badge. Marks sessions produced by a hook-
 *  based coding agent (Claude Code today, Codex / Cursor / etc. on the
 *  roadmap) so a fleet operator scanning a table row can tell the
 *  session category apart from production autonomous agents without
 *  having to hover the icon or read ``flavor``. Sits alongside the
 *  existing DEV badge when present -- they're orthogonal signals:
 *  ``DEV`` = agent_type=developer, ``CODING AGENT`` = hook-based
 *  coding-agent tool category.
 *
 *  Styling mirrors the inline ``DEV`` pill in FleetPanel.tsx (muted
 *  accent background, small uppercase text) so the two read as a
 *  pill family rather than two disparate chips. */
export function CodingAgentBadge({
  className,
  testId,
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId ?? "coding-agent-badge"}
      className={
        "rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
        (className ?? "")
      }
      style={{
        background: "var(--accent-glow)",
        color: "var(--primary)",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
      title="Hook-based coding agent (Claude Code). Observer-only; kill switch does not apply."
    >
      Coding agent
    </span>
  );
}
