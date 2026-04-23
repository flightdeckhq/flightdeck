import React from "react";
import { useNavigate } from "react-router-dom";
import type { AgentSummary, SessionState } from "@/lib/types";
import { ClientType } from "@/lib/agent-identity";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { CodingAgentBadge } from "@/components/ui/coding-agent-badge";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { bucketFor } from "@/lib/fleet-ordering";

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
export function AgentTable({ agents, loading }: AgentTableProps) {
  const navigate = useNavigate();

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
            <th className="uppercase" style={{ ...HEADER_STYLE, width: "28%" }}>
              Agent
            </th>
            <th className="uppercase" style={{ ...HEADER_STYLE, width: "10%" }}>
              Client
            </th>
            <th className="uppercase" style={{ ...HEADER_STYLE, width: "10%" }}>
              Type
            </th>
            <th
              className="uppercase text-right"
              style={{ ...HEADER_STYLE, width: "10%" }}
            >
              Sessions
            </th>
            <th
              className="uppercase text-right"
              style={{ ...HEADER_STYLE, width: "10%" }}
            >
              Tokens
            </th>
            <th className="uppercase" style={{ ...HEADER_STYLE, width: "14%" }}>
              Last Active
            </th>
            <th className="uppercase" style={{ ...HEADER_STYLE, width: "18%" }}>
              State
            </th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            // Mirror the swimlane's bucket-boundary divider so the
            // table and swimlane read as the same three-tier list.
            // A spanning TR with a thin top border creates a visual
            // gap without a label.
            const now = Date.now();
            let prevBucket: "live" | "recent" | "idle" | null = null;
            const rendered: React.ReactNode[] = [];
            for (const a of agents) {
              const b = bucketFor(a.last_seen_at, now);
              if (prevBucket !== null && b !== prevBucket) {
                rendered.push(
                  <tr
                    key={`bucket-${prevBucket}-to-${b}`}
                    data-testid={`agent-table-bucket-divider-${prevBucket}-${b}`}
                    aria-hidden
                  >
                    <td
                      colSpan={7}
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
            <tr
              key={a.agent_id}
              onClick={() => {
                // D115 deep-link: include an explicit 7-day time
                // window so the Investigate page hits the same
                // from/to shape as a facet-click navigation from
                // within Investigate. Relying on parseUrlState's
                // implicit default worked in isolation but left the
                // URL looking filter-less to users who then wondered
                // why it wasn't showing every session. Matching
                // Investigate's default keeps the URL self-describing.
                const from = new Date(Date.now() - 7 * 86400000).toISOString();
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
                className="truncate"
                style={{
                  padding: "0 12px",
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--text)",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                  }}
                >
                  {a.client_type === ClientType.ClaudeCode && (
                    <ClaudeCodeLogo size={14} className="shrink-0" />
                  )}
                  <span className="truncate">{a.agent_name}</span>
                </span>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    marginTop: 2,
                  }}
                >
                  {a.user}@{a.hostname}
                </div>
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
            </tr>,
              );
              prevBucket = b;
            }
            return rendered;
          })()}
        </tbody>
      </table>
    </div>
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
