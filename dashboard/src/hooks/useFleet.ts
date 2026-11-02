import { useEffect, useCallback, useMemo, useRef } from "react";
import { useFleetStore } from "@/store/fleet";
import { INITIAL_BACKOFF_MS, useWebSocket } from "./useWebSocket";
import { wsAccessTokenQuery } from "@/lib/api";
import { isKeepaliveWsDisabled } from "@/lib/runtime-config";
import type { FleetUpdate, AgentEvent } from "@/lib/types";

// Read the localStorage flag ONCE at module import. Playwright
// writes the flag via its per-project storageState before the
// first page navigation, so the value is stable for the lifetime
// of the tab. Reading on every render would do a synchronous DOM
// access (cheap but not free) for a value that never changes.
const KEEPALIVE_WS_DISABLED = isKeepaliveWsDisabled();

/** How long after the live stream reconnects the page waits before
 *  refetching what it missed. A socket that opens and drops again (an
 *  API that is still restarting) reopens one backoff step later, since
 *  the backoff starts over after every open; at twice that step, each
 *  reopen restarts the wait and the burst costs one refetch, and the
 *  page still catches up two seconds after the stream is back. */
export const RESYNC_DELAY_MS = 2 * INITIAL_BACKOFF_MS;

// Browsers cannot attach an Authorization header to the WebSocket
// upgrade handshake, so the server accepts the bearer access token
// via ?token=. The token resolves at hook-mount time (not module-
// import time) so a localStorage override set by the operator is
// picked up; the previous module-level const captured the default
// at import and ignored every subsequent localStorage write.
const WS_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL ?? "").replace(/^http/, "ws") +
  "/api/v1/stream";

/**
 * Load fleet state via REST, then keep it live via WebSocket.
 * onEvent callback fires when a new event arrives via WebSocket.
 */
export function useFleet(onEvent?: (event: AgentEvent) => void) {
  // Per-field selectors so a fleet-store mutation
  // that does not change one of the consumed fields skips this
  // hook's downstream consumers (and thus their re-render).
  const load = useFleetStore((s) => s.load);
  const applyUpdate = useFleetStore((s) => s.applyUpdate);
  const setLastEvent = useFleetStore((s) => s.setLastEvent);
  const noteSessionChange = useFleetStore((s) => s.noteSessionChange);
  const resync = useFleetStore((s) => s.resync);
  const flavors = useFleetStore((s) => s.flavors);
  const loading = useFleetStore((s) => s.loading);
  const error = useFleetStore((s) => s.error);

  useEffect(() => {
    void load();
  }, [load]);

  const handleMessage = useCallback(
    (data: string) => {
      try {
        const update = JSON.parse(data) as FleetUpdate;
        // A run the page does not show still matters to a run drawer
        // open on it, so its state is recorded before anything else.
        let shown = true;
        if (update.session) {
          noteSessionChange(update.session);
          shown = applyUpdate(update);
        }
        if (update.last_event && shown) {
          // Broadcast the event into the fleet store
          // so subscribers (SessionDrawer's mcp_server_attached
          // re-fetch trigger) react regardless of whether the
          // envelope carries a session diff. The event of a run the
          // page does not show (the reaper's close of a run it never
          // loaded) goes to neither the store nor the live feed.
          setLastEvent(update.last_event);
          if (onEvent) onEvent(update.last_event);
        }
      } catch {
        // Ignore malformed messages
      }
    },
    [applyUpdate, noteSessionChange, setLastEvent, onEvent]
  );

  // Broadcasts sent while the stream was down are gone: once it is
  // back, refetch the fleet as the first load does (and let open views
  // holding their own fetch refetch), at most once per reconnect burst.
  const resyncTimer = useRef<number | undefined>(undefined);
  const handleReconnect = useCallback(() => {
    window.clearTimeout(resyncTimer.current);
    resyncTimer.current = window.setTimeout(resync, RESYNC_DELAY_MS);
  }, [resync]);
  useEffect(() => () => window.clearTimeout(resyncTimer.current), []);

  // useMemo so the URL string is stable across renders (the
  // useWebSocket hook compares the URL by reference to decide
  // whether to reconnect). Recomputed only when the underlying
  // localStorage token changes between mounts — which is the
  // intended invalidation path.
  //
  // Keep-alive WS disable flag: when E2E suites set the
  // ``flightdeck-disable-keepalive-ws`` localStorage flag, the WS
  // subscription is skipped entirely. The dashboard renders its
  // initial state from the REST ``/v1/fleet`` + ``/v1/sessions``
  // fetches and stays static for the rest of the page session.
  // This prevents periodic fixture-refresh events from the test
  // harness's keep-alive watchdog (Playwright globalSetup) from
  // perturbing IntersectionObserver virtualization and sidebar
  // pagination under parallel-worker load. Production never sets
  // the flag.
  const wsUrl = useMemo(
    () =>
      KEEPALIVE_WS_DISABLED
        ? null
        : `${WS_BASE_URL}?${wsAccessTokenQuery()}`,
    [],
  );
  useWebSocket(wsUrl, handleMessage, handleReconnect);

  return { flavors, loading, error };
}
