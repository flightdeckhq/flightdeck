import { create } from "zustand";
import type {
  AgentEvent,
  AgentSummary,
  CustomDirective,
  FlavorSummary,
  FleetUpdate,
  RecentSession,
  Session,
  SessionListItem,
  SessionState,
} from "@/lib/types";
import type { ContextFacets } from "@/types/context";
import {
  fetchCustomDirectives,
  fetchFleet,
  fetchSessions,
} from "@/lib/api";
import {
  advanceBucketEntry,
  seedBucketEntries,
} from "@/lib/fleet-ordering";

// D114 vocabulary -- ``coding`` or ``production``. ``all`` suppresses
// the filter at the query layer.
export type AgentTypeFilter = "all" | "coding" | "production";

// How far back the Fleet-bootstrap session fetch looks.
//
// 24 hours is the "what did my fleet do today?" window. The FLEET
// OVERVIEW state-count rollup, the swimlane agent-row header counts,
// and the default swimlane event circles all feed from this fetch.
//
// Not to be confused with the Events page's default from-window,
// which is 7 days: the Events page is a history-view (answering
// "what happened in the last week?") while Fleet is a now-view
// (answering "what is running right now / did just run?"). The two
// defaults serve different questions.
//
// See the "last 24h" label in ``FleetPanel.tsx`` that surfaces
// this windowing to the user so the FLEET OVERVIEW counts vs.
// lifetime ``total_sessions`` asymmetry is not mysterious.
const SWIMLANE_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

interface FleetState {
  /** Agent-level rows for the Fleet table view and the sidebar
   *  AGENTS list. Sourced from GET /v1/fleet. */
  agents: AgentSummary[];
  /** Swimlane-shaped rows: one FlavorSummary per agent_id with the
   *  recent sessions under it. Built by load() from the agents
   *  roster + a fetchSessions() window. */
  flavors: FlavorSummary[];
  total: number;
  page: number;
  perPage: number;
  contextFacets: ContextFacets;
  customDirectives: CustomDirective[];
  shuttingDown: Set<string>;
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  agentTypeFilter: AgentTypeFilter;
  flavorFilter: string | null;
  /**
   * When each row last entered its current activity bucket (LIVE /
   * RECENT / IDLE). Keyed by ``agent_id`` so the swimlane (``flavors``
   * keyed on ``agent_id``) and the table (``agents`` keyed on
   * ``agent_id``) share the same map. Seeded on ``load`` from each
   * row's ``last_seen_at``; updated by ``applyUpdate`` only when a
   * row crosses a bucket boundary, so same-bucket events never cause
   * within-bucket reordering. See ``lib/fleet-ordering.ts``.
   */
  enteredBucketAt: Map<string, number>;

  load: (opts?: {
    page?: number;
    perPage?: number;
    agentType?: AgentTypeFilter;
  }) => Promise<void>;
  setAgentTypeFilter: (filter: AgentTypeFilter) => void;
  setFlavorFilter: (flavor: string | null) => void;
  /**
   * Last event received via the fleet WebSocket. Updated on every
   * event-bearing ``FleetUpdate``. Subscribers (e.g.
   * SessionDrawer's D140 mcp_server_attached re-fetch trigger)
   * select this field and useEffect off it. The same instance
   * is shared across all subscribers — a subscriber that wants
   * to filter on event_type / session_id does so in its own
   * useEffect.
   */
  lastEvent: AgentEvent | null;
  /**
   * D140 step 6.6 dispatch — called from useFleet's WS handler
   * for every event-bearing message regardless of whether the
   * envelope carries a session diff. Replaces ``lastEvent`` so
   * SessionDrawer subscribers fire their re-fetch effect.
   */
  setLastEvent: (event: AgentEvent | null) => void;
  applyUpdate: (update: FleetUpdate) => void;
  selectSession: (id: string | null) => void;
  markShuttingDown: (sessionId: string) => void;
  /**
   * Kept for FleetPanel's per-flavor Stop-All button. Under D115 a
   * "flavor" value is usually an agent_id; the helper walks the
   * sessions under that flavor and marks each active/idle one as
   * shutting down client-side so the UI reacts before the next
   * WebSocket update lands.
   */
  markFlavorShuttingDown: (flavor: string) => void;
}

function listItemToSession(li: SessionListItem): Session {
  // Swimlane code consumes ``Session`` (from types.ts), not
  // ``SessionListItem``. The fields overlap except for framework /
  // last_seen_at; we synthesise last_seen_at from ended_at / now so
  // the swimlane's activity sort does not see missing values.
  const now = new Date().toISOString();
  return {
    session_id: li.session_id,
    flavor: li.flavor,
    agent_type: li.agent_type,
    agent_id: li.agent_id ?? null,
    agent_name: li.agent_name ?? null,
    client_type: li.client_type ?? null,
    host: li.host ?? null,
    framework: null,
    model: li.model,
    state: li.state,
    started_at: li.started_at,
    last_seen_at: li.ended_at ?? now,
    ended_at: li.ended_at,
    tokens_used: li.tokens_used,
    token_limit: li.token_limit ? Number(li.token_limit) : null,
    context: (li.context ?? {}) as Record<string, unknown>,
    capture_enabled: li.capture_enabled,
    token_name: li.token_name ?? null,
    // D126 — preserve sub-agent linkage so SwimLane's
    // ``deriveRelationship`` (and any other downstream consumer)
    // can render the relationship pill, the L8 lost-dot, and the
    // SubAgentsTab's parent / child links off the same Session
    // shape that read directly from the session-detail endpoint.
    // Stripping these fields silently drops every sub-agent
    // surface on the swimlane — a step-7.fix gap that surfaced in
    // step 8 when the seeded D126 fixtures rendered without pills.
    parent_session_id: li.parent_session_id ?? null,
    agent_role: li.agent_role ?? null,
  };
}

// ``RecentSession`` (the /v1/fleet embedded rollup) carries a leaner
// column set than ``SessionListItem`` — no context blob, no
// token_name, no per-session enrichment arrays. The swimlane only
// needs the swimlane-row fields (state / started_at / ended_at /
// last_seen_at / tokens / sub-agent linkage) which both shapes
// share. Synthesise ``last_seen_at`` the same way ``listItemToSession``
// does so an unended session sorts as "still recent" without a
// missing-value fallback further downstream.
function recentSessionToSession(r: RecentSession): Session {
  const now = new Date().toISOString();
  return {
    session_id: r.session_id,
    flavor: r.flavor,
    agent_type: r.agent_type,
    agent_id: r.agent_id ?? null,
    agent_name: r.agent_name ?? null,
    client_type: r.client_type ?? null,
    host: r.host ?? null,
    framework: null,
    model: r.model ?? null,
    state: r.state,
    started_at: r.started_at,
    last_seen_at: r.last_seen_at ?? r.ended_at ?? now,
    ended_at: r.ended_at ?? null,
    tokens_used: r.tokens_used,
    token_limit: r.token_limit ?? null,
    context: {},
    capture_enabled: r.capture_enabled,
    token_name: null,
    parent_session_id: r.parent_session_id ?? null,
    agent_role: r.agent_role ?? null,
  };
}

function buildFlavors(
  agents: AgentSummary[],
  recentSessions: SessionListItem[],
): FlavorSummary[] {
  const byAgent = new Map<string, Session[]>();
  for (const li of recentSessions) {
    if (!li.agent_id) continue;
    const bucket = byAgent.get(li.agent_id) ?? [];
    bucket.push(listItemToSession(li));
    byAgent.set(li.agent_id, bucket);
  }
  return agents
    // V-DRAWER companion fix: filter out agent rows whose
    // ``total_sessions`` is zero. These are orphan rows that
    // accumulate from prior test runs (sessions truncated /
    // pruned / never landed) and from production crashes that
    // upserted an agent record before any session_start landed.
    // The swimlane drawer can't drill into them -- expanding the
    // row reads ``"No sessions to display for this agent."`` and
    // becomes a dead-end. Per the supervisor's V-DRAWER design
    // principle ("if an agent is visible in the swimlane, its
    // sessions must always be accessible from there"), agents
    // without any session history don't belong in the swimlane
    // surface at all. They're still queryable via the Investigate
    // page or admin tooling; the swimlane just doesn't list them.
    .filter((a) => a.total_sessions > 0)
    .map((a) => {
      // Merge the embedded /v1/fleet rollup with the paginated
      // /v1/sessions slice. The embedded shape carries this agent's
      // most-recent N sessions regardless of where they fall in the
      // global 100-row sessions page — without it, a sub-agent
      // whose session was upserted hours ago renders an empty
      // swimlane row (no event circles, no spawn anchor for the
      // connector overlay). The paginated slice fills in younger
      // sessions that may not have made the per-agent top-N cut.
      //
      // Merge precedence: paginated wins when both shapes carry the
      // same session_id. The paginated SessionListItem is the
      // richer projection (carries ``context`` and ``token_name``;
      // the lean ``RecentSession`` omits both). Without the
      // preference, the embedded entry would shadow the paginated
      // one and the swimlane label strip's OS / orchestration /
      // provider icons (derived from ``mostRecentSession.context``)
      // would silently disappear for any agent whose session
      // happens to be in both shapes.
      const paginated = byAgent.get(a.agent_id) ?? [];
      const embedded = (a.recent_sessions ?? []).map(recentSessionToSession);
      const merged = new Map<string, Session>();
      for (const s of embedded) merged.set(s.session_id, s);
      for (const s of paginated) merged.set(s.session_id, s);
      const sessions = Array.from(merged.values());
      const active = sessions.filter((s) => s.state === "active").length;
      return {
        // The ``flavor`` field carries the agent_id so swimlane rows
        // key by agent without reshaping every downstream component.
        // The display label reads ``agent_name`` when present.
        flavor: a.agent_id,
        agent_type: a.agent_type,
        session_count: a.total_sessions,
        active_count: active,
        tokens_used_total: Number(a.total_tokens),
        sessions,
        agent_id: a.agent_id,
        agent_name: a.agent_name,
        client_type: a.client_type,
        user: a.user,
        hostname: a.hostname,
        last_seen_at: a.last_seen_at,
      };
    });
}

export const useFleetStore = create<FleetState>((set, get) => ({
  agents: [],
  flavors: [],
  total: 0,
  page: 1,
  perPage: 200,
  contextFacets: {},
  customDirectives: [],
  shuttingDown: new Set<string>(),
  loading: false,
  error: null,
  selectedSessionId: null,
  agentTypeFilter: "all",
  flavorFilter: null,
  lastEvent: null,
  enteredBucketAt: new Map<string, number>(),

  load: async (opts = {}) => {
    const page = opts.page ?? 1;
    const perPage = opts.perPage ?? get().perPage;
    const filter = opts.agentType ?? get().agentTypeFilter;
    const apiFilter = filter === "all" ? undefined : filter;

    set({ loading: true, error: null, agentTypeFilter: filter });

    try {
      const since = new Date(Date.now() - SWIMLANE_LOOKBACK_MS).toISOString();
      // Parallel fetch: agents roster (table + sidebar), recent
      // sessions (swimlane grouping), directive registry.
      const [fleet, sessions, directives] = await Promise.all([
        fetchFleet(page, perPage, apiFilter),
        // Server caps the sessions page at 100; the swimlane sources
        // its rows from the agents roster (fetchFleet) so 100 recent
        // sessions is plenty to populate event circles in the rows
        // the user can actually see. Fleets with a higher burst would
        // rely on WebSocket updates to fill in missing circles.
        fetchSessions({
          from: since,
          agent_type: apiFilter ? [apiFilter] : undefined,
          limit: 100,
          offset: 0,
          // Bring in parents of any child sessions that land in
          // the 100-row window even when the parent is older
          // than the swimlane lookback (or otherwise outside
          // the LIMIT cliff). Without this, a sub-agent whose
          // parent fell off the page renders as topology="lone"
          // and the connector overlay drops the relationship.
          // NOTE: with this flag the response's ``total`` may be
          // less than ``sessions.length`` -- the augmented
          // parents ride along outside the total accounting.
          include_parents: true,
        }),
        fetchCustomDirectives().catch(() => [] as CustomDirective[]),
      ]);

      // Belt-and-suspenders: the API contract says agents is an
      // array, but a nil-slice Go return becomes JSON null, which
      // crashes every ``.map`` below. Guard once here so every
      // downstream consumer (buildFlavors, seedBucketEntries,
      // Fleet/Investigate readers) sees a real array. Same story
      // for ``sessions.sessions``.
      const safeAgents = fleet.agents ?? [];
      const safeSessions = sessions.sessions ?? [];
      set({
        agents: safeAgents,
        total: fleet.total,
        page: fleet.page,
        perPage: fleet.per_page,
        contextFacets: fleet.context_facets ?? {},
        flavors: buildFlavors(safeAgents, safeSessions),
        customDirectives: directives,
        loading: false,
        // Seed the bucket-entry map from the loaded roster. Every
        // row starts out having "just entered" its current bucket
        // at its server-reported last_seen_at; subsequent
        // applyUpdate calls only advance the entry on bucket
        // crossings, so within-bucket ordering stays stable.
        enteredBucketAt: seedBucketEntries(
          safeAgents.map((a) => ({
            id: a.agent_id,
            lastSeenAt: a.last_seen_at,
          })),
        ),
      });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  setAgentTypeFilter: (filter: AgentTypeFilter) => {
    void get().load({ page: 1, agentType: filter });
  },

  setFlavorFilter: (flavor: string | null) => {
    set({ flavorFilter: flavor });
  },

  applyUpdate: (update: FleetUpdate) => {
    const { flavors, agents, shuttingDown, enteredBucketAt } = get();
    // D115: the swimlane row key is agent_id (stored under the legacy
    // ``flavor`` field name). Updates for sessions without an
    // agent_id (legacy rows awaiting enrichment) land under the
    // session's flavor string as a fallback so they still render.
    const agentKey = update.session.agent_id ?? update.session.flavor;
    const isNewAgent = !flavors.some((f) => f.flavor === agentKey);
    const updated = applySessionUpdate(flavors, update.session, agentKey);

    let nextShuttingDown = shuttingDown;
    if (
      update.session.state === "closed" &&
      shuttingDown.has(update.session.session_id)
    ) {
      nextShuttingDown = new Set(shuttingDown);
      nextShuttingDown.delete(update.session.session_id);
    }

    set({ flavors: updated, shuttingDown: nextShuttingDown });

    if (update.type === "session_start" && isNewAgent) {
      // A brand-new agent: refetch directives (which are flavor /
      // agent-scoped) and pull the refreshed agent roster so the
      // table view gains the row without a hard refresh. Best-effort
      // -- failures swallowed.
      fetchCustomDirectives()
        .then((directives) => set({ customDirectives: directives }))
        .catch(() => {
          /* directive refresh is best-effort */
        });
      // Narrow refetch: only hits the agents endpoint, not the
      // sessions window, so the payload stays small.
      void get().load({ page: get().page, agentType: get().agentTypeFilter });
    }

    // Mirror the server-side rollup so the Fleet table + bucket sort
    // react to every live event, not just session_start. Previously
    // only session_start bumped agents[]; tool_call / post_call /
    // heartbeat updates left the array frozen until the next full
    // load(), which was what made the table view drift out of sync
    // with the swimlane under WebSocket traffic.
    if (update.session.agent_id) {
      const aid = update.session.agent_id;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const priorAgent = agents.find((a) => a.agent_id === aid);
      const isStart = update.type === "session_start";
      const nextAgents = agents.map((a) =>
        a.agent_id === aid
          ? {
              ...a,
              total_sessions: isStart ? a.total_sessions + 1 : a.total_sessions,
              last_seen_at: nowIso,
              state:
                update.session.state === "active" ||
                update.session.state === "idle"
                  ? ("active" as SessionState)
                  : a.state,
            }
          : a,
      );
      if (nextAgents !== agents) {
        const nextEntries = advanceBucketEntry(
          enteredBucketAt,
          aid,
          priorAgent?.last_seen_at,
          nowIso,
          now,
        );
        set({
          agents: nextAgents,
          enteredBucketAt:
            nextEntries === enteredBucketAt ? enteredBucketAt : nextEntries,
        });
      }
    }

    // A sub-agent event makes the whole parent + sub-agent cluster
    // operationally fresh. The backend already bumps the parent
    // SESSION's last_seen_at (parent-bump propagation), but the WS
    // envelope carries only the child's session — so the parent's
    // swimlane row would otherwise stay frozen in its stale/idle
    // bucket and the cluster would not bubble up. Resolve the parent
    // agent from the child's parent_session_id and bump both its
    // flavor last_seen_at (lifts the cluster out of the IDLE bucket,
    // which bucketFor keys on last_seen_at) and its enteredBucketAt
    // entry (floats it to the top within LIVE / RECENT). Best-effort:
    // if the parent row is not loaded yet the bump is skipped and
    // self-heals on the next load() (parents of in-window children
    // ride along via the include_parents fetch flag).
    const parentSessionId = update.session.parent_session_id;
    if (parentSessionId) {
      const state = get();
      const parentFlavor = state.flavors.find((f) =>
        f.sessions.some((s) => s.session_id === parentSessionId),
      );
      if (parentFlavor && parentFlavor.flavor !== agentKey) {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const bumpedFlavors = state.flavors.map((f) =>
          f.flavor === parentFlavor.flavor
            ? { ...f, last_seen_at: nowIso }
            : f,
        );
        const bumpedEntries = advanceBucketEntry(
          state.enteredBucketAt,
          parentFlavor.flavor,
          parentFlavor.last_seen_at,
          nowIso,
          now,
        );
        set({
          flavors: bumpedFlavors,
          enteredBucketAt:
            bumpedEntries === state.enteredBucketAt
              ? state.enteredBucketAt
              : bumpedEntries,
        });
      }
    }
  },

  selectSession: (id) => set({ selectedSessionId: id }),

  setLastEvent: (event) => set({ lastEvent: event }),


  markShuttingDown: (sessionId) => {
    const next = new Set(get().shuttingDown);
    next.add(sessionId);
    set({ shuttingDown: next });
  },

  markFlavorShuttingDown: (flavor) => {
    const next = new Set(get().shuttingDown);
    for (const f of get().flavors) {
      if (f.flavor !== flavor) continue;
      for (const s of f.sessions) {
        if (s.state === "active" || s.state === "idle") {
          next.add(s.session_id);
        }
      }
    }
    set({ shuttingDown: next });
  },
}));

function applySessionUpdate(
  flavors: FlavorSummary[],
  session: Session,
  agentKey: string,
): FlavorSummary[] {
  const exists = flavors.some((f) => f.flavor === agentKey);

  if (!exists) {
    return [
      ...flavors,
      {
        flavor: agentKey,
        agent_type: session.agent_type,
        session_count: 1,
        active_count: session.state === "active" ? 1 : 0,
        tokens_used_total: session.tokens_used,
        sessions: [session],
        agent_id: session.agent_id ?? undefined,
        agent_name: session.agent_name ?? undefined,
        client_type: session.client_type ?? undefined,
        last_seen_at: session.last_seen_at,
      },
    ];
  }

  return flavors.map((f) => {
    if (f.flavor !== agentKey) return f;
    const sessions = f.sessions.map((s) =>
      s.session_id === session.session_id ? session : s,
    );
    if (!sessions.some((s) => s.session_id === session.session_id)) {
      sessions.unshift(session);
    }
    return {
      ...f,
      sessions,
      session_count: sessions.length,
      active_count: sessions.filter((s) => s.state === "active").length,
      tokens_used_total: sessions.reduce((sum, s) => sum + s.tokens_used, 0),
      // Promote identity fields from the update if the row had none
      // (e.g. a fallback row built from session.flavor before the
      // session's first enriched update arrived).
      agent_id: f.agent_id ?? session.agent_id ?? undefined,
      agent_name: f.agent_name ?? session.agent_name ?? undefined,
      client_type: f.client_type ?? session.client_type ?? undefined,
      last_seen_at: session.last_seen_at || f.last_seen_at,
    };
  });
}
