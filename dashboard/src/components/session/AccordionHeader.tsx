import type { ReactNode } from "react";

/**
 * Shared accordion header button used by ErrorEventDetails and
 * PolicyEventDetails (and any future event-details accordion).
 * The chevron rotates 0°→90° on expansion; the label is rendered
 * in the section-header-uppercase style consistent across the
 * session drawer. Phase 4.5 M-15: extracted from duplicated
 * inline styling.
 */
interface AccordionHeaderProps {
  expanded: boolean;
  onToggle: () => void;
  label: ReactNode;
  testId?: string;
}

export function AccordionHeader({
  expanded,
  onToggle,
  label,
  testId,
}: AccordionHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid={testId}
      className="flex items-center gap-2 text-left transition-colors hover:bg-surface-hover"
      style={{
        padding: "2px 4px",
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--text-secondary)",
        width: "100%",
      }}
    >
      <span
        style={{
          display: "inline-block",
          transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 150ms ease",
          color: "var(--text-muted)",
        }}
      >
        ▶
      </span>
      <span>{label}</span>
    </button>
  );
}
