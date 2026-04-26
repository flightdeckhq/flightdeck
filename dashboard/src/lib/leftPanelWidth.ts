import { useEffect, useState } from "react";
import {
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_WIDTH_KEY,
} from "@/lib/constants";

const CHANGE_EVENT = "flightdeck:left-panel-width";

const clamp = (n: number) =>
  Math.min(LEFT_PANEL_MAX_WIDTH, Math.max(LEFT_PANEL_MIN_WIDTH, n));

/**
 * Read the persisted left-panel width from localStorage, clamped
 * to [LEFT_PANEL_MIN_WIDTH, LEFT_PANEL_MAX_WIDTH]. Falls back to
 * LEFT_PANEL_DEFAULT_WIDTH when missing, NaN, or storage is
 * unavailable.
 */
export function readPersistedLeftPanelWidth(): number {
  try {
    const stored = localStorage.getItem(LEFT_PANEL_WIDTH_KEY);
    if (!stored) return LEFT_PANEL_DEFAULT_WIDTH;
    const n = parseInt(stored, 10);
    if (Number.isNaN(n)) return LEFT_PANEL_DEFAULT_WIDTH;
    return clamp(n);
  } catch {
    return LEFT_PANEL_DEFAULT_WIDTH;
  }
}

/**
 * Persist the left-panel width and notify same-tab subscribers.
 * The browser's native ``storage`` event only fires on cross-tab
 * writes, so a same-tab drag in Timeline.tsx would never reach
 * Fleet.tsx's fade-offset state without the explicit CustomEvent
 * dispatch. The event payload is the post-clamp width so
 * subscribers don't need to clamp again.
 */
export function persistLeftPanelWidth(width: number): void {
  const clamped = clamp(width);
  try {
    localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(clamped));
  } catch {
    /* storage unavailable -- subscribers still receive the event */
  }
  window.dispatchEvent(
    new CustomEvent<number>(CHANGE_EVENT, { detail: clamped }),
  );
}

/**
 * Subscribe to the persisted left-panel width. Initialises from
 * localStorage and stays in sync with persistLeftPanelWidth()
 * calls elsewhere in the app via a window CustomEvent. Used by
 * Fleet.tsx so the swimlane left-fade overlay tracks the column's
 * right edge when the user drags the resize handle in Timeline.
 */
export function useLeftPanelWidth(): number {
  const [width, setWidth] = useState<number>(readPersistedLeftPanelWidth);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      if (typeof detail === "number") setWidth(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  return width;
}
