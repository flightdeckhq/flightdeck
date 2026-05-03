import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { LayoutGroup, motion } from "framer-motion";
import type { AgentSummary, AgentTopology, SessionState } from "@/lib/types";
import { ClientType } from "@/lib/agent-identity";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { SubAgentRolePill } from "@/components/facets/SubAgentRolePill";
import { TruncatedText } from "@/components/ui/TruncatedText";
import { CodingAgentBadge } from "@/components/ui/coding-agent-badge";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { bucketFor } from "@/lib/fleet-ordering";
import { INVESTIGATE_DEFAULT_LOOKBACK_MS } from "@/lib/constants";

/**
 * Sortable column whitelist for the agent table. Mirrors the
 * handler-level validSessionSorts on /v1/agents so the UI can sort
 * every column the backend supports without a second round-trip to
 * discover which are valid. ``last_seen_at`` is the default.
 */
export const AGENT_TABLE_SORT_COLUMNS = [
  "agent_name",
  "client_type",
  "agent_type",
  "total_sessions",
  "total_tokens",
  "last_seen_at",
  "state",
] as const;
export type AgentTableSortColumn = (typeof AGENT_TABLE_SORT_COLUMNS)[number];
export type AgentTableSortDirection = "asc" | "desc";

export function isAgentTableSortColumn(value: unknown): value is AgentTableSortColumn {
  return (
    typeof value === "string" &&
    (AGENT_TABLE_SORT_COLUMNS as readonly string[]).includes(value)
  );
}

// State ordinal mirrors the store-side CASE in
// api/internal/store/agents.go. Desc on this column puts "most
// engaged" agents first, same as the backend.
const STATE_ORDINAL: Record<string, number> = {
  active: 5,
  idle: 4,
  stale: 3,
  closed: 2,
  lost: 1,
};

/**
 * Client-side sort over an AgentSummary[] matching the
 * /v1/agents sort columns. Exported for unit tests so the sort
 * behaviour is covered without mounting the component.
 */
export function sortAgents(
  agents: AgentSummary[],
  sort: AgentTableSortColumn,
  order: AgentTableSortDirection,
): AgentSummary[] {
  const cmp = (a: AgentSummary, b: AgentSummary): number => {
    let av: string | number;
    let bv: string | number;
    switch (sort) {
      case "agent_name":
        av = a.agent_name.toLowerCase();
        bv = b.agent_name.toLowerCase();
        break;
      case "client_type":
        av = a.client_type;
        bv = b.client_type;
        break;
      case "agent_type":
        av = a.agent_type;
        bv = b.agent_type;
        break;
      case "total_sessions":
        av = a.total_sessions;
        bv = b.total_sessions;
        break;
      case "total_tokens":
        av = Number(a.total_tokens);
        bv = Number(b.total_tokens);
        break;
      case "last_seen_at":
        av = new Date(a.last_seen_at).getTime();
        bv = new Date(b.last_seen_at).getTime();
        break;
      case "state":
        av = STATE_ORDINAL[a.state] ?? 0;
        bv = STATE_ORDINAL[b.state] ?? 0;
        break;
    }
    if (av < bv) return order === "asc" ? -1 : 1;
    if (av > bv) return order === "asc" ? 1 : -1;
    // Tiebreaker: agent_id asc — matches the backend ordering policy
    // in store/agents.go so split pages stay consistent across
    // re-renders and identical primary-key values never swap.
    if (a.agent_id < b.agent_id) return -1;
    if (a.agent_id > b.agent_id) return 1;
    return 0;
  };
  return [...agents].sort(cmp);
}

/**
 * Investigate-mirror typography constants. The header / cell styles
 * in this file match ``pages/Investigate.tsx``'s session table so
 * the two tables read as a family -- same row height, same uppercase
 * muted header labels, same ``font-mono`` + ``fontSize: 12`` on
 * numeric columns. Keep these constants in sync if Investigate's
 * visual language evolves.
 */
const HEADER_STYLE = {
  color: "var(--text-muted)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.07em",
  padding: "0 12px",
} as const;

const CELL_NUMERIC_STYLE = {
  padding: "0 12px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums" as const,
  color: "var(--text-secondary)",
};

// State rollup colour dots mirror the existing swimlane / Investigate
// palette so the same visual language carries across views.
const STATE_COLORS: Record<string, string> = {
  active: "bg-status-active",
  idle: "bg-status-idle",
  stale: "bg-status-stale",
  closed: "bg-status-closed",
  lost: "bg-status-lost",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const s = Math.round(diffMs / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export interface AgentTableProps {
  agents: AgentSummary[];
  loading: boolean;
  /**
   * Active sort column, or null to use the bucket-ordered input as-is
   * (LIVE → RECENT → IDLE per parent's ``sortAgentsByActivity``). A
   * concrete sort overrides bucket ordering and disables the bucket
   * divider rows, per the Phase 2 plan's "explicit sort overrides
   * bucket ordering" lock.
   */
  sort?: AgentTableSortColumn | null;
  order?: AgentTableSortDirection;
  /**
   * Header click handler. Parent owns the URL-state persistence;
   * the component is stateless with respect to sort. When a user
   * clicks a sortable header this is called with the clicked column
   * and the caller decides whether to toggle direction or switch
   * columns. Omit to render the table in legacy non-sortable mode.
   */
  onSortChange?: (column: AgentTableSortColumn) => void;
}

/**
 * Agent-level fleet table (D115). One row per persistent agent
 * entity. Clicking a row deep-links to Investigate filtered to that
 * agent_id so the operator can drill into the agent's session list.
 *
 * Swimlane rendering lives on in the Timeline / SwimLane family and
 * is the default Fleet view; this table is the paginated alternate
 * reached via the ``?view=table`` toggle.
 */
export function AgentTable({
  agents,
  loading,
  sort = null,
  order = "desc",
  onSortChange,
}: AgentTableProps) {
  const navigate = useNavigate();

  // Apply explicit sort when set; fall back to the parent-supplied
  // bucket order. Memoised on the (agents, sort, order) triplet so
  // the sort only runs when inputs actually change — live traffic
  // re-renders are cheap again.
  const displayedAgents = useMemo(() => {
    if (!sort) return agents;
    return sortAgents(agents, sort, order);
  }, [agents, sort, order]);
  const showBucketDividers = sort === null;

  // Inline header helper — the click, arrow, and aria-sort treatment
  // are identical across every sortable column so centralising here
  // keeps the <thead> readable.
  const renderHeader = (
    column: AgentTableSortColumn,
    label: string,
    extraStyle: React.CSSProperties = {},
  ) => {
    const sortable = typeof onSortChange === "function";
    const isActive = sort === column;
    const ariaSort: "ascending" | "descending" | "none" = isActive
      ? order === "asc"
        ? "ascending"
        : "descending"
      : "none";
    return (
      <th
        className={`uppercase ${sortable ? "cursor-pointer select-none" : ""}`}
        style={{ ...HEADER_STYLE, ...extraStyle }}
        data-testid={`agent-table-header-${column}`}
        aria-sort={ariaSort}
        onClick={() => {
          if (sortable) onSortChange!(column);
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {label}
          {sortable && (
            <span
              data-testid={`agent-table-sort-indicator-${column}`}
              style={{
                fontSize: 10,
                lineHeight: 1,
                color: isActive ? "var(--text)" : "transparent",
                // A hidden placeholder arrow preserves column width
                // whether or not the header is active, so clicking
                // does not nudge adjacent columns.
                width: 8,
                textAlign: "center",
              }}
            >
              {order === "asc" ? "↑" : "↓"}
            </span>
          )}
        </span>
      </th>
    );
  };

  if (!loading && agents.length === 0) {
    return (
      <div
        className="flex items-center justify-center"
        style={{
          height: 192,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        No agents yet. Run the sensor or the Claude Code plugin to
        populate the fleet.
      </div>
    );
  }

  return (
    <div
      className="overflow-auto"
      style={{ border: "1px solid var(--border)", borderRadius: 6 }}
    >
      {/* F3: LayoutGroup coordinates the per-row ``layout`` animation
          on bucket boundary crossings. Without it, each motion.tr
          animates against its own previous bounding box but the
          peer rows that shifted to make room would not animate
          together — the result reads as a single row sliding
          while everything else snaps. */}
      <LayoutGroup>
      <table
        className="w-full text-xs"
        style={{ color: "var(--text)", tableLayout: "fixed" }}
      >
        <thead>
          <tr
            className="sticky top-0 z-10 text-left"
            style={{
              background: "var(--surface)",
              borderBottom: "1px solid var(--border)",
              height: 32,
            }}
          >
            {renderHeader("agent_name", "Agent", { width: "22%" })}
            {renderHeader("client_type", "Client", { width: "8%" })}
            {renderHeader("agent_type", "Type", { width: "8%" })}
            {/* D126 ROLE + TOPOLOGY headers. Not sortable: the
                AgentTableSortColumn whitelist is server-backed and
                role/topology aren't valid sort columns yet (the
                store-side ORDER BY map doesn't include them and
                adding them is a follow-up). Render as plain header
                cells so the click-to-sort treatment is suppressed. */}
            <th
              className="uppercase"
              style={{ ...HEADER_STYLE, width: "10%" }}
              data-testid="agent-table-header-role"
            >
              Role
            </th>
            <th
              className="uppercase"
              style={{ ...HEADER_STYLE, width: "10%" }}
              data-testid="agent-table-header-topology"
            >
              Topology
            </th>
            {renderHeader("total_sessions", "Sessions", {
              width: "8%",
              textAlign: "right",
            })}
            {renderHeader("total_tokens", "Tokens", {
              width: "8%",
              textAlign: "right",
            })}
            {renderHeader("last_seen_at", "Last Active", { width: "12%" })}
            {renderHeader("state", "State", { width: "14%" })}
          </tr>
        </thead>
        <tbody>
          {(() => {
            // Mirror the swimlane's bucket-boundary divider so the
            // table and swimlane read as the same three-tier list.
            // A spanning TR with a thin top border creates a visual
            // gap without a label. Dividers are skipped when the user
            // has applied an explicit column sort — that flow is
            // deliberately "flat by column" rather than "bucketed".
            const now = Date.now();
            let prevBucket: "live" | "recent" | "idle" | null = null;
            const rendered: React.ReactNode[] = [];
            for (const a of displayedAgents) {
              const b = bucketFor(a.last_seen_at, now);
              if (showBucketDividers && prevBucket !== null && b !== prevBucket) {
                rendered.push(
                  <tr
                    key={`bucket-${prevBucket}-to-${b}`}
                    data-testid={`agent-table-bucket-divider-${prevBucket}-${b}`}
                    aria-hidden
                  >
                    <td
                      colSpan={9}
                      style={{
                        height: 1,
                        padding: 0,
                        background: "var(--border)",
                        borderTop: "none",
                        borderBottom: "none",
                      }}
                    />
                  </tr>,
                );
              }
              rendered.push(
            <motion.tr
              key={a.agent_id}
              // F3: layout animates the row to its new sort position
              // when its bucket changes. Since the parent buckets and
              // re-sorts on every render based on ``last_seen_at``,
              // a row crossing a bucket boundary (LIVE→RECENT, etc.)
              // moves to a different DOM position; ``layout`` runs
              // a 300ms FLIP transition rather than a hard cut. The
              // ``layout="position"`` form animates only translation
              // — not size — so the row never deforms during the
              // transition (which a plain ``layout`` would do for
              // table cells whose width is constrained by the
              // colgroup).
              layout="position"
              transition={{ duration: 0.3, ease: "easeOut" }}
              onClick={() => {
                // D115 deep-link: include an explicit 7-day time
                // window so the Investigate page hits the same
                // from/to shape as a facet-click navigation from
                // within Investigate. Relying on parseUrlState's
                // implicit default worked in isolation but left the
                // URL looking filter-less to users who then wondered
                // why it wasn't showing every session. Matching
                // Investigate's default keeps the URL self-describing.
                const from = new Date(Date.now() - INVESTIGATE_DEFAULT_LOOKBACK_MS).toISOString();
                const to = new Date().toISOString();
                const sp = new URLSearchParams();
                sp.set("from", from);
                sp.set("to", to);
                sp.set("agent_id", a.agent_id);
                navigate(`/investigate?${sp.toString()}`);
              }}
              className="cursor-pointer transition-colors duration-150"
              style={{
                height: 44,
                borderBottom: "1px solid var(--border-subtle)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(128,128,128,0.08)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "";
              }}
              data-testid={`fleet-agent-row-${a.agent_id}`}
            >
              <td
                style={{
                  padding: "0 12px",
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--text)",
                  // Cells drop the raw ``truncate`` Tailwind class;
                  // inner ``<TruncatedText/>`` surfaces the full
                  // value via native ``title`` on hover when the
                  // ellipsis actually renders.
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    maxWidth: "100%",
                  }}
                >
                  {a.client_type === ClientType.ClaudeCode && (
                    <ClaudeCodeLogo size={14} className="shrink-0" />
                  )}
                  <TruncatedText text={a.agent_name} />
                </span>
                <TruncatedText
                  as="div"
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    marginTop: 2,
                  }}
                  text={`${a.user}@${a.hostname}`}
                />
              </td>
              <td
                style={{
                  padding: "0 12px",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <ClientTypePill
                  clientType={a.client_type}
                  testId="agent-table-client-pill"
                />
              </td>
              <td
                style={{
                  padding: "0 12px",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                {a.agent_type === "coding" ? <CodingAgentBadge /> : (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-muted)",
                    }}
                  >
                    {a.agent_type}
                  </span>
                )}
              </td>
              <td
                style={{
                  padding: "0 12px",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  overflow: "hidden",
                }}
                data-testid={`agent-table-role-${a.agent_id}`}
              >
                {a.agent_role ? (
                  <TruncatedText
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--text)",
                    }}
                    text={a.agent_role}
                  />
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>—</span>
                )}
              </td>
              <td
                style={{
                  padding: "0 12px",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
                data-testid={`agent-table-topology-${a.agent_id}`}
              >
                <TopologyPill topology={a.topology} role={a.agent_role ?? undefined} />
              </td>
              <td
                className="text-right"
                style={CELL_NUMERIC_STYLE}
              >
                {a.total_sessions}
              </td>
              <td
                className="text-right"
                style={CELL_NUMERIC_STYLE}
              >
                {formatTokens(Number(a.total_tokens))}
              </td>
              <td
                style={{
                  padding: "0 12px",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                {relativeTime(a.last_seen_at)}
              </td>
              <td style={{ padding: "0 12px", fontSize: 12 }}>
                <StateDot state={a.state} />
              </td>
            </motion.tr>,
              );
              prevBucket = b;
            }
            return rendered;
          })()}
        </tbody>
      </table>
      </LayoutGroup>
    </div>
  );
}

/**
 * D126 topology pill. ``lone`` renders as a muted em-dash so the
 * column doesn't shout for non-relationship rows; ``parent`` and
 * ``child`` reuse SubAgentRolePill so the visual language matches
 * the SwimLane and SubAgentsTab. The ``role`` prop is forwarded for
 * child/parent rendering — ``parent`` rows never carry an
 * agent_role themselves, so the pill renders the literal label
 * "parent" via SubAgentRolePill's empty-role fallback.
 */
function TopologyPill({
  topology,
  role,
}: {
  topology: AgentTopology;
  role?: string;
}) {
  if (topology === "lone") {
    return (
      <span
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}
        data-testid="agent-table-topology-pill-lone"
      >
        lone
      </span>
    );
  }
  return (
    <SubAgentRolePill
      role={role ?? ""}
      topology={topology}
      testId={`agent-table-topology-pill-${topology}`}
    />
  );
}

function StateDot({ state }: { state: SessionState | "" }) {
  if (!state) {
    return (
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>—</span>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--text)",
      }}
    >
      <span
        className={`inline-block size-2 rounded-full ${
          STATE_COLORS[state] ?? "bg-muted"
        }`}
      />
      <span style={{ textTransform: "capitalize" }}>{state}</span>
    </span>
  );
}
