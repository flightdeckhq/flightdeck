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

/**
 * Format an ISO date string as a relative time (e.g. "2m ago", "3h ago", "5d ago").
 */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
