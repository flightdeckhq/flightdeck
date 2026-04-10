/**
 * Fleet dashboard runtime constants.
 * All magic numbers live here.
 * Never hardcode these values in components or hooks.
 */

/** Maximum events retained in the live feed display buffer.
 *  Oldest events are dropped when exceeded. */
export const FEED_MAX_EVENTS = 500;

/** Maximum events buffered in the pause queue.
 *  When reached, oldest events are dropped (FIFO).
 *  Events are still in the database -- only the in-memory buffer is capped. */
export const PAUSE_QUEUE_MAX_EVENTS = 1000;

/** Number of recent events loaded from the fleet store
 *  into the live feed on initial mount. */
export const FEED_INITIAL_LOAD = 100;

// FEED_BATCH_MS removed — React 18 automatic batching makes manual timers redundant.
// SESSION_POLL_INTERVAL_MS and SESSION_INITIAL_POLL_MS removed.
// Active sessions now update exclusively via WebSocket cache injection.
// Polling was removed in favor of a single HTTP fetch on mount.

/** Minimum live feed height in pixels (resize handle lower bound). */
export const FEED_MIN_HEIGHT = 120;

/** Maximum live feed height in pixels (resize handle upper bound). */
export const FEED_MAX_HEIGHT = 600;

/** Default live feed height in pixels. */
export const FEED_DEFAULT_HEIGHT = 240;

/** LocalStorage key for persisting feed height across sessions. */
export const FEED_HEIGHT_STORAGE_KEY = "flightdeck-feed-height";

/** LocalStorage key for persisting theme preference. */
export const THEME_STORAGE_KEY = "flightdeck-theme";

/** Width of the left panel in fleet view (sidebar + flavor/session info). */
export const LEFT_PANEL_WIDTH = 240;

/** LocalStorage key for live feed column widths. */
export const FEED_COL_WIDTHS_KEY = "flightdeck-feed-col-widths";

/** Default live feed column widths in pixels. */
export const FEED_COL_DEFAULTS = {
  flavor: 120,
  session: 80,
  type: 96,
  detail: 400,
  time: 80,
} as const;

/**
 * Base width of the timeline event-circles area at the 1m time range.
 *
 * Wider time ranges multiply this width so the pixel-per-second
 * density stays constant -- a 1h range gets 60x this width and
 * scrolls horizontally inside the right panel. See timelineWidthFor.
 */
export const TIMELINE_BASE_WIDTH_PX = 900;

/** Reference range used to scale TIMELINE_BASE_WIDTH_PX. */
export const TIMELINE_BASE_RANGE_MS = 60_000;

/**
 * Map from human-readable time range to absolute milliseconds. The
 * Timeline component uses this to compute both the D3 time scale
 * domain and the proportional timelineWidth.
 */
export const TIMELINE_RANGE_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
};

/**
 * Compute the timeline event-circles area width for a given range key.
 *
 * Returns TIMELINE_BASE_WIDTH_PX for "1m" and scales linearly with
 * the range duration so events stay readable at every zoom level:
 *
 *   1m  →    900px
 *   5m  →  4,500px
 *   15m → 13,500px
 *   30m → 27,000px
 *   1h  → 54,000px
 *   6h  → 324,000px
 */
export function timelineWidthFor(range: string): number {
  const ms = TIMELINE_RANGE_MS[range] ?? TIMELINE_BASE_RANGE_MS;
  return Math.round(TIMELINE_BASE_WIDTH_PX * (ms / TIMELINE_BASE_RANGE_MS));
}
