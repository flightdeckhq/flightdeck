import { create } from "zustand";
import type { FlavorSummary, Session, FleetUpdate } from "@/lib/types";
import { fetchFleet } from "@/lib/api";

interface FleetState {
  flavors: FlavorSummary[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;

  load: () => Promise<void>;
  applyUpdate: (update: FleetUpdate) => void;
  selectSession: (id: string | null) => void;
}

export const useFleetStore = create<FleetState>((set, get) => ({
  flavors: [],
  loading: false,
  error: null,
  selectedSessionId: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await fetchFleet();
      set({ flavors: data.flavors, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  applyUpdate: (update: FleetUpdate) => {
    const { flavors } = get();
    const updated = applySessionUpdate(flavors, update.session);
    set({ flavors: updated });
  },

  selectSession: (id) => set({ selectedSessionId: id }),
}));

function applySessionUpdate(
  flavors: FlavorSummary[],
  session: Session
): FlavorSummary[] {
  return flavors.map((f) => {
    if (f.flavor !== session.flavor) return f;
    const sessions = f.sessions.map((s) =>
      s.session_id === session.session_id ? session : s
    );
    // If session is new, add it
    if (!sessions.some((s) => s.session_id === session.session_id)) {
      sessions.unshift(session);
    }
    return {
      ...f,
      sessions,
      session_count: sessions.length,
      active_count: sessions.filter((s) => s.state === "active").length,
      tokens_used_total: sessions.reduce((sum, s) => sum + s.tokens_used, 0),
    };
  });
}
