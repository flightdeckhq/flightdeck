import { memo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ClientType } from "@/lib/agent-identity";
import type { AgentSummary } from "@/lib/types";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { getProvider } from "@/lib/models";
import { TopologyCell } from "@/components/fleet/TopologyCell";
import { AgentStatusBadge } from "@/components/timeline/AgentStatusBadge";
import { useAgentSummary } from "@/hooks/useAgentSummary";
import {
  formatCost,
  formatLatencyMs,
  formatTokens,
  relativeTime,
} from "@/lib/agents-format";
import { AgentSparkline } from "./AgentSparkline";

interface AgentTableRowProps {
  agent: AgentSummary;
  /** Row click — opens the agent drawer for this agent. */
  onOpenDrawer: (agent: AgentSummary) => void;
  /** Status-badge click — opens the per-agent swimlane modal. */
  onOpenSwimlaneModal: (agent: AgentSummary) => void;
}

/**
 * KPI sparkline tile dimensions. The tile shares its row's
 * vertical centre line; the numeric total reads to the left of
 * the chart so the operator's eye lands on the value first.
 */
const SPARKLINE_WIDTH = 80;
const SPARKLINE_HEIGHT = 22;

function AgentTableRowImpl({
  agent,
  onOpenDrawer,
  onOpenSwimlaneModal,
}: AgentTableRowProps) {
  const navigate = useNavigate();
  const { summary } = useAgentSummary(agent.agent_id, {
    period: "7d",
    bucket: "day",
  });
  const totals = summary?.totals;
  const series = summary?.series ?? [];

  // Provider attribution from the agent's most-recent session model.
  // The `recent_sessions` rollup carries the model on each row so
  // the provider icon can render without a follow-up fetch.
  const model = agent.recent_sessions?.[0]?.model ?? null;
  const provider = model ? getProvider(model) : null;
  // os / orchestration aren't in the lean RecentSession projection;
  // they'd require a context-bearing fetch. Out of scope for the
  // initial table render; the modal carries the richer view.

  const handleRowClick = useCallback(
    () => onOpenDrawer(agent),
    [agent, onOpenDrawer],
  );
  const handleBadgeClick = useCallback(
    () => onOpenSwimlaneModal(agent),
    [agent, onOpenSwimlaneModal],
  );
  const handleOpenInEvents = useCallback(
    () => navigate(`/events?agent_id=${encodeURIComponent(agent.agent_id)}`),
    [agent.agent_id, navigate],
  );

  return (
    <tr
      data-testid={`agent-row-${agent.agent_id}`}
      data-agent-id={agent.agent_id}
      data-agent-topology={agent.topology}
      data-agent-state={agent.state}
      onClick={handleRowClick}
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        cursor: "pointer",
      }}
    >
      {/* Identity */}
      <td
        style={{ padding: "8px 12px", minWidth: 260 }}
        data-testid={`agent-row-identity-${agent.agent_id}`}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {agent.client_type === ClientType.ClaudeCode && (
            <ClaudeCodeLogo size={14} />
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text)",
            }}
          >
            {agent.agent_name}
          </span>
          <ClientTypePill
            clientType={agent.client_type}
            size="compact"
            testId={`agent-row-client-type-${agent.agent_id}`}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
            data-testid={`agent-row-agent-type-${agent.agent_id}`}
          >
            {agent.agent_type}
          </span>
          {provider && provider !== "other" && (
            <ProviderLogo provider={provider} size={12} />
          )}
        </div>
      </td>

      {/* Topology */}
      <td
        style={{ padding: "8px 12px", minWidth: 120 }}
        data-testid={`agent-row-topology-${agent.agent_id}`}
      >
        <TopologyCell agentId={agent.agent_id} topology={agent.topology} />
      </td>

      {/* Tokens 7d */}
      <td style={{ padding: "8px 12px" }} data-testid={`agent-row-tokens-${agent.agent_id}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              minWidth: 50,
            }}
            data-testid={`agent-row-tokens-total-${agent.agent_id}`}
          >
            {totals ? formatTokens(totals.tokens) : "—"}
          </span>
          <AgentSparkline
            series={series}
            axis="tokens"
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
          />
        </div>
      </td>

      {/* Latency p95 7d */}
      <td style={{ padding: "8px 12px" }} data-testid={`agent-row-latency-${agent.agent_id}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              minWidth: 50,
            }}
          >
            {totals ? formatLatencyMs(totals.latency_p95_ms) : "—"}
          </span>
          <AgentSparkline
            series={series}
            axis="latency_p95_ms"
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
          />
        </div>
      </td>

      {/* Errors 7d */}
      <td style={{ padding: "8px 12px" }} data-testid={`agent-row-errors-${agent.agent_id}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color:
                totals && totals.errors > 0
                  ? "var(--danger)"
                  : "var(--text-muted)",
              minWidth: 30,
            }}
          >
            {totals ? totals.errors : "—"}
          </span>
          <AgentSparkline
            series={series}
            axis="errors"
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
          />
        </div>
      </td>

      {/* Sessions 7d */}
      <td style={{ padding: "8px 12px" }} data-testid={`agent-row-sessions-${agent.agent_id}`}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          {totals ? totals.sessions : "—"}
        </span>
      </td>

      {/* Cost USD 7d. Estimated cost only applies to
          sensor-instrumented agents — Claude Code agents bill
          independently and Flightdeck has no pricing for them, so
          their cell renders a bare em-dash regardless of any
          summary totals. */}
      <td style={{ padding: "8px 12px" }} data-testid={`agent-row-cost-${agent.agent_id}`}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          {agent.client_type === ClientType.ClaudeCode
            ? "—"
            : totals
              ? formatCost(totals.cost_usd)
              : "—"}
        </span>
      </td>

      {/* Last seen */}
      <td
        style={{ padding: "8px 12px" }}
        title={new Date(agent.last_seen_at).toLocaleString()}
        data-testid={`agent-row-last-seen-${agent.agent_id}`}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {relativeTime(agent.last_seen_at)}
        </span>
      </td>

      {/* Status badge + hover quick actions */}
      <td
        style={{ padding: "8px 12px", textAlign: "right" }}
        data-testid={`agent-row-actions-${agent.agent_id}`}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenInEvents();
            }}
            data-testid={`agent-row-open-events-${agent.agent_id}`}
            className="agent-row-quick-action"
            aria-label={`Open ${agent.agent_name} in Events`}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 3,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            Events ↗
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleBadgeClick();
            }}
            data-testid={`agent-row-open-swimlane-modal-${agent.agent_id}`}
            aria-label={`Open swimlane modal for ${agent.agent_name}`}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            <AgentStatusBadge
              state={agent.state}
              testId={`agent-row-status-${agent.agent_id}`}
            />
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * The row memoises shallowly: the `agent` identity and the two
 * callbacks drive the re-render gate. Per-row KPI updates from the
 * WS lastEvent subscription tick the row's `useAgentSummary` memo
 * internally and do not affect the parent table's render path.
 */
export const AgentTableRow = memo(AgentTableRowImpl, (prev, next) => {
  return (
    prev.agent === next.agent &&
    prev.onOpenDrawer === next.onOpenDrawer &&
    prev.onOpenSwimlaneModal === next.onOpenSwimlaneModal
  );
});
