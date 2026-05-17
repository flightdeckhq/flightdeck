import { useState } from "react";
import type { SessionListItem } from "@/lib/types";
import { AgentStatusBadge } from "@/components/timeline/AgentStatusBadge";
import {
  formatDuration,
  formatTokens,
  relativeTime,
} from "@/lib/agents-format";
import {
  type RunSortColumn,
  type RunSortState,
  useAgentRuns,
} from "@/hooks/useAgentRuns";

const PAGE_SIZE = 50;

interface AgentDrawerRunsTabProps {
  agentId: string;
  /** Row click — opens the run drawer for that run. */
  onRunClick: (sessionId: string) => void;
}

interface RunColumn {
  label: string;
  /** Set when the column is server-sortable. */
  sortColumn?: RunSortColumn;
  align?: "left" | "right";
}

const COLUMNS: RunColumn[] = [
  { label: "Started", sortColumn: "started_at" },
  { label: "Duration", sortColumn: "duration", align: "right" },
  { label: "Status", sortColumn: "state" },
  { label: "Tokens", sortColumn: "tokens_used", align: "right" },
  { label: "Errors", align: "right" },
  { label: "", align: "right" },
];

/**
 * Agent drawer Runs tab — a paginated, sortable list of the agent's
 * runs (sessions). Backed by `useAgentRuns` (`GET /v1/sessions?agent_id=`).
 */
export function AgentDrawerRunsTab({
  agentId,
  onRunClick,
}: AgentDrawerRunsTabProps) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<RunSortState>({
    column: "started_at",
    direction: "desc",
  });
  const { runs, total, loading, error } = useAgentRuns(
    agentId,
    page,
    PAGE_SIZE,
    sort,
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggleSort(column: RunSortColumn) {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "desc" },
    );
    setPage(0);
  }

  return (
    <div
      data-testid="agent-drawer-runs-tab"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div style={{ flex: 1, overflow: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
        >
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--border)",
                background: "var(--surface)",
              }}
            >
              {COLUMNS.map((col, i) => {
                const active =
                  col.sortColumn !== undefined && sort.column === col.sortColumn;
                const sortable = col.sortColumn !== undefined;
                return (
                  <th
                    key={col.label || `col-${i}`}
                    scope="col"
                    aria-sort={
                      active
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : sortable
                          ? "none"
                          : undefined
                    }
                    tabIndex={sortable ? 0 : undefined}
                    onClick={
                      sortable
                        ? () => toggleSort(col.sortColumn!)
                        : undefined
                    }
                    onKeyDown={
                      sortable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleSort(col.sortColumn!);
                            }
                          }
                        : undefined
                    }
                    data-testid={
                      sortable
                        ? `agent-drawer-runs-th-${col.sortColumn}`
                        : undefined
                    }
                    style={{
                      textAlign: col.align ?? "left",
                      padding: "6px 10px",
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--text-secondary)",
                      cursor: sortable ? "pointer" : "default",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {col.label}
                    {active && (
                      <span
                        aria-hidden="true"
                        style={{ marginLeft: 3, color: "var(--accent)" }}
                      >
                        {sort.direction === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <RunRow key={run.session_id} run={run} onClick={onRunClick} />
            ))}
            {!error && !loading && runs.length === 0 && (
              <tr data-testid="agent-drawer-runs-empty">
                <td
                  colSpan={COLUMNS.length}
                  style={{
                    padding: 16,
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  No runs recorded for this agent.
                </td>
              </tr>
            )}
            {!error && loading && runs.length === 0 && (
              <tr data-testid="agent-drawer-runs-loading">
                <td
                  colSpan={COLUMNS.length}
                  style={{
                    padding: 16,
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  Loading runs…
                </td>
              </tr>
            )}
            {error && (
              <tr data-testid="agent-drawer-runs-error">
                <td
                  colSpan={COLUMNS.length}
                  style={{
                    padding: 16,
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--danger)",
                  }}
                >
                  Could not load runs for this agent.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {total > PAGE_SIZE && (
        <div
          data-testid="agent-drawer-runs-pagination"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 12px",
            borderTop: "1px solid var(--border-subtle)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          <span data-testid="agent-drawer-runs-pagination-counts">
            {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of{" "}
            {total}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="agent-drawer-runs-prev"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              style={runPaginationButtonStyle(page === 0)}
            >
              ← Prev
            </button>
            <button
              type="button"
              data-testid="agent-drawer-runs-next"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              style={runPaginationButtonStyle(page >= pageCount - 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  onClick,
}: {
  run: SessionListItem;
  onClick: (sessionId: string) => void;
}) {
  const errorCount = run.error_types?.length ?? 0;
  const closeReason = run.close_reasons?.[0];
  const attached = (run.attachment_count ?? 0) > 0;
  return (
    <tr
      data-testid={`agent-drawer-run-row-${run.session_id}`}
      tabIndex={0}
      onClick={() => onClick(run.session_id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(run.session_id);
        }
      }}
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        cursor: "pointer",
      }}
    >
      <td
        style={{ padding: "6px 10px", fontFamily: "var(--font-mono)" }}
        title={new Date(run.started_at).toLocaleString()}
      >
        {relativeTime(run.started_at)}
      </td>
      <td
        style={{
          padding: "6px 10px",
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
        }}
      >
        {formatDuration(run.duration_s)}
      </td>
      <td style={{ padding: "6px 10px" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <AgentStatusBadge state={run.state} />
          {closeReason && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                padding: "1px 4px",
                borderRadius: 3,
                border: "1px solid var(--border-subtle)",
                color: "var(--text-muted)",
              }}
            >
              {closeReason}
            </span>
          )}
        </span>
      </td>
      <td
        style={{
          padding: "6px 10px",
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
        }}
      >
        {formatTokens(run.tokens_used)}
      </td>
      <td
        style={{
          padding: "6px 10px",
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          color: errorCount > 0 ? "var(--danger)" : "var(--text-muted)",
        }}
      >
        {errorCount}
      </td>
      <td style={{ padding: "6px 10px", textAlign: "right" }}>
        {attached && (
          <span
            data-testid="agent-drawer-run-attached-pill"
            title={`Re-attached ${run.attachment_count} time(s)`}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 999,
              border: "1px solid var(--accent)",
              color: "var(--accent)",
            }}
          >
            ↻ {run.attachment_count}
          </span>
        )}
      </td>
    </tr>
  );
}

function runPaginationButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 3,
    border: "1px solid var(--border)",
    background: "transparent",
    color: disabled ? "var(--text-muted)" : "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
