import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useFleetStore } from "@/store/fleet";
import type { AgentSummary } from "@/lib/types";
import { AgentTable } from "@/components/agents/AgentTable";
import { AgentFilterChips } from "@/components/agents/AgentFilterChips";
import { PerAgentSwimlaneModal } from "@/components/agents/PerAgentSwimlaneModal";
import { useAgentSummaries } from "@/hooks/useAgentSummary";
import {
  type AgentFilterState,
  EMPTY_FILTER,
  filterAgents,
} from "@/lib/agents-filter";

// Strict RFC-4122 UUID gate for the ``?focus=<id>`` URL
// parameter. Every agent_id is a uuid5 (see the sensor's
// ``derive_agent_id``), so the canonical 8-4-4-4-12 shape
// rejects nothing legitimate while keeping a malformed bookmark
// or a crafted URL from driving an unexpected scroll / highlight.
const AGENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wait for the AgentTableRow to mount + register its scroll-into-
// view ref before triggering the smooth scroll. 100 ms is long
// enough that React's commit phase completes (~16 ms typical),
// the row's ``useImperativeHandle`` runs, and the
// IntersectionObserver-tracked virtualization has had a frame
// to settle. Shorter values race the commit on slow boxes.
const FOCUS_SCROLL_DELAY_MS = 100;

// Clear the ``?focus=`` URL param after the highlight transition
// has had time to land + the operator's eye has had time to lock
// on the row. 1500 ms matches the CSS transition duration on
// the highlight background fade (600 ms) plus a 900 ms read
// window — long enough that the operator sees the highlight,
// short enough that a browser-back doesn't re-apply the
// highlight when intent has moved on.
const FOCUS_CLEAR_DELAY_MS = 1500;

/**
 * `/agents` route. SentinelOne-grade one-row-per-agent table with
 * KPI sparklines, filter chips, sort, pagination, and a per-agent
 * swimlane modal that opens from the row's status badge.
 *
 * Reads the fleet roster from the shared `useFleetStore`; the
 * roster is bootstrapped by the FleetWebSocket subscription mounted
 * elsewhere so the page does not re-issue `/v1/fleet` itself.
 *
 * `?focus=<agent_id>` URL param scrolls the targeted row into
 * view and applies a transient highlight. Used by the Fleet
 * swimlane label-strip click as an interim cross-page jump.
 */
export function Agents() {
  const agents = useFleetStore((s) => s.agents);
  const load = useFleetStore((s) => s.load);
  const fleetLoading = useFleetStore((s) => s.loading);
  const [searchParams, setSearchParams] = useSearchParams();
  const focusedAgentId = searchParams.get("focus");

  const [filter, setFilter] = useState<AgentFilterState>(EMPTY_FILTER);
  const [modalAgent, setModalAgent] = useState<AgentSummary | null>(null);
  // Ref to the focused row's DOM node. ``AgentTable`` forwards
  // this ref to whichever row's `data-agent-id` matches
  // ``focusedAgentId``. Using a ref avoids a `document.
  // querySelector` call in component code (which would couple
  // the page to a DOM-attribute selector and bypass React's
  // managed-DOM contract).
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);

  // Bootstrap the fleet roster when /agents is the first surface
  // the operator lands on (deep-link or fresh page load). The
  // store's load() is idempotent + cached so a re-mount of /agents
  // after navigating Fleet → /agents doesn't refetch.
  useEffect(() => {
    if (agents.length === 0 && !fleetLoading) {
      void load();
    }
  }, [agents.length, fleetLoading, load]);

  const filtered = useMemo(
    () => filterAgents(agents, filter),
    [agents, filter],
  );

  // Per-agent KPI summaries, keyed by agent_id. `useAgentSummaries`
  // shares the same module-level cache the per-row `useAgentSummary`
  // hook reads, so each agent is fetched at most once regardless of
  // how many components subscribe. The map drives the KPI sort
  // columns (tokens / latency / errors / cost) — without it the
  // sort comparator falls back to zero for every row and those
  // columns never reorder. The fetch set is the FILTERED agents so
  // chips narrowing the view also narrow the fetch fan-out.
  const agentIds = useMemo(
    () => filtered.map((a) => a.agent_id),
    [filtered],
  );
  const summariesByAgentId = useAgentSummaries(agentIds, {
    period: "7d",
    bucket: "day",
  });

  // Scroll the focused row into view + clear the URL param once
  // the highlight has had time to land. Without clearing, a
  // browser-back into /agents would re-apply the highlight even
  // though the operator's intent has moved on. The row registers
  // itself via ``focusedRowRef`` through the AgentTable prop; the
  // effect reads the ref instead of using ``document.querySelector``
  // so all DOM access stays inside React's managed-ref contract.
  useEffect(() => {
    if (!focusedAgentId) return;
    if (!AGENT_ID_RE.test(focusedAgentId)) return;
    const id = window.setTimeout(() => {
      focusedRowRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, FOCUS_SCROLL_DELAY_MS);
    const clearId = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("focus");
          return next;
        },
        { replace: true },
      );
    }, FOCUS_CLEAR_DELAY_MS);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(clearId);
    };
  }, [focusedAgentId, setSearchParams]);

  return (
    <div
      data-testid="agents-page"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <AgentFilterChips
        agents={agents}
        filter={filter}
        onChange={setFilter}
      />
      <div
        style={{
          flex: 1,
          overflow: "auto",
        }}
      >
        <AgentTable
          agents={filtered}
          summariesByAgentId={summariesByAgentId}
          focusedAgentId={focusedAgentId}
          focusedRowRef={focusedRowRef}
          onOpenSwimlaneModal={setModalAgent}
        />
      </div>
      <PerAgentSwimlaneModal
        agent={modalAgent}
        onClose={() => setModalAgent(null)}
      />
    </div>
  );
}
