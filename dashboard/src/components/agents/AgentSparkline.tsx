import { memo, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import type { AgentSummarySeriesPoint } from "@/lib/types";
import { formatCost, formatLatencyMs, formatTokens } from "@/lib/agents-format";

/**
 * One per-row sparkline tile rendered inside the `/agents` table.
 * Wraps recharts at a small size — no axes, no grid; the tile is
 * a visual cue while the numeric total beside it carries the
 * operator-actionable value.
 *
 * Hover surfaces a tooltip showing the nearest data point's
 * formatted value (matching the column's numeric format —
 * ``formatTokens`` / ``formatLatencyMs`` / integer for errors)
 * + the bucket's date. Tooltip renders via ``createPortal`` to
 * ``document.body`` with ``zIndex: 9999`` so it always escapes
 * the table cell's overflow / clipping context.
 *
 * Sparkline clicks are SWALLOWED — the operator explicitly
 * opted for read-only sparkline behaviour, so a click on the
 * chart never propagates to the row's drawer-open handler. Row
 * clicks still open the drawer because the table row owns the
 * outer ``onClick``; the sparkline's ``stopPropagation`` only
 * fires inside the ~80px tile band.
 *
 * Renders a stable horizontal placeholder dash when the series
 * has fewer than two non-zero points so the column width stays
 * fixed regardless of agent activity. The dash has no tooltip —
 * there is no data to surface.
 */

const PIXEL_HOVER_TOLERANCE = 16;
const TOOLTIP_OFFSET_PX = 12;
const TOOLTIP_Z_INDEX = 9999;
// Single source of truth for the recharts ``LineChart`` margin
// on this tile. The hover lookup math below subtracts this from
// the tile's rect to project the visible plot band; the
// ``LineChart`` margin prop is built from the same constant so
// the two cannot silently drift.
const CHART_MARGIN_PX = 2;

interface AgentSparklineProps {
  series: AgentSummarySeriesPoint[];
  /** Which numeric field of the series point to plot. */
  axis: keyof Pick<
    AgentSummarySeriesPoint,
    "tokens" | "errors" | "sessions" | "cost_usd" | "latency_p95_ms"
  >;
  /** Pixel dimensions of the tile. */
  width?: number;
  height?: number;
}

/**
 * Axis-keyed stroke palette. Picks a CSS variable so themes can
 * retune the colour without touching this component. Errors are
 * red, cost is amber, sessions are cyan to read as a count, and
 * tokens / latency stay on the brand accent — the rationale is
 * that errors and cost have semantic "alert" + "$$" colourings
 * the operator's eye already maps to those concepts, while tokens
 * and latency are neutral usage signals that share the accent.
 *
 * Exported for unit-test parity: jsdom does not measure the
 * ResponsiveContainer so recharts never renders the SVG path the
 * stroke would land on. Asserting against the pure function keeps
 * the contract lockable without spinning up a real layout engine.
 */
export function strokeForAxis(axis: AgentSparklineProps["axis"]): string {
  switch (axis) {
    case "errors":
      return "var(--danger)";
    case "cost_usd":
      return "var(--warning)";
    case "sessions":
      return "var(--chart-2)";
    case "tokens":
    case "latency_p95_ms":
    default:
      return "var(--accent)";
  }
}

function formatAxisValue(
  axis: AgentSparklineProps["axis"],
  value: number,
): string {
  switch (axis) {
    case "tokens":
      return formatTokens(value);
    case "latency_p95_ms":
      return formatLatencyMs(value);
    case "cost_usd":
      // Defer to the shared formatter so the sparkline tooltip
      // and the row's Cost column never drift on rounding.
      return formatCost(value);
    case "errors":
    case "sessions":
    default:
      return Math.round(value).toString();
  }
}

function formatBucketDate(ts: string): string {
  // Bucket timestamps from /v1/agents/:id/summary come in as ISO
  // strings at midnight UTC (``bucket=day`` default in the
  // ``/agents`` table). Render as a short date + month so the
  // tooltip reads ``May 24`` rather than the full RFC 3339.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function AgentSparklineImpl({
  series,
  axis,
  width = 80,
  height = 24,
}: AgentSparklineProps) {
  // Keep ``ts`` on the data row so the tooltip can label the
  // bucket. The plotted value lives on ``v``; ``ts`` is carried
  // through for the hover lookup only.
  const data = series.map((p) => ({ v: p[axis] ?? 0, ts: p.ts }));
  const isSparse = data.filter((d) => d.v > 0).length < 2;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{
    px: number;
    py: number;
    value: number;
    ts: string;
  } | null>(null);

  // Swallow sparkline clicks so the operator's chosen read-only
  // behaviour holds. The row's outer ``onClick`` still fires on
  // every other cell, so the drawer continues to open on row
  // clicks. ``onMouseDown`` is stopped too because Radix-style
  // pointer-event-handling can route mousedown to outer handlers
  // independently of click.
  const swallow = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  if (isSparse) {
    return (
      <div
        data-testid="agent-sparkline-empty"
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        // The dash carries no data → no tooltip. But the read-
        // only-click contract still applies (the ~80px sparkline
        // tile area is uniformly non-clickable whether it renders
        // a chart or a dash).
        onClick={swallow}
        onMouseDown={swallow}
      >
        <div
          style={{
            width: width * 0.6,
            height: 1,
            background: "var(--border)",
          }}
        />
      </div>
    );
  }

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || data.length === 0) return;
    // Recharts inserts ``CHART_MARGIN_PX`` on every side of the
    // ``LineChart`` (the same constant feeds the ``margin`` prop
    // below). The plot area sits inside that band; the leftmost
    // data point lands at ``margin.left`` and the rightmost at
    // ``width - margin.right``.
    const innerLeft = CHART_MARGIN_PX;
    const innerWidth = rect.width - CHART_MARGIN_PX * 2;
    const relativeX = e.clientX - rect.left - innerLeft;
    const step = innerWidth / Math.max(1, data.length - 1);
    const idx = Math.max(
      0,
      Math.min(data.length - 1, Math.round(relativeX / step)),
    );
    const point = data[idx];
    if (!point) return;
    const pointX = rect.left + innerLeft + idx * step;
    const pointY = rect.top + rect.height / 2;
    if (Math.abs(e.clientX - pointX) > PIXEL_HOVER_TOLERANCE) {
      setHover(null);
      return;
    }
    setHover({ px: pointX, py: pointY, value: point.v, ts: point.ts });
  };

  const onMouseLeave = () => setHover(null);

  return (
    <>
      <div
        ref={containerRef}
        data-testid="agent-sparkline"
        style={{ width, height, cursor: "default" }}
        onClick={swallow}
        onMouseDown={swallow}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{
              top: CHART_MARGIN_PX,
              right: CHART_MARGIN_PX,
              bottom: CHART_MARGIN_PX,
              left: CHART_MARGIN_PX,
            }}
          >
            {/* Hidden YAxis with an auto-fit domain. Recharts' default
                YAxis domain is ``[0, dataMax]`` which collapses
                sub-cent cost values (0.001 — 0.005 range) against the
                ``0`` anchor and the line renders visually flat even
                though the underlying data fluctuates. Anchoring on
                ``dataMin`` / ``dataMax`` instead expands the visible
                range to fit the actual variation, so the cost line
                rides between the tile's top and bottom edges
                regardless of how small the absolute values are.
                Hidden because the sparkline tile carries no axis
                chrome — the numeric total beside it is the
                operator-actionable readout. */}
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Line
              type="monotone"
              dataKey="v"
              stroke={strokeForAxis(axis)}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {hover &&
        createPortal(
          <div
            data-testid="agent-sparkline-tooltip"
            role="tooltip"
            style={{
              position: "fixed",
              left: hover.px,
              top: hover.py - TOOLTIP_OFFSET_PX,
              transform: "translate(-50%, -100%)",
              background: "var(--bg-elevated)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 8px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              zIndex: TOOLTIP_Z_INDEX,
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
            }}
          >
            {formatBucketDate(hover.ts)}: {formatAxisValue(axis, hover.value)}
          </div>,
          document.body,
        )}
    </>
  );
}

export const AgentSparkline = memo(AgentSparklineImpl);
