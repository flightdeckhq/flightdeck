import {
  clientSourceLabel,
  isOtlpTelemetry,
  OBSERVE_ONLY_NOTE,
  OTLP_SOURCE_PILL_TEXT,
  TELEMETRY_SOURCE_COLOR,
} from "@/lib/agent-identity";

/**
 * The ``OTEL`` pill that sits after a ``ClientTypePill`` when the
 * session (or the agent's latest session) was reported over
 * OpenTelemetry, so "Claude Code via OpenTelemetry" reads apart from
 * "Claude Code via plugin" at a glance. Renders nothing for any other
 * source: the plugin and the sensor are the default way a client
 * reports, and a pill on every one of their rows would be noise.
 *
 * The tooltip spells the source out and says the session observes
 * only, since an OTLP export carries no channel back to the agent.
 * Shape and type follow ``ClientTypePill`` (10 px uppercase, never
 * truncates) so the two read as one cluster.
 */
export function TelemetrySourcePill({
  telemetry,
  clientType,
  framework,
  testId,
}: {
  /** ``context.telemetry`` of the session, or an agent row's
   *  ``telemetry``. */
  telemetry: unknown;
  clientType?: string | null;
  /** The session's (or the agent's latest session's) framework label,
   *  which names an agent framework's GenAI telemetry in the tooltip
   *  ("Pydantic AI via OpenTelemetry"). */
  framework?: string | null;
  testId?: string;
}) {
  if (!isOtlpTelemetry(telemetry)) return null;
  const colors = TELEMETRY_SOURCE_COLOR;
  const description = `${clientSourceLabel(clientType, telemetry, framework)}: ${OBSERVE_ONLY_NOTE}`;
  return (
    <span
      data-testid={testId}
      data-telemetry="otlp"
      className="rounded-xs font-semibold uppercase tracking-wide"
      style={{
        padding: "0 4px",
        fontSize: 10,
        lineHeight: "14px",
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
      title={description}
    >
      {/* Visible text is the short pill label; screen readers get the
          full phrase in its place, since a tooltip is not announced. */}
      <span aria-hidden="true">{OTLP_SOURCE_PILL_TEXT}</span>
      <span className="sr-only">{description}</span>
    </span>
  );
}
