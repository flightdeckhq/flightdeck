import { create } from "zustand";
import type {
  CustomDirective,
  FlavorSummary,
  Session,
  FleetUpdate,
} from "@/lib/types";
import type { ContextFacets } from "@/types/context";
import { fetchCustomDirectives, fetchFleet } from "@/lib/api";

export type AgentTypeFilter = "all" | "production" | "developer";

interface FleetState {
  flavors: FlavorSummary[];
  /** Context facets aggregated by the API across all non-terminal sessions. */
  contextFacets: ContextFacets;
  /**
   * All custom directives registered in the fleet, flat list. The
   * drawer and per-flavor trigger UI filter this client-side by
   * flavor so we only fetch once per fleet load. Empty array until
   * the first load() resolves.
   */
  customDirectives: CustomDirective[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  agentTypeFilter: AgentTypeFilter;
  flavorFilter: string | null;

  load: (agentType?: AgentTypeFilter) => Promise<void>;
  setAgentTypeFilter: (filter: AgentTypeFilter) => void;
  setFlavorFilter: (flavor: string | null) => void;
  applyUpdate: (update: FleetUpdate) => void;
  selectSession: (id: string | null) => void;
}

export const useFleetStore = create<FleetState>((set, get) => ({
  flavors: [],
  contextFacets: {},
  customDirectives: [],
  loading: false,
  error: null,
  selectedSessionId: null,
  agentTypeFilter: "all",
  flavorFilter: null,

  load: async (agentType?: AgentTypeFilter) => {
    const filter = agentType ?? get().agentTypeFilter;
    set({ loading: true, error: null });
    try {
      const apiFilter = filter === "all" ? undefined : filter;
      // Fetch fleet state and custom directives in parallel. The
      // directive fetch is best-effort -- if it fails we surface
      // an empty array rather than blocking the fleet view.
      const [fleet, directives] = await Promise.all([
        fetchFleet(50, 0, apiFilter),
        fetchCustomDirectives().catch(() => [] as CustomDirective[]),
      ]);
      set({
        flavors: fleet.flavors,
        contextFacets: fleet.context_facets ?? {},
        customDirectives: directives,
        loading: false,
      });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  setAgentTypeFilter: (filter: AgentTypeFilter) => {
    set({ agentTypeFilter: filter });
    get().load(filter);
  },

  setFlavorFilter: (flavor: string | null) => {
    set({ flavorFilter: flavor });
  },

  applyUpdate: (update: FleetUpdate) => {
    const { flavors } = get();
    // Snapshot whether this flavor was already in the store BEFORE
    // we mutate flavors. A new flavor appearing via session_start is
    // a strong signal that the agent just called sensor.init() and
    // may have registered new custom directives -- the dashboard
    // would otherwise miss them until a hard refresh.
    const isNewFlavor = !flavors.some((f) => f.flavor === update.session.flavor);
    const updated = applySessionUpdate(flavors, update.session);
    set({ flavors: updated });

    if (update.type === "session_start" && isNewFlavor) {
      // Best-effort: refetch the directive registry. The new
      // FlavorItem will pick it up automatically because the
      // FleetPanel reads customDirectives from the store via a
      // useFleetStore selector. Failures are swallowed so a
      // transient API blip never blocks WebSocket processing.
      fetchCustomDirectives()
        .then((directives) => set({ customDirectives: directives }))
        .catch(() => {
          /* directive refresh is best-effort */
        });
    }
  },

  selectSession: (id) => set({ selectedSessionId: id }),
}));

function applySessionUpdate(
  flavors: FlavorSummary[],
  session: Session
): FlavorSummary[] {
  const flavorExists = flavors.some((f) => f.flavor === session.flavor);

  if (!flavorExists) {
    // New flavor not present at initial load — create a new entry
    return [
      ...flavors,
      {
        flavor: session.flavor,
        agent_type: session.agent_type,
        session_count: 1,
        active_count: session.state === "active" ? 1 : 0,
        tokens_used_total: session.tokens_used,
        sessions: [session],
      },
    ];
  }

  return flavors.map((f) => {
    if (f.flavor !== session.flavor) return f;
    const sessions = f.sessions.map((s) =>
      s.session_id === session.session_id ? session : s
    );
    // If session is new within existing flavor, add it
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
