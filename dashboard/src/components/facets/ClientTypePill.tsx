import {
  CLIENT_TYPE_COLOR,
  CLIENT_TYPE_LABEL,
  type ClientType,
} from "@/lib/agent-identity";

/**
 * Small uppercase pill rendering the display label for an agent's
 * ``client_type`` (``Claude Code`` / ``Sensor``) with a
 * client-specific colour treatment.
 *
 * Three existing surfaces (Fleet sidebar FlavorItem, AgentTable CLIENT
 * column, swimlane header) previously inlined an identical neutral
 * pill; this component consolidates the rendering so colour /
 * typography / testid changes land in one place. Consumers pass
 * ``size="compact"`` where space is tight (sidebar + swimlane header
 * that have a ``shrink-0`` container) and the default elsewhere.
 */
export function ClientTypePill({
  clientType,
  size = "default",
  testId,
}: {
  clientType: ClientType;
  size?: "default" | "compact";
  testId?: string;
}) {
  const colors = CLIENT_TYPE_COLOR[clientType];
  const label = CLIENT_TYPE_LABEL[clientType];
  const padding = size === "compact" ? "0 4px" : "1px 6px";
  return (
    <span
      data-testid={testId}
      className="rounded-sm font-semibold uppercase tracking-wide"
      style={{
        padding,
        fontSize: 10,
        lineHeight: "14px",
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        // Sidebar narrow-width behaviour: ``flexShrink: 100`` tells the
        // flexbox the pill yields before sibling labels do, so the
        // agent name stays readable when the sidebar is dragged narrow.
        // ``minWidth: 0`` plus ``overflow/textOverflow`` lets the pill
        // actually collapse past its intrinsic width instead of
        // forcing the row wider. Covered by
        // ``FleetSidebar-resize.test.tsx``.
        flexShrink: 100,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      title={`client_type=${clientType}`}
    >
      {label}
    </span>
  );
}
