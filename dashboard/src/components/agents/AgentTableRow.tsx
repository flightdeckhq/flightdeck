import { memo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ClientType, clientIncursMeteredCost } from "@/lib/agent-identity";
import type { AgentSummary } from "@/lib/types";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { getProvider } from "@/lib/models";
import { TopologyCell } from "@/components/fleet/TopologyCell";
import { AgentStatusBadge } from "@/components/timeline/AgentStatusBadge";
import { TableCell, TableRow } from "@/components/ui/table";
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
  /** True when this row renders as a descendant under a parent
   *  row in the current family-grouped page slice. Drives the
   *  rendering-layout-topology stamp ``data-topology="child"``
   *  which the existing globals.css rule indents 28 px in the
   *  first cell (same rule the swimlane and Investigate
   *  sub-rows use). NOT the same as
   *  ``data-agent-topology={agent.topology}`` — that one
   *  reflects the agent's structural topology on the wire.
   *  This one reflects how the row is laid out in this view. */
  isFamilyDescendant: boolean;
  /** Row click — opens the agent drawer for this agent. */
  onOpenDrawer: (agent: AgentSummary) => void;
  /** Status-badge click — opens the per-agent swimlane modal. */
  onOpenSwimlaneModal: (agent: AgentSummary) => void;
}

/**
 * KPI sparkline tile dimensions. The tile shares its row's
 * vertical centre line; the numeric total reads to the LEFT of
 * the chart so the operator's eye lands on the value first and
 * the sparkline follows as a trend hint.
 */
const SPARKLINE_WIDTH = 80;
const SPARKLINE_HEIGHT = 22;

function AgentTableRowImpl({
  agent,
  isFamilyDescendant,
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
    <TableRow
      interactive
      data-testid={`agent-row-${agent.agent_id}`}
      data-agent-id={agent.agent_id}
      data-agent-topology={agent.topology}
      data-agent-state={agent.state}
      data-topology={isFamilyDescendant ? "child" : undefined}
      onClick={handleRowClick}
    >
      {/* Identity — UI font for the name + per-row identity chrome.
          Family descendants pick up the 28-px first-cell indent
          from the ``[data-topology="child"] > td:first-child`` rule
          in ``styles/globals.css``; that selector's specificity
          (0,1,2) wins over a Tailwind ``pl-7`` (0,1,0), so the
          Tailwind class would be dead code if we set it here. The
          ``data-topology="child"`` stamp on the row above lets the
          CSS rule fire; this cell only carries the column width
          minimum. */}
      <TableCell
        data-testid={`agent-row-identity-${agent.agent_id}`}
        className="min-w-[260px]"
      >
        <div className="flex items-center gap-2">
          {agent.client_type === ClientType.ClaudeCode && (
            <ClaudeCodeLogo size={14} />
          )}
          <span
            className="text-[13px] font-medium text-text"
            data-testid={`agent-row-name-${agent.agent_id}`}
          >
            {agent.agent_name}
          </span>
          <ClientTypePill
            clientType={agent.client_type}
            size="compact"
            testId={`agent-row-client-type-${agent.agent_id}`}
          />
          <span
            className="font-mono text-[10px] text-text-muted uppercase tracking-[0.06em]"
            data-testid={`agent-row-agent-type-${agent.agent_id}`}
          >
            {agent.agent_type}
          </span>
          {provider && provider !== "other" && (
            <ProviderLogo provider={provider} size={12} />
          )}
        </div>
      </TableCell>

      {/* Status — clickable chip wrapping the labeled badge.
          Hover affordance lives in the ``.agent-status-chip``
          rule in globals.css. Click stops propagation so the
          row's own onOpenDrawer handler doesn't fire alongside
          the modal open. */}
      <TableCell data-testid={`agent-row-status-cell-${agent.agent_id}`}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleBadgeClick();
          }}
          data-testid={`agent-row-open-swimlane-modal-${agent.agent_id}`}
          aria-label={`Open swimlane modal for ${agent.agent_name}`}
          className="agent-status-chip"
        >
          <AgentStatusBadge
            state={agent.state}
            testId={`agent-row-status-${agent.agent_id}`}
          />
        </button>
      </TableCell>

      {/* Topology */}
      <TableCell
        data-testid={`agent-row-topology-${agent.agent_id}`}
        className="min-w-[120px]"
      >
        <TopologyCell agentId={agent.agent_id} topology={agent.topology} />
      </TableCell>

      {/* Tokens 7d — number first, sparkline trailing right. The
          number's min-width keeps the cell column stable across
          rows so the sparkline tiles align vertically. */}
      <TableCell
        mono
        data-testid={`agent-row-tokens-${agent.agent_id}`}
      >
        <div className="flex items-center gap-2">
          <span
            className="min-w-[50px] text-text"
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
      </TableCell>

      {/* Latency p95 7d */}
      <TableCell
        mono
        data-testid={`agent-row-latency-${agent.agent_id}`}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-[50px] text-text">
            {totals ? formatLatencyMs(totals.latency_p95_ms) : "—"}
          </span>
          <AgentSparkline
            series={series}
            axis="latency_p95_ms"
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
          />
        </div>
      </TableCell>

      {/* Errors 7d */}
      <TableCell
        mono
        data-testid={`agent-row-errors-${agent.agent_id}`}
      >
        <div className="flex items-center gap-2">
          <span
            className={
              totals && totals.errors > 0
                ? "min-w-[30px] text-danger"
                : "min-w-[30px] text-text-muted"
            }
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
      </TableCell>

      {/* Sessions 7d — number first, sparkline trailing. Sessions
          is a count over the 7d window, so the sparkline is a
          per-day session count (one bar per day). */}
      <TableCell
        mono
        data-testid={`agent-row-sessions-${agent.agent_id}`}
      >
        <div className="flex items-center gap-2">
          <span
            className="min-w-[30px] text-text"
            data-testid={`agent-row-sessions-total-${agent.agent_id}`}
          >
            {totals ? totals.sessions : "—"}
          </span>
          <AgentSparkline
            series={series}
            axis="sessions"
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
          />
        </div>
      </TableCell>

      {/* Cost USD 7d — number first, sparkline trailing. Estimated
          cost only applies to clients whose LLM usage is billed per
          call on the operator's bill (sensor-instrumented production
          agents). Subscription-style coding agents — Claude Code
          today, Codex / Cursor / etc. in the future — bill
          independently of per-call usage, so the cell renders a
          bare em-dash and skips the sparkline. The
          ``clientIncursMeteredCost`` predicate in
          ``@/lib/agent-identity`` is the single source of truth so
          new client types inherit the correct treatment without a
          row-component edit. */}
      <TableCell
        mono
        data-testid={`agent-row-cost-${agent.agent_id}`}
      >
        {clientIncursMeteredCost(agent.client_type) ? (
          <div className="flex items-center gap-2">
            <span
              className="min-w-[50px] text-text"
              data-testid={`agent-row-cost-total-${agent.agent_id}`}
            >
              {totals ? formatCost(totals.cost_usd) : "—"}
            </span>
            <AgentSparkline
              series={series}
              axis="cost_usd"
              width={SPARKLINE_WIDTH}
              height={SPARKLINE_HEIGHT}
            />
          </div>
        ) : (
          <span className="text-text">—</span>
        )}
      </TableCell>

      {/* Last seen */}
      <TableCell
        mono
        title={new Date(agent.last_seen_at).toLocaleString()}
        data-testid={`agent-row-last-seen-${agent.agent_id}`}
      >
        <span className="text-[11px] text-text-muted">
          {relativeTime(agent.last_seen_at)}
        </span>
      </TableCell>

      {/* Actions — Events shortcut only. The status badge moved
          to the dedicated second-column STATUS chip above; this
          cell no longer duplicates it. */}
      <TableCell
        align="right"
        data-testid={`agent-row-actions-${agent.agent_id}`}
      >
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenInEvents();
            }}
            data-testid={`agent-row-open-events-${agent.agent_id}`}
            className="agent-row-quick-action font-mono text-[10px] px-1.5 py-0.5 rounded-sm border border-border bg-transparent text-text-secondary cursor-pointer"
            aria-label={`Open ${agent.agent_name} in Events`}
          >
            Events ↗
          </button>
        </div>
      </TableCell>
    </TableRow>
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
    prev.isFamilyDescendant === next.isFamilyDescendant &&
    prev.onOpenDrawer === next.onOpenDrawer &&
    prev.onOpenSwimlaneModal === next.onOpenSwimlaneModal
  );
});
