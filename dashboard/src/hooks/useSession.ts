import { useState, useEffect } from "react";
import { fetchSession } from "@/lib/api";
import type { SessionDetail } from "@/lib/types";

/**
 * Fetch session detail (metadata + events) on mount.
 */
export function useSession(sessionId: string | null) {
  const [data, setData] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchSession(sessionId)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  return { data, loading, error };
}
