import {
  INVESTIGATE_SIDEBAR_DEFAULT_WIDTH,
  INVESTIGATE_SIDEBAR_MAX_VIEWPORT_FRACTION,
  INVESTIGATE_SIDEBAR_MIN_WIDTH,
  INVESTIGATE_SIDEBAR_WIDTH_KEY,
} from "@/lib/constants";

/**
 * Clamp a candidate sidebar width into the valid [MIN, MAX] range.
 * MAX is a fraction of the supplied viewport width so the sidebar
 * cannot eat the session table on any screen size; supplying a
 * non-positive viewport falls back to a generous absolute cap so
 * the helper still returns something usable in test environments
 * that don't render a real window.
 */
export function clampInvestigateSidebarWidth(
  candidate: number,
  viewportWidth: number,
): number {
  const cap =
    viewportWidth > 0
      ? Math.floor(viewportWidth * INVESTIGATE_SIDEBAR_MAX_VIEWPORT_FRACTION)
      : 800;
  if (Number.isNaN(candidate)) return INVESTIGATE_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(cap, Math.max(INVESTIGATE_SIDEBAR_MIN_WIDTH, candidate));
}

/**
 * Lazy-init the sidebar width on Investigate mount: read the
 * persisted value, clamp into range, fall back to the default on
 * missing / invalid / storage-unavailable. Centralised so the
 * page component stays focused on rendering and the unit test can
 * round-trip the localStorage contract independently.
 */
export function readPersistedInvestigateSidebarWidth(
  viewportWidth: number,
): number {
  try {
    const raw = localStorage.getItem(INVESTIGATE_SIDEBAR_WIDTH_KEY);
    if (raw == null) return INVESTIGATE_SIDEBAR_DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return INVESTIGATE_SIDEBAR_DEFAULT_WIDTH;
    return clampInvestigateSidebarWidth(n, viewportWidth);
  } catch {
    return INVESTIGATE_SIDEBAR_DEFAULT_WIDTH;
  }
}

/** Best-effort write; silently no-op if storage is unavailable. */
export function persistInvestigateSidebarWidth(width: number): void {
  try {
    localStorage.setItem(INVESTIGATE_SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* storage unavailable — width applies for this session only */
  }
}
