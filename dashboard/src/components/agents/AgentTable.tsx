import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";
import {
  type AgentSortColumn,
  type SortState,
  deriveFamilyDescendantSet,
  paginateFamilies,
  sortAgentsWithFamilies,
  toggleSort,
} from "@/lib/agents-sort";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

// STATUS sits second so the operator's eye lands on the
// rolled-up state immediately after the identity column, and the
// chip's hover affordance draws attention to it as a clickable
// shortcut into the per-agent swimlane modal. State stays the
// default sort. The trailing actions cell (rendered after Last
// seen) keeps only the Events shortcut; the duplicate status
// badge that historically lived there is retired now that the
// chip is its own column.
const COLUMNS: ColumnSpec[] = [
  { column: "agent_name", label: "Agent" },
  { column: "state", label: "Status" },
  { column: "topology", label: "Topology" },
  { column: "tokens_7d", label: "Tokens (7d)" },
  { column: "latency_p95_7d", label: "Latency p95 (7d)" },
  { column: "errors_7d", label: "Errors (7d)" },
  { column: "sessions_7d", label: "Sessions (7d)" },
  { column: "cost_usd_7d", label: "Cost (7d)" },
  { column: "last_seen_at", label: "Last seen" },
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

  // Family-grouped sort: parents (and lone agents) order as
  // families by the active column; each family's children render
  // directly under their root. Orphan children (parent not in
  // the current ``agents`` slice) become single-row families at
  // their own sort position.
  const sorted = useMemo(
    () => sortAgentsWithFamilies(agents, summariesByAgentId, sort),
    [agents, summariesByAgentId, sort],
  );
  // Descendant set — drives the per-row ``data-topology="child"``
  // stamp on ``AgentTableRow`` so the existing
  // ``[data-topology="child"] > td:first-child`` rule in
  // ``globals.css`` lands the 28-px first-cell indent.
  const descendantSet = useMemo(
    () => deriveFamilyDescendantSet(agents),
    [agents],
  );
  // Family-respecting pagination: a family never splits across a
  // page boundary. The page renders fewer than ``PAGE_SIZE`` rows
  // when an in-progress family would straddle. The total counter
  // below still counts agents (not families).
  const pages = useMemo(
    () => paginateFamilies(sorted, descendantSet, PAGE_SIZE),
    [sorted, descendantSet],
  );
  const total = sorted.length;
  const pageCount = Math.max(1, pages.length);
  const safePage = Math.min(page, pageCount - 1);
  const slice = pages[safePage] ?? [];

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
        {/* One TooltipProvider for the whole header row — Radix
            renders no DOM node, so it does not break the table's
            thead/tbody structure, and it is not recreated per-`<th>`
            on every sort re-render. */}
        <TooltipProvider>
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
                  {col.column === "cost_usd_7d" && (
                    // Info affordance for the estimated-cost
                    // semantics. The trigger stops click /
                    // keydown propagation so hovering or
                    // focusing the icon never toggles the
                    // column sort — the sort stays driven by
                    // the rest of the `<th>`.
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          data-testid="agent-table-cost-info"
                          tabIndex={0}
                          aria-label="About cost estimation"
                          style={{
                            display: "inline-flex",
                            verticalAlign: "middle",
                            marginLeft: 4,
                            cursor: "help",
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Info
                            size={12}
                            style={{ color: "var(--text-muted)" }}
                            aria-hidden="true"
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Estimated from public list prices.
                        Sensor-instrumented agents only; coding
                        agents bill independently.
                      </TooltipContent>
                    </Tooltip>
                  )}
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
            {/* Actions column — not in COLUMNS (not sortable),
                but the data rows render a trailing <td> for the
                Events shortcut. The header <th> is required so
                screen readers can enumerate every column and the
                empty-state cell's colSpan stays aligned. */}
            <th
              scope="col"
              aria-label="Actions"
              data-testid="agent-table-th-actions"
              style={{
                padding: "8px 12px",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                whiteSpace: "nowrap",
                textAlign: "right",
              }}
            />
          </tr>
        </thead>
        </TooltipProvider>
        <tbody>
          {slice.map((a) => (
            <AgentTableRow
              key={a.agent_id}
              agent={a}
              isFamilyDescendant={descendantSet.has(a.agent_id)}
              onOpenDrawer={onOpenDrawer}
              onOpenSwimlaneModal={onOpenSwimlaneModal}
            />
          ))}
          {slice.length === 0 && (
            <tr data-testid="agent-table-empty">
              {/* +1 spans the trailing actions column whose <th>
                  lives outside COLUMNS (the row renders an extra
                  <td> for the Events shortcut). */}
              <td
                colSpan={COLUMNS.length + 1}
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
      {pageCount > 1 && (
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
          {/* Family-respecting pagination produces variable-size
              pages, so the displayed range is computed from the
              actual page slice sizes, not a fixed PAGE_SIZE
              multiplier. ``startIdx`` is the count of rows on
              all preceding pages + 1 (1-indexed for display). */}
          <span data-testid="agent-table-pagination-counts">
            {pages.slice(0, safePage).reduce((sum, p) => sum + p.length, 0) +
              1}
            -
            {pages
              .slice(0, safePage + 1)
              .reduce((sum, p) => sum + p.length, 0)}{" "}
            of {total}
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
