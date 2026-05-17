import { getBadge } from "@/lib/events";

/**
 * Canonical event-type pill — the run drawer's solid tinted badge.
 *
 * Shared verbatim by the three surfaces that render an event-type
 * indicator: the run drawer's Timeline event rows, the `/events`
 * table EventRow, and the agent drawer's Events tab. Before this
 * component the run drawer used the pill while `/events` and the
 * agent drawer used a divergent dot + label; centralising here keeps
 * all three byte-identical.
 *
 * The pill is an 18px-high, 88px-min-width tinted capsule: 15%
 * event-colour background, full-colour text, 30% colour border. The
 * colour + label come from `getBadge(eventType)` so every event type
 * in `eventBadgeConfig` is covered with no new theme tokens.
 *
 * Emits a stable `data-testid="event-type-pill"` plus a
 * `data-event-type` attribute, so the cross-surface visual
 * consistency is externally verifiable — a spec can compare the
 * rendered pill across the run drawer, `/events`, and the agent
 * drawer, or address a specific type via
 * `[data-testid="event-type-pill"][data-event-type="post_call"]`.
 */
export function EventTypePill({
  eventType,
  testId = "event-type-pill",
}: {
  eventType: string;
  testId?: string;
}) {
  const badge = getBadge(eventType);
  return (
    <span
      data-testid={testId}
      data-event-type={eventType}
      className="flex h-[18px] min-w-[88px] shrink-0 items-center justify-center whitespace-nowrap rounded px-2 font-mono text-[10px] font-semibold uppercase"
      style={{
        background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
        color: badge.cssVar,
        border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
        borderRadius: 3,
      }}
    >
      {badge.label}
    </span>
  );
}
