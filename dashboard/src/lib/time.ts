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
 * includeSeconds=true shows HH:MM:SS for short ranges.
 */
export function formatTimeLabel(date: Date, includeSeconds = false): string {
  if (includeSeconds) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
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

/**
 * Format a duration in milliseconds as a compact relative-time label
 * for the timeline axis. Picks the largest natural unit (s/m/h) so the
 * label fits in a tight axis row without an "ago" suffix.
 *
 *   formatRelativeLabel(    30_000) === "30s"
 *   formatRelativeLabel(    45_000) === "45s"
 *   formatRelativeLabel(    60_000) === "1m"
 *   formatRelativeLabel(   300_000) === "5m"
 *   formatRelativeLabel(   720_000) === "12m"
 *   formatRelativeLabel( 3_600_000) === "1h"
 */
export function formatRelativeLabel(ms: number): string {
  const totalSecs = ms / 1000;
  if (totalSecs < 60) return `${Math.round(totalSecs)}s`;
  const totalMins = ms / 60_000;
  if (totalMins < 60) return `${Math.round(totalMins)}m`;
  return `${Math.round(totalMins / 60)}h`;
}
