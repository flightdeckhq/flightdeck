import { useSyncExternalStore } from "react";

// The horizontal part of the per-agent modal's scroll viewport that the
// run lanes read: its width and its horizontal scroll. It lives outside
// React state, so a sideways scroll re-renders only the lanes, which
// place their marker text in the visible part, and not the modal, its
// header, its Timeline or its Live feed.

export interface LaneViewportSnapshot {
  /** The viewport's client width. */
  width: number;
  /** Its horizontal scroll. */
  scrollLeft: number;
}

export interface LaneViewport {
  get(): LaneViewportSnapshot | null;
  /** Record a new size or scroll; readers hear of a change only. */
  set(next: LaneViewportSnapshot): void;
  subscribe(listener: () => void): () => void;
}

export function createLaneViewport(): LaneViewport {
  let snapshot: LaneViewportSnapshot | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(next) {
      if (snapshot && snapshot.width === next.width && snapshot.scrollLeft === next.scrollLeft) return;
      snapshot = { width: next.width, scrollLeft: next.scrollLeft };
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const NO_SUBSCRIPTION = () => () => {};
const NO_SNAPSHOT = () => null;

/** The viewport's latest width and scroll, or null without a viewport
 *  (or before the first read); the caller re-renders on each change. */
export function useLaneViewport(viewport: LaneViewport | undefined): LaneViewportSnapshot | null {
  return useSyncExternalStore(
    viewport ? viewport.subscribe : NO_SUBSCRIPTION,
    viewport ? viewport.get : NO_SNAPSHOT,
    viewport ? viewport.get : NO_SNAPSHOT,
  );
}
