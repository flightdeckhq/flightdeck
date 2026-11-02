import { memo, useState } from "react";

/**
 * Sub-agent time-flow connectors. SVG overlay layer
 * that renders one Bezier curve per (parent-spawn-event, child-
 * first-event) pair when BOTH endpoints are simultaneously visible
 * in the Fleet swimlane window.
 *
 * Endpoints: Timeline.tsx measures the rendered circles (found by
 * ``data-event-id`` inside the parent's and the child's rows) and
 * passes their centres in the overlay's coordinate space, with the
 * parent circle's radius from its ``offsetWidth`` (a hover scale
 * leaves both unchanged). The overlay itself does pure math from
 * those numbers, no DOM measurement (Rule 16):
 *   * Anchor on the parent event circle's CIRCUMFERENCE — never on
 *     a shared single point. For each child the anchor is the
 *     point on the circle's edge whose direction matches the line
 *     from circle centre to child first event:
 *       - Children rendered above the parent → top hemisphere.
 *       - Children rendered below → bottom hemisphere.
 *     This keeps connectors visually un-tangled when multiple
 *     children scatter across activity buckets.
 *   * Bezier curve from anchor to child first event with ONE
 *     control point. The control point sits halfway in x and at
 *     the anchor's y so the curve bows out toward the child's
 *     row, mirroring how an operator would draw a hand-sketched
 *     arrow. The curve ends at the child circle's centre.
 *
 * Visual:
 *   * 10% opacity at rest. 50% while the pointer is on the path
 *     itself, or while ``hoveredId`` names a run at either end:
 *     Timeline.tsx sets it to the run whose mark (event circle or
 *     run glyph) is hovered or whose glyph has focus, so a parent
 *     run lights its whole fan-out and a child run its own link.
 *   * stroke colour reads ``--accent`` (CSS variable) so both
 *     theme projects pick up the right tone without a render
 *     branch.
 *
 * Layer order (Rule 16 — D3 for math only, never for DOM):
 *   * z-index 1 = grid lines (Timeline's existing).
 *   * z-index 2 = THIS overlay's SVG, first in the DOM.
 *   * z-index 2 = event circles (EventNode), later in the DOM, so
 *     they paint over the connector ends; a hovered circle rises
 *     to z-index 10.
 */

export interface SubAgentConnectorSpec {
  /** Stable id used in data-testid + hover dedup. Caller
   *  conventionally builds it as ``${parentSessionId}->${childSessionId}``. */
  id: string;
  /** The runs at each end. ``hoveredId`` lights the connector when
   *  it names either one. */
  parentSessionId: string;
  childSessionId: string;
  /** The events whose circles the connector joins: the parent's
   *  spawn event and the child's first event in the window. Exposed
   *  as ``data-parent-event-id`` / ``data-child-event-id``. */
  parentEventId: string;
  childEventId: string;
  /** Parent event circle centre (px) in the SVG coordinate space. */
  parentX: number;
  parentY: number;
  /** Parent event circle radius (px): half the rendered circle's
   *  ``offsetWidth``, so a circle-size change flows through. */
  parentR: number;
  /** Child first event circle centre (px). */
  childX: number;
  childY: number;
}

/**
 * Centre of a rendered circle in the overlay's coordinate space:
 * the circle's viewport rect relative to the container the SVG is
 * absolutely positioned in (its top-left is the SVG's origin). A
 * hover scale grows the rect about its centre, so the centre holds.
 *
 * Pure function — exported for unit testing.
 */
export function circleCentre(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  container: Pick<DOMRect, "left" | "top">,
): { x: number; y: number } {
  return {
    x: rect.left - container.left + rect.width / 2,
    y: rect.top - container.top + rect.height / 2,
  };
}

/**
 * Whether ``hoveredRunId`` names a run at either end of ``spec``.
 *
 * Pure function — exported for unit testing.
 */
export function connectorTouchesRun(
  spec: Pick<SubAgentConnectorSpec, "parentSessionId" | "childSessionId">,
  hoveredRunId: string | null | undefined,
): boolean {
  return (
    !!hoveredRunId &&
    (spec.parentSessionId === hoveredRunId || spec.childSessionId === hoveredRunId)
  );
}

interface SubAgentConnectorProps {
  connectors: SubAgentConnectorSpec[];
  /** Total SVG canvas width / height. The overlay sits absolutely
   *  positioned over the timeline + flavors section so width = the
   *  timeline width and height = the flavors section height. */
  width: number;
  height: number;
  /** Externally driven hover: the session id of the run whose mark
   *  (event circle or run glyph) the pointer is on, or whose glyph
   *  has keyboard focus. Timeline.tsx sets it from the marks'
   *  ``data-session-id``. Every connector with that run at either
   *  end lights up, so a parent run lights its whole fan-out and a
   *  child run its own link. */
  hoveredId?: string | null;
}

/**
 * Compute the anchor point on the parent event circle's
 * circumference closest to the child's first event. Above /
 * below hemisphere selection follows the design § 4.3 lock:
 * "Children above connect via the top of the circle; children
 * below via the bottom."
 *
 * Pure function — exported for unit testing.
 */
export function anchorOnCircle(
  cx: number,
  cy: number,
  r: number,
  targetX: number,
  targetY: number,
): { ax: number; ay: number } {
  const dx = targetX - cx;
  const dy = targetY - cy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) {
    // Degenerate: target sits on the circle centre. Drop the
    // anchor to the bottom of the circle so the connector is
    // still drawable without a NaN.
    return { ax: cx, ay: cy + r };
  }
  // Normalised direction vector → projected onto the circle.
  // The natural projection already lands the anchor on the
  // hemisphere matching the target's vertical side, so the
  // design's "above → top, below → bottom" rule falls out of
  // the basic geometry — no extra branch needed.
  const nx = dx / len;
  const ny = dy / len;
  return { ax: cx + nx * r, ay: cy + ny * r };
}

/**
 * Pick the parent event most likely to represent the spawn moment
 * for a child whose first event landed at ``childFirst.occurred_at``.
 * v1 heuristic: the parent's most recent event whose occurred_at is
 * ≤ the child's first event time. Falls back to the parent's first
 * event when no event precedes the child (rare — implies child
 * clock skewed before the parent's session_start).
 *
 * A stricter "real spawn event" filter would target the parent
 * session's ``tool_call`` event with ``tool_name='Task'`` (Claude
 * Code) or the framework's equivalent emission for CrewAI /
 * LangGraph. That filter lands in a follow-up once every framework
 * carries a stable wire marker; for the v1 connector overlay the
 * time-proximity proxy is sufficient and the design § 4.3 contract
 * ("from parent's spawn event circle to child first event")
 * resolves to the temporally-closest preceding event in practice.
 *
 * Pure function — exported for unit testing.
 */
export function pickSpawnEvent<E extends { occurred_at: string }>(
  parentEvents: E[],
  childFirst: { occurred_at: string },
): E | null {
  const childTs = new Date(childFirst.occurred_at).getTime();
  let best: E | null = null;
  let bestTs = -Infinity;
  for (const e of parentEvents) {
    const t = new Date(e.occurred_at).getTime();
    if (t <= childTs && t > bestTs) {
      best = e;
      bestTs = t;
    }
  }
  return best ?? parentEvents[0] ?? null;
}

/**
 * Build the SVG path d attribute for one connector. Anchor +
 * single-control-point quadratic Bezier to the child target.
 * Pure function — exported for unit testing.
 */
export function buildConnectorPath(spec: SubAgentConnectorSpec): string {
  const { ax, ay } = anchorOnCircle(
    spec.parentX,
    spec.parentY,
    spec.parentR,
    spec.childX,
    spec.childY,
  );
  // Control point: midway in x, anchored at the parent's y so
  // the curve bows horizontally toward the child's row. The
  // operator-readable shape is a gentle S that doesn't cross
  // the parent's row circle area.
  const controlX = (ax + spec.childX) / 2;
  const controlY = ay;
  return `M ${ax} ${ay} Q ${controlX} ${controlY} ${spec.childX} ${spec.childY}`;
}

function SubAgentConnectorComponent({
  connectors,
  width,
  height,
  hoveredId,
}: SubAgentConnectorProps) {
  const [internalHover, setInternalHover] = useState<string | null>(null);
  // The SVG container always mounts (even when connectors is
  // empty) so the overlay's testid is a stable signal that the
  // Timeline composed in connector-aware mode. Paths still render
  // conditionally — the design § 4.3 "no overdraw" lock applies
  // to PATH count, not to the empty-overlay element which
  // contributes nothing visible (no children, no fill, no stroke).
  if (width === 0 || height === 0) return null;
  return (
    <svg
      data-testid="sub-agent-connector-overlay"
      data-connector-count={connectors.length}
      width={width}
      height={height}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "none", // children opt-in via their own pointerEvents
        zIndex: 2,
      }}
    >
      {connectors.map((c) => {
        const active =
          internalHover === c.id || connectorTouchesRun(c, hoveredId);
        return (
          <path
            key={c.id}
            data-testid={`sub-agent-connector-${c.id}`}
            data-hover={active ? "true" : "false"}
            data-parent-session-id={c.parentSessionId}
            data-child-session-id={c.childSessionId}
            data-parent-event-id={c.parentEventId}
            data-child-event-id={c.childEventId}
            d={buildConnectorPath(c)}
            stroke="var(--accent)"
            strokeWidth={1.5}
            fill="none"
            opacity={active ? 0.5 : 0.1}
            style={{
              pointerEvents: "stroke",
              transition: "opacity 120ms ease",
            }}
            onMouseEnter={() => setInternalHover(c.id)}
            onMouseLeave={() => setInternalHover(null)}
          />
        );
      })}
    </svg>
  );
}

export const SubAgentConnector = memo(SubAgentConnectorComponent);
