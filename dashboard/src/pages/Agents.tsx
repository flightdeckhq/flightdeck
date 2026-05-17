import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useFleetStore } from "@/store/fleet";
import type { AgentSummary } from "@/lib/types";
import { AgentTable } from "@/components/agents/AgentTable";
import { AgentFacetSidebar } from "@/components/agents/AgentFacetSidebar";
import { PerAgentSwimlaneModal } from "@/components/agents/PerAgentSwimlaneModal";
import { useAgentSummaries } from "@/hooks/useAgentSummary";
import {
  type AgentFilterState,
  EMPTY_FILTER,
  filterAgents,
} from "@/lib/agents-filter";

/**
 * `/agents` route. SentinelOne-grade one-row-per-agent table with
 * KPI sparklines, a left facet sidebar, sort, and pagination.
 *
 * Reads the fleet roster from the shared `useFleetStore`; the
 * roster is bootstrapped by the FleetWebSocket subscription mounted
 * elsewhere so the page does not re-issue `/v1/fleet` itself.
 *
 * A row click opens that agent's drawer by setting the
 * `?agent_drawer=<agent_id>` URL param — the app-level
 * `AgentDrawerHost` reads it and renders the drawer. The status
 * badge opens the per-agent swimlane modal.
 */
export function Agents() {
  const agents = useFleetStore((s) => s.agents);
  const load = useFleetStore((s) => s.load);
  const fleetLoading = useFleetStore((s) => s.loading);
  const [, setSearchParams] = useSearchParams();

  const [filter, setFilter] = useState<AgentFilterState>(EMPTY_FILTER);
  const [modalAgent, setModalAgent] = useState<AgentSummary | null>(null);

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

  // Row click → open the agent drawer via the `?agent_drawer=` URL
  // param. A normal (pushed) navigation so the browser back button
  // closes the drawer.
  const openDrawer = useCallback(
    (agent: AgentSummary) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("agent_drawer", agent.agent_id);
        return next;
      });
    },
    [setSearchParams],
  );

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
      {/* Top-of-page free-text search — spans the full page width
          above the facet sidebar + table. Client-side filter (the
          /agents roster is O(100s) of rows at most). */}
      <div
        style={{
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          padding: "8px 12px",
        }}
      >
        <input
          data-testid="agents-search-input"
          type="text"
          value={filter.search}
          onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter({ ...filter, search: "" });
          }}
          placeholder="Search agents…"
          aria-label="Search agents"
          style={{
            width: "100%",
            fontSize: 13,
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            outline: "none",
          }}
        />
      </div>
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <AgentFacetSidebar
          agents={agents}
          filter={filter}
          onChange={setFilter}
        />
        <div style={{ flex: 1, overflow: "auto" }}>
          <AgentTable
            agents={filtered}
            summariesByAgentId={summariesByAgentId}
            onOpenDrawer={openDrawer}
            onOpenSwimlaneModal={setModalAgent}
          />
        </div>
      </div>
      <PerAgentSwimlaneModal
        agent={modalAgent}
        onClose={() => setModalAgent(null)}
      />
    </div>
  );
}
