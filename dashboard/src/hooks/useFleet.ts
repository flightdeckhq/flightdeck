import { useEffect, useCallback, useMemo } from "react";
import { useFleetStore } from "@/store/fleet";
import { useWebSocket } from "./useWebSocket";
import { wsAccessTokenQuery } from "@/lib/api";
import type { FleetUpdate, AgentEvent } from "@/lib/types";

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
  // Phase 4.5 M-18: per-field selectors so a fleet-store mutation
  // that does not change one of the consumed fields skips this
  // hook's downstream consumers (and thus their re-render).
  const load = useFleetStore((s) => s.load);
  const applyUpdate = useFleetStore((s) => s.applyUpdate);
  const setLastEvent = useFleetStore((s) => s.setLastEvent);
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
        if (update.session) {
          applyUpdate(update);
        }
        if (update.last_event) {
          // D140 step 6.6 — broadcast the event into the fleet store
          // so subscribers (SessionDrawer's mcp_server_attached
          // re-fetch trigger) react regardless of whether the
          // envelope carries a session diff.
          setLastEvent(update.last_event);
          if (onEvent) onEvent(update.last_event);
        }
      } catch {
        // Ignore malformed messages
      }
    },
    [applyUpdate, setLastEvent, onEvent]
  );

  // useMemo so the URL string is stable across renders (the
  // useWebSocket hook compares the URL by reference to decide
  // whether to reconnect). Recomputed only when the underlying
  // localStorage token changes between mounts — which is the
  // intended invalidation path.
  const wsUrl = useMemo(
    () => `${WS_BASE_URL}?${wsAccessTokenQuery()}`,
    [],
  );
  useWebSocket(wsUrl, handleMessage);

  return { flavors, loading, error };
}
