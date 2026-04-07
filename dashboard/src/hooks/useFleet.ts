import { useEffect, useCallback } from "react";
import { useFleetStore } from "@/store/fleet";
import { useWebSocket } from "./useWebSocket";
import type { FleetUpdate } from "@/lib/types";

const WS_URL =
  (import.meta.env.VITE_API_BASE_URL ?? "").replace(/^http/, "ws") +
  "/api/v1/stream";

/**
 * Load fleet state via REST, then keep it live via WebSocket.
 */
export function useFleet() {
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
      } catch {
        // Ignore malformed messages
      }
    },
    [applyUpdate]
  );

  useWebSocket(WS_URL, handleMessage);

  return { flavors, loading, error };
}
