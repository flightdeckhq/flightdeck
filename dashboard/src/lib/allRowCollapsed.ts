import { useEffect, useState } from "react";
import { ALL_ROW_COLLAPSED_KEY } from "@/lib/constants";

const CHANGE_EVENT = "flightdeck:all-row-collapsed";

const ALL_ROW_DEFAULT_COLLAPSED = true;

/**
 * Read the persisted ALL-row collapse state from localStorage.
 * Falls back to ALL_ROW_DEFAULT_COLLAPSED (true) when missing,
 * malformed, or storage is unavailable. Stored as ``"1"``
 * (collapsed) or ``"0"`` (expanded) so the value round-trips
 * cleanly through ``localStorage.getItem`` without JSON parsing.
 */
export function readAllRowCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(ALL_ROW_COLLAPSED_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return ALL_ROW_DEFAULT_COLLAPSED;
  } catch {
    return ALL_ROW_DEFAULT_COLLAPSED;
  }
}

/**
 * Persist the ALL-row collapse state and notify same-tab
 * subscribers via a CustomEvent. The browser's native ``storage``
 * event only fires cross-tab, so a same-tab toggle on the ALL row
 * wouldn't reach any other ``useAllRowCollapsed`` consumer
 * without the explicit dispatch. Mirrors the
 * ``persistLeftPanelWidth`` pattern in ``leftPanelWidth.ts``.
 */
export function persistAllRowCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(ALL_ROW_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* storage unavailable — subscribers still receive the event */
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(CHANGE_EVENT, { detail: collapsed }),
  );
}

/**
 * React hook for the ALL-row collapse state. Initialises from
 * localStorage and stays in sync with ``persistAllRowCollapsed``
 * calls elsewhere in the app via a window CustomEvent. Returns
 * the boolean directly; callers persist via the standalone
 * ``persistAllRowCollapsed(next)`` so a single source of truth
 * (the localStorage key + CustomEvent) drives every subscriber.
 */
export function useAllRowCollapsed(): boolean {
  const [collapsed, setCollapsed] = useState<boolean>(readAllRowCollapsed);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setCollapsed(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  return collapsed;
}
