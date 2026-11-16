import { useSyncExternalStore } from "react";

// The run (and, from a Live feed row, the event) the pointer is on in the
// per-agent swimlane modal, which lights that run's lane and its feed
// rows. It lives outside React state, one per modal, like
// lib/lane-viewport.ts: each lane and each feed row reads whether it is
// lit, so a pointer move re-renders only the lanes and rows that light
// or go out, not the modal, its Timeline or the rest of the feed.

export interface RunLinkSnapshot {
  /** The lit run's session id, or null. */
  run: string | null;
  /** The lit event (a hovered feed row's), or null. */
  eventId: string | null;
}

export interface RunLink {
  get(): RunLinkSnapshot;
  /** Light ``run`` (and ``eventId``); readers hear of a change only. */
  set(run: string | null, eventId?: string | null): void;
  subscribe(listener: () => void): () => void;
}

const NONE: RunLinkSnapshot = { run: null, eventId: null };

export function createRunLink(): RunLink {
  let snapshot = NONE;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(run, eventId = null) {
      const next = run === null ? NONE : { run, eventId };
      if (next.run === snapshot.run && next.eventId === snapshot.eventId) return;
      snapshot = next;
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

/** Whether ``run`` is lit; the caller re-renders only when that flips.
 *  False without a link (the Fleet page's feed). */
export function useRunLit(link: RunLink | undefined, run: string): boolean {
  return useSyncExternalStore(
    link ? link.subscribe : NO_SUBSCRIPTION,
    () => (link ? link.get().run === run : false),
    () => false,
  );
}

/** The event lit on ``run`` (a hovered feed row's), or null; the caller
 *  re-renders only when that changes. */
export function useRunLitEvent(link: RunLink | undefined, run: string): string | null {
  return useSyncExternalStore(
    link ? link.subscribe : NO_SUBSCRIPTION,
    () => {
      if (!link) return null;
      const { run: lit, eventId } = link.get();
      return lit === run ? eventId : null;
    },
    () => null,
  );
}
