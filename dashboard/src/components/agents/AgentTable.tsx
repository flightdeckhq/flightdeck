import { useMemo, useState } from "react";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";
import {
  type AgentSortColumn,
  type SortState,
  sortAgents,
  toggleSort,
} from "@/lib/agents-sort";
import { AgentTableRow } from "./AgentTableRow";

interface AgentTableProps {
  agents: AgentSummary[];
  /** Per-agent summaries the parent has cached. Drives the sort
   *  key for KPI columns. */
  summariesByAgentId: Map<string, AgentSummaryResponse>;
  /** Row click — host page opens the agent drawer. */
  onOpenDrawer: (agent: AgentSummary) => void;
  /** Status-badge click on a row — host page mounts the
   *  per-agent swimlane modal. */
  onOpenSwimlaneModal: (agent: AgentSummary) => void;
}

const PAGE_SIZE = 50;

interface ColumnSpec {
  column: AgentSortColumn;
  label: string;
  /** Visual alignment of the header cell. Numeric KPI columns
   *  read left-aligned because the sparkline tile follows the
   *  total to the right; the operator scans the number first. */
  align?: "left" | "right";
}

const COLUMNS: ColumnSpec[] = [
  { column: "agent_name", label: "Agent" },
  { column: "topology", label: "Topology" },
  { column: "tokens_7d", label: "Tokens (7d)" },
  { column: "latency_p95_7d", label: "Latency p95 (7d)" },
  { column: "errors_7d", label: "Errors (7d)" },
  { column: "sessions_7d", label: "Sessions (7d)" },
  { column: "cost_usd_7d", label: "Cost (7d)" },
  { column: "last_seen_at", label: "Last seen" },
  { column: "state", label: "Status", align: "right" },
];

export function AgentTable({
  agents,
  summariesByAgentId,
  onOpenDrawer,
  onOpenSwimlaneModal,
}: AgentTableProps) {
  const [sort, setSort] = useState<SortState>({
    column: "state",
    direction: "desc",
  });
  const [page, setPage] = useState(0);

  const sorted = useMemo(
    () => sortAgents(agents, summariesByAgentId, sort),
    [agents, summariesByAgentId, sort],
  );
  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div data-testid="agent-table-wrapper">
      <table
        data-testid="agent-table"
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr
            style={{
              borderBottom: "1px solid var(--border)",
              background: "var(--surface)",
            }}
          >
            {COLUMNS.map((col) => {
              const isActive = sort.column === col.column;
              const arrow = isActive
                ? sort.direction === "asc"
                  ? "↑"
                  : "↓"
                : "";
              return (
                <th
                  key={col.column}
                  scope="col"
                  data-testid={`agent-table-th-${col.column}`}
                  data-sort-active={isActive ? "true" : undefined}
                  data-sort-direction={isActive ? sort.direction : undefined}
                  aria-sort={
                    isActive
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  tabIndex={0}
                  style={{
                    textAlign: col.align ?? "left",
                    padding: "8px 12px",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    cursor: "pointer",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                  }}
                  onClick={() => setSort((s) => toggleSort(s, col.column))}
                  onKeyDown={(e) => {
                    // Enter / Space sort the column — `<th>` is not
                    // in the tab order or keyboard-actionable by
                    // default, so the explicit tabIndex + handler
                    // give keyboard users parity with the click.
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSort((s) => toggleSort(s, col.column));
                    }
                  }}
                >
                  {col.label}
                  {arrow && (
                    <span
                      style={{ marginLeft: 4, color: "var(--accent)" }}
                      aria-hidden="true"
                    >
                      {arrow}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {slice.map((a) => (
            <AgentTableRow
              key={a.agent_id}
              agent={a}
              onOpenDrawer={onOpenDrawer}
              onOpenSwimlaneModal={onOpenSwimlaneModal}
            />
          ))}
          {slice.length === 0 && (
            <tr data-testid="agent-table-empty">
              <td
                colSpan={COLUMNS.length}
                style={{
                  textAlign: "center",
                  padding: "32px 12px",
                  color: "var(--text-muted)",
                  fontSize: 13,
                }}
              >
                No agents match the active filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {total > PAGE_SIZE && (
        <div
          data-testid="agent-table-pagination"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            borderTop: "1px solid var(--border-subtle)",
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span data-testid="agent-table-pagination-counts">
            {safePage * PAGE_SIZE + 1}-
            {Math.min((safePage + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="agent-table-page-prev"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 3,
                border: "1px solid var(--border)",
                background: "transparent",
                color: safePage === 0 ? "var(--text-muted)" : "var(--text)",
                cursor: safePage === 0 ? "not-allowed" : "pointer",
              }}
            >
              ← Prev
            </button>
            <button
              type="button"
              data-testid="agent-table-page-next"
              disabled={safePage >= pageCount - 1}
              onClick={() =>
                setPage((p) => Math.min(pageCount - 1, p + 1))
              }
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 3,
                border: "1px solid var(--border)",
                background: "transparent",
                color:
                  safePage >= pageCount - 1
                    ? "var(--text-muted)"
                    : "var(--text)",
                cursor:
                  safePage >= pageCount - 1 ? "not-allowed" : "pointer",
              }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
