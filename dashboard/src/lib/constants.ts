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
 * Fixed width of the timeline event-circles area.
 *
 * Every range (1m / 5m / 15m / 30m / 1h) renders to the same 900px
 * canvas. The xScale maps [now - rangeMs, now] to [0, 900], so wider
 * ranges produce denser circles. This is the correct trade-off:
 * fixed pixel space, no horizontal scrollbar, label intervals adapt
 * to the range. The previous proportional-width approach grew the
 * canvas to 54,000px at 1h and 324,000px at 6h, which forced
 * horizontal scroll, broke sticky-left layouts, and made historical
 * views unusable.
 */
export const TIMELINE_WIDTH_PX = 900;

/**
 * Map from human-readable time range to absolute milliseconds. The
 * Timeline component uses this to compute the d3 time scale domain
 * and to format the relative-time axis labels.
 */
export const TIMELINE_RANGE_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
};
