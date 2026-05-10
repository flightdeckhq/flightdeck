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


/**
 * Width constants for the resizable left panel (flavor labels +
 * session rows) in the Timeline component. The panel state lives in
 * Timeline.tsx's useState with localStorage persistence keyed by
 * LEFT_PANEL_WIDTH_KEY. Min/max are enforced on both initial load
 * and drag. DEFAULT is sized to fit typical 14-char hostnames like
 * "mac-laptop-bob" or "compose-build-2" in the session row label
 * slot without truncation (session number + icons + badge + tokens
 * leave roughly 158px for the label at 320px). Users who drag it
 * narrower or wider get their choice persisted.
 */
export const LEFT_PANEL_MIN_WIDTH = 200;
export const LEFT_PANEL_MAX_WIDTH = 500;
export const LEFT_PANEL_DEFAULT_WIDTH = 320;
export const LEFT_PANEL_WIDTH_KEY = "flightdeck-left-panel-width";

/**
 * Session row height in pixels. Rows now show a primary hostname
 * label on the top line and a muted session hash on the bottom line
 * when the session has runtime context, so 40px was too tight. 48px
 * fits both lines with clean vertical centring. SwimLane uses this
 * when computing the expanded section maxHeight so the animation
 * stays in sync with actual row sizes.
 */
export const SESSION_ROW_HEIGHT = 48;

/**
 * Diameter in pixels of every event circle in the swimlane. Used by
 * SessionEventRow (expanded session rows), AggregatedSessionEvents
 * (collapsed flavor rows and the ALL row) -- everything. Previously
 * split between 20px on aggregated rows and 24px on session rows,
 * which looked jarring when a flavor was expanded and the two sizes
 * sat directly above and below each other. 22px is the midpoint and
 * stays above EventNode's icon-size threshold (<=20 → 11px, else
 * 13px) so icon legibility matches the old 24px circles.
 */
export const EVENT_CIRCLE_SIZE = 22;

/** LocalStorage key for live feed column widths. */
export const FEED_COL_WIDTHS_KEY = "flightdeck-feed-col-widths";

/**
 * Fleet left sidebar resize constants. The sidebar is draggable on
 * its right edge, clamped to [MIN, MAX] on both init and drag, and
 * defaults to DEFAULT_WIDTH when localStorage is empty or corrupt.
 *
 * PILL_HIDE_MIN_WIDTH is a defensive floor for the CODING AGENT /
 * DEV pills in each FlavorItem. The primary narrow-width strategy
 * is flex-shrink + text-overflow:ellipsis on the pill itself so the
 * agent name stays fully rendered and the pill truncates character-
 * by-character as the sidebar narrows. The hard floor kicks in only
 * at widths so narrow even "C..." would be noise. 150 is below the
 * sidebar MIN (180) so in normal operation the gate is always true
 * and pills render with ellipsis; the constant documents intent and
 * guards against future sidebar MIN lowering.
 */
export const FLEET_SIDEBAR_MIN_WIDTH = 180;
export const FLEET_SIDEBAR_MAX_WIDTH = 600;
export const FLEET_SIDEBAR_DEFAULT_WIDTH = 240;
export const FLEET_SIDEBAR_WIDTH_KEY = "flightdeck.fleet.sidebarWidth";
export const FLEET_PILL_HIDE_MIN_WIDTH = 150;

/**
 * Investigate left-sidebar resize bounds and persistence key.
 * Mirrors the Fleet sidebar pattern (lazy-init from localStorage,
 * clamp to [MIN, MAX], persist on drag-release). The MAX is a
 * fraction of the viewport rather than an absolute pixel cap so
 * the sidebar can never eat the session table even on a 4K
 * monitor — see clampInvestigateSidebarWidth in
 * lib/investigate-sidebar-width.ts. ``MIN_WIDTH`` of 180 is the
 * narrowest layout that still fits the "STATE" facet header
 * comfortably with at least one pill on a line; ``DEFAULT_WIDTH``
 * of 260 leaves room for a typical agent_name pill on one line
 * without truncation. Phase 4.5.
 */
export const INVESTIGATE_SIDEBAR_MIN_WIDTH = 180;
export const INVESTIGATE_SIDEBAR_MAX_VIEWPORT_FRACTION = 0.4;
export const INVESTIGATE_SIDEBAR_DEFAULT_WIDTH = 260;
export const INVESTIGATE_SIDEBAR_WIDTH_KEY =
  "flightdeck.investigate.sidebarWidth";

/**
 * LocalStorage key for the "Show MCP discovery events" toggle in the
 * Fleet event filter bar. Default off (D122) — the three MCP
 * discovery event types (``mcp_tool_list`` / ``mcp_resource_list`` /
 * ``mcp_prompt_list``) are hidden from Fleet's LiveFeed and dimmed
 * in the swimlane when this preference is unset or false. Per the
 * established naming convention (``flightdeck.<surface>.<pref>``).
 */
export const FEED_SHOW_DISCOVERY_EVENTS_KEY =
  "flightdeck.feed.showDiscoveryEvents";

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

/**
 * Default lookback window for the Investigate page on first
 * mount. Phase 4.5 L-20: previously hardcoded as ``7 * 24 * 3600
 * * 1000`` in two places (Investigate.tsx and AgentTable.tsx)
 * which let the two surfaces drift if either was tweaked. This
 * constant is the single source of truth.
 */
export const INVESTIGATE_DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Display duration for ephemeral success / completion toasts and
 * inline acknowledgements (DirectiveCard "Saved", FleetPanel
 * "Stopping...", SessionDrawer "Acknowledged", Settings "Token
 * created"). Phase 4.5 L-21: extracted from four scattered inline
 * ``setTimeout(..., 2000)`` calls so a UX tuning that wants 1500
 * or 3000 ms changes ONE place.
 */
export const SUCCESS_MESSAGE_DISPLAY_MS = 2000;

/**
 * Width in pixels of the linear-gradient fade overlays at the left
 * and right edges of the Fleet swimlane scroll container (S-SWIM).
 * 32px is wide enough that the gradient reads as a soft transition
 * (not a hard edge) on a high-DPI display, and narrow enough that
 * it covers ≤4% of the timeline canvas (900 px) at default sizing
 * so it never visually amputates an event circle near the boundary.
 * Smaller values (16-20 px) feel like a stripe; larger (>48 px)
 * start eating real content.
 */
export const SWIM_FADE_WIDTH_PX = 32;

/**
 * Fraction of the swimlane scroll container's clientWidth that an
 * ArrowLeft / ArrowRight keypress scrolls. 0.5 (half-page) matches
 * the convention browser scrollbars use for PageUp/PageDown and
 * gives the user a predictable, large-enough step that two presses
 * traverse most narrow-viewport overflow without being so big that
 * a single press blows past the destination. scrollBy is called
 * with behavior:"smooth" so the visual lands cleanly.
 */
export const SWIM_KEYBOARD_SCROLL_FRACTION = 0.5;
