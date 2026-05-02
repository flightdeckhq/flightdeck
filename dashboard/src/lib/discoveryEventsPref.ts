import { useEffect, useState } from "react";
import { FEED_SHOW_DISCOVERY_EVENTS_KEY } from "@/lib/constants";

/**
 * Same-tab subscriber CustomEvent for the
 * ``flightdeck.feed.showDiscoveryEvents`` preference. Mirrors the
 * pattern used by ``leftPanelWidth.ts`` — the browser's native
 * ``storage`` event only fires on cross-tab writes, so a same-tab
 * toggle in EventFilterBar would never reach LiveFeed and SwimLane
 * (both of which mount independently under Fleet) without an
 * explicit dispatch. The event payload is the new boolean state.
 */
const CHANGE_EVENT = "flightdeck:feed-show-discovery-events";

/**
 * Read the persisted "Show MCP discovery events" preference from
 * localStorage. Default off (D122). Falls back to false on missing
 * key, invalid value, or storage being unavailable. Only the literal
 * strings ``"true"`` / ``"false"`` are valid; anything else is treated
 * as missing so a future reader stays robust against legacy or
 * partially-written values.
 */
export function readShowDiscoveryEvents(): boolean {
  try {
    const stored = localStorage.getItem(FEED_SHOW_DISCOVERY_EVENTS_KEY);
    if (stored === "true") return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Persist the "Show MCP discovery events" preference and notify
 * same-tab subscribers via a CustomEvent. Two consumers (LiveFeed
 * and SwimLane) live under Fleet and both need to react to a toggle
 * fired from EventFilterBar; without the dispatch, only the toggle
 * component itself would re-render.
 */
export function persistShowDiscoveryEvents(value: boolean): void {
  try {
    localStorage.setItem(FEED_SHOW_DISCOVERY_EVENTS_KEY, String(value));
  } catch {
    /* storage unavailable -- subscribers still receive the event */
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(CHANGE_EVENT, { detail: value }),
  );
}

/**
 * Subscribe to the persisted "Show MCP discovery events" preference.
 * Returns ``[shown, setShown]`` so the consumer can both read the
 * current state and update it. Setting the value writes through to
 * localStorage and notifies every other subscriber in the same tab,
 * so LiveFeed and SwimLane stay in sync regardless of which one
 * triggered the change.
 *
 * Off by default per D122 — the discovery event types are useful for
 * audit but visually crowd the live feed on MCP-heavy sessions.
 */
export function useShowDiscoveryEvents(): [
  shown: boolean,
  setShown: (value: boolean) => void,
] {
  const [shown, setShownState] = useState<boolean>(readShowDiscoveryEvents);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setShownState(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  const setShown = (value: boolean) => {
    persistShowDiscoveryEvents(value);
  };
  return [shown, setShown];
}
