import {
  clientSourceLabel,
  isOtlpTelemetry,
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
  testId,
}: {
  /** ``context.telemetry`` of the session, or an agent row's
   *  ``telemetry``. */
  telemetry: unknown;
  clientType?: string | null;
  testId?: string;
}) {
  if (!isOtlpTelemetry(telemetry)) return null;
  const colors = TELEMETRY_SOURCE_COLOR;
  const label = clientSourceLabel(clientType, telemetry);
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
      title={`${label}: observe only, no directives reach it`}
    >
      {OTLP_SOURCE_PILL_TEXT}
    </span>
  );
}
