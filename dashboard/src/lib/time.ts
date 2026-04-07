import { scaleTime } from "d3-scale";

/**
 * Create a D3 time scale for the timeline axis.
 * D3 is used for math only -- React owns all rendering.
 */
export function createTimeScale(
  domainStart: Date,
  domainEnd: Date,
  rangeWidth: number
) {
  return scaleTime().domain([domainStart, domainEnd]).range([0, rangeWidth]);
}

/**
 * Generate nice time tick values for the axis.
 */
export function getTimeTicks(
  start: Date,
  end: Date,
  count: number
): Date[] {
  const scale = scaleTime().domain([start, end]);
  return scale.ticks(count);
}

/**
 * Format a date for the time axis label.
 */
export function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
