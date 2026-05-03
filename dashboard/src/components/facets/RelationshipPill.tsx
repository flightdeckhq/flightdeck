import { TruncatedText } from "@/components/ui/TruncatedText";

/**
 * D126 § 7.fix.A — always-on relationship pill on the SwimLane left
 * panel. Distinct from ``SubAgentRolePill`` (which surfaces the
 * agent's role string) and from the L8 red dot (which surfaces a
 * failure cue): this pill answers "who is my parent / how many
 * children do I have?" for the agent in this row.
 *
 *   * mode="child"  — renders ``↳ <parentName>`` and click navigates
 *                     to the parent agent's swimlane row.
 *   * mode="parent" — renders ``→ <count>`` and click scrolls to
 *                     the first child agent's swimlane row.
 *
 * Lone agents do not render this pill at all; the SwimLane caller
 * gates on the agent's topology before mounting it. Both themes
 * resolve via CSS variables (``--accent`` / ``--bg-elevated``) so
 * the same component renders correctly under neon-dark and
 * clean-light projects without a theme branch.
 */
export function RelationshipPill({
  mode,
  parentName,
  childCount,
  onClick,
  testId,
}: {
  mode: "child" | "parent";
  /** Parent agent's display name. Required when mode === "child". */
  parentName?: string;
  /** Distinct child agent count. Required when mode === "parent". */
  childCount?: number;
  /** Fires when the user clicks the pill. Caller is responsible for
   *  the actual scroll / navigation since the swimlane row layout
   *  lives outside this component. */
  onClick?: () => void;
  testId?: string;
}) {
  const isInteractive = !!onClick;
  const label =
    mode === "child"
      ? `↳ ${parentName ?? "(unknown parent)"}`
      : `→ ${childCount ?? 0}`;
  return (
    <button
      type="button"
      data-testid={testId ?? "relationship-pill"}
      data-mode={mode}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        lineHeight: 1,
        padding: "2px 6px",
        borderRadius: 4,
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        color: "var(--accent)",
        border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
        cursor: isInteractive ? "pointer" : "default",
        // Reset native button chrome so the pill matches the
        // surrounding non-interactive pills visually.
        textTransform: "none",
        letterSpacing: "0.02em",
        maxWidth: 140,
      }}
      aria-label={
        mode === "child"
          ? `Spawned by ${parentName ?? "unknown parent"}`
          : `Spawned ${childCount ?? 0} sub-agent${childCount === 1 ? "" : "s"}`
      }
    >
      {mode === "child" ? (
        <TruncatedText text={label} />
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}
