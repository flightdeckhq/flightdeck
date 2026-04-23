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
        // Pills never truncate: labels are short, meaningful, and
        // decorative, so a truncated ``SENS…`` pill (the Supervisor
        // Chrome-smoke bug) is strictly worse than a full-width
        // ``SENSOR`` pill plus a truncated sibling agent_name. The
        // sibling ``<TruncatedText/>`` absorbs the truncation via
        // native ellipsis + tooltip; this pill keeps its intrinsic
        // width with ``whiteSpace: nowrap`` + ``flexShrink: 0`` so
        // it cannot be squeezed by its flex row.
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
      title={`client_type=${clientType}`}
    >
      {label}
    </span>
  );
}
