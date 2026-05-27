import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import type { AgentSummary, AgentSummaryResponse } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  /** Visual alignment of the header cell. KPI columns read
   *  left-aligned: the operator scans the numeric total first and
   *  the sparkline tile follows immediately to the right, so the
   *  number lands at the left edge of the cell beneath a
   *  left-aligned header. The primitive supports ``align="right"``
   *  for tables where the cell content reads right-anchored, but
   *  the Agents KPI layout is left by convention. */
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

  // Augment the parent-resolution input with the fleet store's
  // flavors view. ``AgentSummary.recent_sessions`` is capped at 5
  // per agent on both server and client, so a busy parent that
  // has spawned 5+ sessions since starting a sub-agent can roll
  // the spawn-context session out of its own window — the linkage
  // then fails to resolve on that source alone, and the child
  // floats away from its parent under any sort. The flavors view
  // carries the broader ``/v1/sessions`` window and recovers the
  // linkage. The two sources are complementary; see
  // ``resolveParents`` in agents-sort.ts for the full rationale.
  const flavors = useFleetStore((s) => s.flavors);

  // Family-grouped sort: parents (and lone agents) order as
  // families by the active column; each family's children render
  // directly under their root. Orphan children (parent not in
  // the current ``agents`` slice) become single-row families at
  // their own sort position.
  const sorted = useMemo(
    () => sortAgentsWithFamilies(agents, summariesByAgentId, sort, flavors),
    [agents, summariesByAgentId, sort, flavors],
  );
  // Descendant set — drives the per-row ``data-topology="child"``
  // stamp on ``AgentTableRow`` so the existing
  // ``[data-topology="child"] > td:first-child`` rule in
  // ``globals.css`` lands the 28-px first-cell indent.
  const descendantSet = useMemo(
    () => deriveFamilyDescendantSet(agents, flavors),
    [agents, flavors],
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
      <Table data-testid="agent-table">
        {/* One TooltipProvider for the whole header row — Radix
            renders no DOM node, so it does not break the table's
            thead/tbody structure, and it is not recreated per-`<th>`
            on every sort re-render. */}
        <TooltipProvider>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((col) => {
                const isActive = sort.column === col.column;
                const arrow = isActive
                  ? sort.direction === "asc"
                    ? "↑"
                    : "↓"
                  : "";
                return (
                  <TableHead
                    key={col.column}
                    align={col.align}
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
                    className="cursor-pointer select-none"
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
                            className="ml-1 inline-flex align-middle cursor-help"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <Info
                              size={12}
                              className="text-text-muted"
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
                        className="ml-1 text-accent"
                        aria-hidden="true"
                      >
                        {arrow}
                      </span>
                    )}
                  </TableHead>
                );
              })}
              {/* Actions column — not in COLUMNS (not sortable), but
                  data rows render a trailing cell for the Events
                  shortcut. The header is required so screen readers
                  enumerate every column and the empty-state cell's
                  colSpan stays aligned. */}
              <TableHead
                align="right"
                aria-label="Actions"
                data-testid="agent-table-th-actions"
              />
            </TableRow>
          </TableHeader>
        </TooltipProvider>
        <TableBody>
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
            <TableRow data-testid="agent-table-empty">
              {/* +1 spans the trailing actions column whose header
                  lives outside COLUMNS (the row renders an extra
                  cell for the Events shortcut). */}
              <TableCell
                colSpan={COLUMNS.length + 1}
                align="center"
                className="py-8 text-text-muted text-[13px]"
              >
                No agents match the active filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {pageCount > 1 && (
        <div
          data-testid="agent-table-pagination"
          className="flex items-center justify-between px-3 py-2 border-t border-border-subtle text-[11px] text-text-muted font-mono"
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
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="agent-table-page-prev"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="text-[11px] px-2 py-0.5 rounded-sm border border-border bg-transparent text-text disabled:text-text-muted disabled:cursor-not-allowed cursor-pointer"
            >
              ← Prev
            </button>
            <button
              type="button"
              data-testid="agent-table-page-next"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="text-[11px] px-2 py-0.5 rounded-sm border border-border bg-transparent text-text disabled:text-text-muted disabled:cursor-not-allowed cursor-pointer"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
