import { useSyncExternalStore } from "react";

// A counter of writes to the dashboard's events cache (``eventsCache``
// in hooks/useSessionEvents.ts), for views that derive something from
// several runs' cached events at once. A swimlane row reads every one
// of its runs' session_start / session_end events to find where each
// run's segments start and end; a run's own history fetch lands in the
// cache without passing through the row, so the row subscribes here to
// learn of it.

let epoch = 0;
let notifyQueued = false;
const listeners = new Set<() => void>();

/** Record a write to the events cache. Subscribers hear of it once per
 *  task, after the writer's own code has run, so a burst of writes (a
 *  history page filling many runs) costs one re-render. */
export function bumpEventsCacheEpoch(): void {
  epoch += 1;
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of [...listeners]) listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getEpoch(): number {
  return epoch;
}

/** The events cache's write count; a component that calls this
 *  re-renders after every batch of writes. */
export function useEventsCacheEpoch(): number {
  return useSyncExternalStore(subscribe, getEpoch, getEpoch);
}

/** A ``Map`` that records every change to it with
 *  ``bumpEventsCacheEpoch``. */
export class EventsCacheMap<K, V> extends Map<K, V> {
  override set(key: K, value: V): this {
    super.set(key, value);
    bumpEventsCacheEpoch();
    return this;
  }

  override delete(key: K): boolean {
    const removed = super.delete(key);
    if (removed) bumpEventsCacheEpoch();
    return removed;
  }

  override clear(): void {
    if (this.size === 0) return;
    super.clear();
    bumpEventsCacheEpoch();
  }
}
