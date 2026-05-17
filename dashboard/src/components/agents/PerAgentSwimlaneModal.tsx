import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Timeline } from "@/components/timeline/Timeline";
import { TopologyCell } from "@/components/fleet/TopologyCell";
import { AgentStatusBadge } from "@/components/timeline/AgentStatusBadge";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { useAgentSummary } from "@/hooks/useAgentSummary";
import { useFleetStore } from "@/store/fleet";
import {
  formatCost,
  formatLatencyMs,
  formatTokens,
} from "@/lib/agents-format";
import type { AgentEvent, AgentSummary } from "@/lib/types";
import type { TimeRange } from "@/pages/Fleet";
import { DEFAULT_TIME_RANGE, TIME_RANGE_OPTIONS } from "@/lib/constants";

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
  // Re-derived whenever the modal's agent prop changes so opening
  // the modal on a fresh agent picks up the right default — the
  // previous useState(showSubAgentsDefault) locked in the value
  // from the first render (when agent may still have been null).
  const [showSubAgents, setShowSubAgents] = useState(false);
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

            {/* Swimlane body — the existing Timeline primitive
                scoped to the focused agent's flavors. */}
            <div
              data-testid="per-agent-swimlane-modal-body"
              style={{
                flex: 1,
                overflow: "hidden",
                minHeight: 0,
                position: "relative",
              }}
            >
              <Timeline
                flavors={scopedFlavors}
                timeRange={timeRange}
                onNodeClick={(_sessionId, _eventId, event) => {
                  if (event) setSelectedEvent(event);
                }}
              />
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
