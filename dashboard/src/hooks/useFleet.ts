import { useEffect, useCallback } from "react";
import { useFleetStore } from "@/store/fleet";
import { useWebSocket } from "./useWebSocket";
import { WS_TOKEN_QUERY } from "@/lib/api";
import type { FleetUpdate, AgentEvent } from "@/lib/types";

// D095: browsers cannot attach an Authorization header to the
// WebSocket upgrade handshake, so the server accepts the bearer
// token via ?token=. Part 1b hardcodes tok_dev; Part 2's Settings
// page will replace WS_TOKEN_QUERY with a dynamic value.
const WS_URL =
  (import.meta.env.VITE_API_BASE_URL ?? "").replace(/^http/, "ws") +
  "/api/v1/stream?" + WS_TOKEN_QUERY;

/**
 * Load fleet state via REST, then keep it live via WebSocket.
 * onEvent callback fires when a new event arrives via WebSocket.
 */
export function useFleet(onEvent?: (event: AgentEvent) => void) {
  const { load, applyUpdate, flavors, loading, error } = useFleetStore();

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
        if (update.last_event && onEvent) {
          onEvent(update.last_event);
        }
      } catch {
        // Ignore malformed messages
      }
    },
    [applyUpdate, onEvent]
  );

  useWebSocket(WS_URL, handleMessage);

  return { flavors, loading, error };
}
