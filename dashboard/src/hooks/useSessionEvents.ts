import { useEffect, useState, useMemo } from "react";
import { fetchSession } from "@/lib/api";
import type { AgentEvent } from "@/lib/types";

// Module-level cache: sessionId → events array.
// Exported so Fleet.tsx can inject WebSocket events directly.
export const eventsCache = new Map<string, AgentEvent[]>();

// Track which sessions have been fetched to prevent duplicate requests.
// Once a session is in this set, it will NEVER be fetched again.
const fetchedSessions = new Set<string>();

/**
 * Reads events for a session from eventsCache.
 * Fetches via HTTP exactly ONCE on first access if cache is empty.
 * After that, all updates come from WebSocket injection (version prop).
 */
export function useSessionEvents(sessionId: string, _isActive = false, version = 0) {
  const [, setTick] = useState(0);

  // Read from cache — re-reads when version changes
  const events = useMemo(
    () => eventsCache.get(sessionId) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, version]
  );

  // Fetch exactly once per session if not in cache
  useEffect(() => {
    if (fetchedSessions.has(sessionId)) return;
    if (eventsCache.has(sessionId) && eventsCache.get(sessionId)!.length > 0) {
      fetchedSessions.add(sessionId);
      return;
    }

    fetchedSessions.add(sessionId); // mark BEFORE fetch to prevent duplicates

    fetchSession(sessionId)
      .then((detail) => {
        const evts = detail.events ?? [];
        if (evts.length > 0) {
          eventsCache.set(sessionId, evts);
          setTick((t) => t + 1); // force re-read from cache
        }
      })
      .catch(() => {
        // On error, allow retry next mount
        fetchedSessions.delete(sessionId);
      });
  }, [sessionId]);

  return { events, loading: events.length === 0 && !fetchedSessions.has(sessionId) };
}
