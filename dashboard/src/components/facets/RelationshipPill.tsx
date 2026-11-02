import { TruncatedText } from "@/components/ui/TruncatedText";

/**
 * Flex-shrink weight of a ``shrinkable`` pill. The swimlane's agent
 * name shrinks with weight 1, and flex shares the overflow in
 * proportion to weight times width, so at 100 the pill gives up
 * almost all of the overflow first: the parent's name it repeats is
 * the part of a sub-agent row that can afford to truncate.
 */
export const CHILD_PILL_SHRINK_WEIGHT = 100;

/**
 * Narrowest a ``shrinkable`` pill gets: room for the ``↳`` and an
 * ellipsis at the pill's 10 px mono font plus its padding, so the
 * pill still reads as a link to the parent.
 */
export const CHILD_PILL_MIN_WIDTH = "1.75rem";

/**
 * Always-on relationship pill on the SwimLane left
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
  shrinkable = false,
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
  /** Let the pill shrink before its row's other items, down to
   *  ``CHILD_PILL_MIN_WIDTH`` with an ellipsis. The swimlane passes it
   *  on a sub-agent row so the row's own name keeps its width; every
   *  other caller keeps the pill at its natural width. */
  shrinkable?: boolean;
}) {
  const isInteractive = !!onClick;
  const label =
    mode === "child"
      ? `↳ ${parentName ?? "(unknown parent)"}`
      : `→ ${childCount ?? 0}`;
  // Hover tooltip copy. Plain "Spawned …" wording so the pill is
  // self-explanatory at first hover — the visual glyph (↳ / →) is
  // mnemonic only after the operator already knows the convention.
  // Pluralisation lives here so "Spawned 1 sub-agent" reads naturally.
  const tooltip =
    mode === "child"
      ? `Spawned from ${parentName ?? "(unknown parent)"}`
      : `Spawned ${childCount ?? 0} sub-agent${childCount === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      data-testid={testId ?? "relationship-pill"}
      data-mode={mode}
      title={tooltip}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: shrinkable ? CHILD_PILL_SHRINK_WEIGHT : 0,
        minWidth: shrinkable ? CHILD_PILL_MIN_WIDTH : undefined,
        // Clips the pill to its shrunk width; TruncatedText draws the
        // ellipsis inside.
        overflow: shrinkable ? "hidden" : undefined,
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
