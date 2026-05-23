import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Timeline } from "@/components/timeline/Timeline";
import { TopologyCell } from "@/components/fleet/TopologyCell";
import { AgentStatusBadge } from "@/components/timeline/AgentStatusBadge";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { LiveFeed } from "@/components/fleet/LiveFeed";
import { useAgentSummary } from "@/hooks/useAgentSummary";
import { eventsCache } from "@/hooks/useSessionEvents";
import { useFleetStore } from "@/store/fleet";
import { fetchSession } from "@/lib/api";
import {
  formatCost,
  formatLatencyMs,
  formatTokens,
} from "@/lib/agents-format";
import type { AgentEvent, AgentSummary, FeedEvent } from "@/lib/types";
import type { TimeRange } from "@/pages/Fleet";
import {
  DEFAULT_TIME_RANGE,
  FEED_MAX_EVENTS,
  TIME_RANGE_OPTIONS,
} from "@/lib/constants";

interface PerAgentSwimlaneModalProps {
  /** The agent whose swimlane is being viewed. ``null`` keeps the
   *  modal mounted-but-hidden so close animations can play out. */
  agent: AgentSummary | null;
  onClose: () => void;
}

export function PerAgentSwimlaneModal({
  agent,
  onClose,
}: PerAgentSwimlaneModalProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_TIME_RANGE);
  // Show-sub-agents toggle. Default ON for parents (the relationship
  // is the primary reason an operator opens the modal on a parent);
  // DISABLED + off for lone agents (no sub-agents to render).
  // Lazy useState initialiser reads ``agent?.topology`` once on
  // mount so the first paint already shows the right scoping —
  // a bare ``useState(false)`` + post-mount effect would briefly
  // flash the lone-scoped lanes on slower connections. The
  // ``useEffect`` below still resets the toggle whenever the
  // modal re-points at a different agent.
  const [showSubAgents, setShowSubAgents] = useState(
    () => agent?.topology === "parent",
  );
  const [selectedEvent, setSelectedEvent] = useState<AgentEvent | null>(null);

  useEffect(() => {
    setShowSubAgents(agent?.topology === "parent");
    // Reset the window to the shared default whenever the modal
    // re-points at a different agent, mirroring the showSubAgents
    // reset — a reopen never inherits the prior agent's range.
    setTimeRange(DEFAULT_TIME_RANGE);
  }, [agent?.agent_id, agent?.topology]);

  const { summary } = useAgentSummary(agent?.agent_id ?? "", {
    period: "7d",
    bucket: "day",
  });
  const totals = summary?.totals;

  const allFlavors = useFleetStore((s) => s.flavors);

  // Filter the swimlane's flavors to the focused agent + its
  // sub-agents (when the toggle is on). Lone agents always
  // render a single row regardless of toggle state.
  const scopedFlavors = useMemo(() => {
    if (!agent) return [];
    const subAgentParentIds = new Set<string>();
    // A flavor is a sub-agent of the focused agent when any of
    // its sessions carries a parent_session_id pointing at a
    // session belonging to the focused agent. The fleet store's
    // flavors[].sessions[] carry this linkage directly so the
    // walk is one pass over the in-memory roster.
    const focusedFlavor = allFlavors.find(
      (f) => f.flavor === agent.agent_id,
    );
    if (focusedFlavor) {
      for (const s of focusedFlavor.sessions) {
        subAgentParentIds.add(s.session_id);
      }
    }
    return allFlavors.filter((f) => {
      if (f.flavor === agent.agent_id) return true;
      if (!showSubAgents) return false;
      return f.sessions.some(
        (s) =>
          s.parent_session_id !== null &&
          s.parent_session_id !== undefined &&
          subAgentParentIds.has(s.parent_session_id),
      );
    });
  }, [agent, allFlavors, showSubAgents]);

  // Modal-scoped live feed pipeline. Reads from the SAME source
  // the swimlane uses (``eventsCache``, populated by
  // ``useSessionEvents`` per-session fetches) so the feed always
  // matches what the lanes show.
  //
  //   1. On mount + scope change: per-session ``fetchSession``
  //      for each scoped session_id. Skips sessions already in
  //      ``eventsCache``; populates the cache on fetch resolve
  //      so the swimlane's ``useSessionEvents`` reads find it
  //      pre-warmed. Seeds the feed from the union of cached
  //      events across the scoped session set.
  //   2. On every WS tick: ``useFleetStore.lastEvent`` fires.
  //      If the event's ``session_id`` is in scope: inject it
  //      into ``eventsCache`` (mirrors Fleet.tsx's
  //      ``handleNewEvent`` so the swimlane sees the live tick)
  //      and append a ``FeedEvent`` to the feed state.
  //
  // The match key is ``session_id``, not ``flavor`` — the fleet
  // store's ``flavors[].flavor`` carries the agent_id UUID per
  // D115 while ``AgentEvent.flavor`` still carries the
  // seed-time flavor string. ``session_id`` is stable on both
  // sides. The historical-bulk-events endpoint
  // (``GET /v1/events?from=…``) is intentionally NOT used here
  // — it returns events in a wall-clock time window which
  // diverges from what the swimlane shows for sessions whose
  // events are older than the picker's range.
  // Stable scope-key + Set. ``scopedFlavors`` reference flips
  // every time the fleet store mutates (which happens on every
  // WS event because the store rewrites its flavors array),
  // and a naive ``new Set(...)`` per render produces a fresh
  // Set reference each time. Feeding that into the seed
  // effect's dep array kept cancelling in-flight fetches
  // before they could settle. The sorted joined-key is the
  // structural identity of the scoped set; both the key and
  // the Set memo are stable across renders that don't change
  // the actual contents.
  const scopedSessionIdsKey = useMemo(() => {
    const ids: string[] = [];
    for (const f of scopedFlavors) {
      for (const s of f.sessions) ids.push(s.session_id);
    }
    return ids.sort().join(",");
  }, [scopedFlavors]);
  const scopedSessionIds = useMemo(
    () =>
      new Set(scopedSessionIdsKey ? scopedSessionIdsKey.split(",") : []),
    [scopedSessionIdsKey],
  );
  const lastEvent = useFleetStore((s) => s.lastEvent);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const arrivalCounter = useRef(0);
  const agentId = agent?.agent_id;

  // Initial seed (and re-seed on scope change). Per-session
  // detail fetches resolve in parallel; events from already-
  // cached sessions read from ``eventsCache`` synchronously.
  // ``cancelled`` guard prevents a stale fetch from overwriting
  // a fresh-scope seed if the toggle flips mid-flight.
  // Deps key off the agent_id string and the scope key so the
  // effect doesn't re-run on every parent re-render.
  useEffect(() => {
    if (!agentId) {
      setFeedEvents([]);
      return;
    }
    let cancelled = false;
    const sessionIds = scopedSessionIdsKey
      ? scopedSessionIdsKey.split(",")
      : [];
    Promise.all(
      sessionIds.map(async (sid) => {
        const cached = eventsCache.get(sid);
        if (cached && cached.length > 0) {
          return { sid, events: cached };
        }
        try {
          const detail = await fetchSession(sid);
          const evs = detail.events ?? [];
          if (evs.length > 0) eventsCache.set(sid, evs);
          return { sid, events: evs };
        } catch {
          return { sid, events: [] as AgentEvent[] };
        }
      }),
    )
      .then((perSession) => {
        if (cancelled) return;
        const all: FeedEvent[] = [];
        for (const { events } of perSession) {
          for (const ev of events) {
            all.push({
              arrivedAt: new Date(ev.occurred_at).getTime(),
              event: ev,
            });
          }
        }
        // Newest first; LiveFeed has its own sort but pinning
        // the order here keeps the slice-cap aligned with what
        // the operator sees at the top.
        all.sort((a, b) => b.arrivedAt - a.arrivedAt);
        setFeedEvents(all.slice(0, FEED_MAX_EVENTS));
      })
      // Inner per-session catches swallow fetch errors and
      // return ``[]`` for that session, so ``Promise.all``
      // itself doesn't reject under normal flow. A trailing
      // ``.catch`` is still here to document intent and
      // suppress any unexpected throw inside the synchronous
      // ``.then`` body — the seed simply skips and the next
      // scope change re-fires the effect.
      .catch(() => {
        /* unexpected; the next effect run will retry */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, scopedSessionIdsKey]);

  // Live-tick accumulator. Dedup by ``event.id`` so a re-render
  // that re-fires the effect with the same lastEvent doesn't
  // double-append; ``arrivalCounter`` ref mirrors Fleet.tsx's
  // monotonic stamp so ``FeedEvent.arrivedAt`` stays unique
  // even when multiple WS events land in the same ms.
  // Also injects into ``eventsCache`` so the swimlane sees the
  // live tick alongside the feed (Fleet.tsx does the same in
  // its handleNewEvent path).
  useEffect(() => {
    if (!agentId || !lastEvent) return;
    if (!scopedSessionIds.has(lastEvent.session_id)) return;
    const sid = lastEvent.session_id;
    const cached = eventsCache.get(sid) ?? [];
    if (!cached.some((e) => e.id === lastEvent.id)) {
      eventsCache.set(sid, [...cached, lastEvent]);
    }
    arrivalCounter.current += 1;
    const fe: FeedEvent = {
      arrivedAt: Date.now() + arrivalCounter.current * 0.001,
      event: lastEvent,
    };
    setFeedEvents((prev) =>
      prev.some((p) => p.event.id === lastEvent.id)
        ? prev
        : [fe, ...prev].slice(0, FEED_MAX_EVENTS),
    );
  }, [agentId, lastEvent, scopedSessionIds]);

  const open = agent !== null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        data-testid="per-agent-swimlane-modal"
        className="!max-w-[80vw]"
        style={{
          width: "80vw",
          height: "80vh",
          maxHeight: "80vh",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {agent && (
          <>
            <DialogTitle className="sr-only">
              {`${agent.agent_name} — swimlane`}
            </DialogTitle>

            {/* Header strip — identity + KPI totals + controls. */}
            <div
              data-testid="per-agent-swimlane-modal-header"
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                background: "var(--surface)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text)",
                  }}
                  data-testid="per-agent-swimlane-modal-name"
                >
                  {agent.agent_name}
                </span>
                <TopologyCell
                  agentId={agent.agent_id}
                  topology={agent.topology}
                />
                <AgentStatusBadge
                  state={agent.state}
                  testId="per-agent-swimlane-modal-status"
                />
                {/* Explicit close X — outside-click / Esc keep
                    working via Radix's Dialog onOpenChange, but
                    the X is the operator's visible affordance.
                    Reuses the ``.agent-status-chip`` hover +
                    focus-visible affordance from globals.css;
                    border + border-radius + background are owned
                    by that class so we keep only layout-specific
                    inline properties here. An inline ``border``
                    value would override the class's hover
                    border-color and silently kill the affordance.
                  */}
                <button
                  type="button"
                  onClick={onClose}
                  data-testid="per-agent-swimlane-modal-close"
                  aria-label="Close per-agent swimlane modal"
                  className="agent-status-chip"
                  style={{
                    marginLeft: "auto",
                    justifyContent: "center",
                    width: 28,
                    height: 28,
                    padding: 0,
                    color: "var(--text-secondary)",
                  }}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>

              {/* KPI totals + controls bar. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <KpiTile
                  label="Tokens (7d)"
                  value={totals ? formatTokens(totals.tokens) : "—"}
                />
                <KpiTile
                  label="Latency p95 (7d)"
                  value={totals ? formatLatencyMs(totals.latency_p95_ms) : "—"}
                />
                <KpiTile
                  label="Errors (7d)"
                  value={totals ? totals.errors.toString() : "—"}
                />
                <KpiTile
                  label="Sessions (7d)"
                  value={totals ? totals.sessions.toString() : "—"}
                />
                <KpiTile
                  label="Cost (7d)"
                  value={totals ? formatCost(totals.cost_usd) : "—"}
                />

                {/* Time range picker. */}
                <div
                  data-testid="per-agent-swimlane-modal-time-range"
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {TIME_RANGE_OPTIONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setTimeRange(r)}
                      data-testid={`per-agent-swimlane-modal-time-${r}`}
                      data-active={timeRange === r ? "true" : undefined}
                      aria-pressed={timeRange === r}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 3,
                        border: "1px solid",
                        borderColor:
                          timeRange === r ? "var(--accent)" : "var(--border)",
                        background:
                          timeRange === r
                            ? "color-mix(in srgb, var(--accent) 18%, transparent)"
                            : "transparent",
                        color:
                          timeRange === r
                            ? "var(--accent)"
                            : "var(--text-secondary)",
                        cursor: "pointer",
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>

                {/* Show sub-agents toggle. Lone agents have nothing
                    to show so the toggle is disabled + off. */}
                <label
                  data-testid="per-agent-swimlane-modal-show-sub-agents"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color:
                      agent.topology === "lone"
                        ? "var(--text-muted)"
                        : "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={agent.topology !== "lone" && showSubAgents}
                    disabled={agent.topology === "lone"}
                    onChange={(e) => setShowSubAgents(e.target.checked)}
                    data-testid="per-agent-swimlane-modal-show-sub-agents-input"
                  />
                  Show sub-agents
                </label>
              </div>
            </div>

            {/* Swimlane body + live feed — mirrors Fleet.tsx's
                "swimlane on top, feed below" layout. The feed is
                scoped to ``scopedFlavors`` via the dedicated
                pipeline above so toggling Show sub-agents
                rescopes both the lanes and the feed in lockstep.
                A feed row click reuses the same
                ``setSelectedEvent`` setter the swimlane click
                does, so the event detail drawer mounted below
                opens identically from either surface. */}
            <div
              data-testid="per-agent-swimlane-modal-body"
              style={{
                flex: 1,
                overflow: "hidden",
                minHeight: 0,
                position: "relative",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                <Timeline
                  flavors={scopedFlavors}
                  timeRange={timeRange}
                  onNodeClick={(_sessionId, _eventId, event) => {
                    if (event) setSelectedEvent(event);
                  }}
                />
              </div>
              <div
                data-testid="per-agent-swimlane-modal-feed"
                style={{
                  flexShrink: 0,
                  borderTop: "1px solid var(--border)",
                  background: "var(--bg)",
                }}
              >
                <LiveFeed
                  events={feedEvents}
                  onEventClick={(event) => setSelectedEvent(event)}
                />
              </div>
            </div>

            {/* Event detail drawer — mounts inside the Dialog so
                it visually layers above the modal content.
                EventDetailDrawer is a framer-motion position-
                fixed overlay (not a nested Radix Dialog), so no
                portal coordination is required; the drawer
                overlays the page on its own and the modal's
                Radix focus-trap stays out of its way. */}
            <EventDetailDrawer
              event={selectedEvent}
              onClose={() => setSelectedEvent(null)}
            />

          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      data-testid="per-agent-swimlane-modal-kpi-tile"
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 90,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 14,
          color: "var(--text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
