import { useMemo, useState } from "react";
import { FlaskConical, AlertTriangle } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { ApiError, dryRunMCPPolicy } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  MCPPolicy,
  MCPPolicyDryRunResult,
  MCPPolicyMutation,
  MCPPolicyMutationEntry,
} from "@/lib/types";

type Hours = 24 | 168;

const HOUR_OPTIONS: { value: Hours; label: string }[] = [
  { value: 24, label: "Last 24h" },
  { value: 168, label: "Last 7 days" },
];

const COLOUR_ALLOW = "var(--success, #16a34a)";
const COLOUR_WARN = "var(--warning, #d97706)";
const COLOUR_BLOCK = "var(--danger)";

export interface MCPPolicyDryRunPanelProps {
  /** "global" or a flavor name. */
  flavor: string;
  scopeKey: string;
  /** Source policy used as the dry-run draft. */
  policy: MCPPolicy;
}

interface ChartRow {
  fingerprint: string;
  server_name: string;
  would_allow: number;
  would_warn: number;
  would_block: number;
  total: number;
}

/**
 * Replays the last N hours of recorded ``mcp_tool_call`` events
 * through the *current saved* policy via
 * ``POST /v1/mcp-policies/:flavor/dry_run`` and renders the
 * per-server outcome breakdown as a stacked horizontal bar
 * (allow / warn / block segments). The architecture's "current
 * draft" intent is honoured by sending the policy state visible
 * on the page; saving a new policy and rerunning the dry-run is
 * the workflow for "what would my new policy do."
 *
 * 168h (7 day) maximum is the hard cap from D137; the picker
 * exposes 24h and 7d only — finer granularity can land later.
 *
 * The unresolvable count callout sits at the top right as an
 * amber pill: events that referenced a server URL the policy
 * couldn't classify (e.g. a server uninstalled mid-period). Not
 * a failure — a teaching opportunity for the operator to add an
 * entry covering those servers.
 */
export function MCPPolicyDryRunPanel({
  flavor,
  scopeKey,
  policy,
}: MCPPolicyDryRunPanelProps) {
  const [hours, setHours] = useState<Hours>(24);
  const [result, setResult] = useState<MCPPolicyDryRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dry-run only fires on POST /:flavor/dry_run. The global
  // dry-run isn't exposed by the API (D137 power-feature is
  // flavor-only); the panel hides itself at the call site for the
  // global tab. The policy-derived mutation body mirrors the
  // saved state so the operator sees what the active policy would
  // have done — pre-save what-if exploration is a future
  // enhancement that needs a draft model.
  const draftMutation = useMemo<MCPPolicyMutation>(
    () => mutationFromPolicy(policy),
    [policy],
  );

  async function runDryRun() {
    setRunning(true);
    setError(null);
    try {
      const r = await dryRunMCPPolicy(flavor, draftMutation, hours);
      setResult(r);
    } catch (err) {
      setResult(null);
      if (err instanceof ApiError && err.status === 403) {
        setError("Admin token required to run dry-run.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("Dry-run rejected: the policy draft failed validation.");
      } else {
        setError(err instanceof Error ? err.message : "Dry-run failed");
      }
    } finally {
      setRunning(false);
    }
  }

  const rows = useMemo<ChartRow[]>(() => {
    if (!result) return [];
    return result.per_server
      .map((s) => ({
        ...s,
        total: s.would_allow + s.would_warn + s.would_block,
      }))
      .sort((a, b) => b.total - a.total);
  }, [result]);

  return (
    <section
      className="rounded-md border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid={`mcp-policy-dry-run-${scopeKey}`}
    >
      <header
        className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <FlaskConical
            className="h-4 w-4"
            style={{ color: "var(--text-muted)" }}
            aria-hidden="true"
          />
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text)" }}
          >
            Dry-run preview
          </h2>
          <span
            className="text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            replays recorded MCP traffic against the saved policy
          </span>
        </div>
        <div className="flex items-center gap-2">
          <HoursPicker
            value={hours}
            onChange={setHours}
            scopeKey={scopeKey}
          />
          <Button
            size="sm"
            onClick={runDryRun}
            disabled={running}
            data-testid={`mcp-policy-dry-run-button-${scopeKey}`}
          >
            {running ? "Running…" : result ? "Re-run" : "Run dry-run"}
          </Button>
        </div>
      </header>

      <div className="p-4">
        {error ? (
          <ErrorState message={error} />
        ) : !result ? (
          <IdleState />
        ) : rows.length === 0 ? (
          <EmptyState eventsReplayed={result.events_replayed} />
        ) : (
          <div className="space-y-3">
            <ResultHeader result={result} />
            <Legend />
            <ChartBlock rows={rows} />
          </div>
        )}
      </div>
    </section>
  );
}

function mutationFromPolicy(policy: MCPPolicy): MCPPolicyMutation {
  const entries: MCPPolicyMutationEntry[] = (policy.entries ?? []).map(
    (e) => ({
      server_url: e.server_url,
      server_name: e.server_name,
      entry_kind: e.entry_kind,
      enforcement: e.enforcement ?? null,
    }),
  );
  return {
    mode: policy.mode ?? null,
    block_on_uncertainty: policy.block_on_uncertainty,
    entries,
  };
}

function HoursPicker({
  value,
  onChange,
  scopeKey,
}: {
  value: Hours;
  onChange: (next: Hours) => void;
  scopeKey: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Dry-run window"
      className="inline-flex rounded-md border p-0.5"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid={`mcp-policy-dry-run-hours-${scopeKey}`}
    >
      {HOUR_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            value === opt.value
              ? "bg-[var(--surface)] text-[var(--text)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
          data-testid={`mcp-policy-dry-run-hours-${scopeKey}-${opt.value}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ResultHeader({ result }: { result: MCPPolicyDryRunResult }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 text-[12px]"
      style={{ color: "var(--text-muted)" }}
      data-testid="mcp-policy-dry-run-summary"
    >
      <span>
        Events replayed:{" "}
        <span style={{ color: "var(--text)", fontWeight: 600 }}>
          {result.events_replayed}
        </span>
      </span>
      <span>
        Window:{" "}
        <span style={{ color: "var(--text)" }}>
          {result.hours}h
        </span>
      </span>
      {result.unresolvable_count > 0 ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
          style={{
            borderColor: COLOUR_WARN,
            background: `color-mix(in srgb, ${COLOUR_WARN} 10%, transparent)`,
            color: COLOUR_WARN,
          }}
          title="Events referenced a server URL the policy couldn't classify"
          data-testid="mcp-policy-dry-run-unresolvable"
        >
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {result.unresolvable_count} unresolvable
        </span>
      ) : null}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-[11px]" aria-hidden="true">
      <LegendDot colour={COLOUR_ALLOW} label="Would allow" />
      <LegendDot colour={COLOUR_WARN} label="Would warn" />
      <LegendDot colour={COLOUR_BLOCK} label="Would block" />
    </div>
  );
}

function LegendDot({ colour, label }: { colour: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{ color: "var(--text-muted)" }}
    >
      <span
        className="inline-block h-2 w-2 rounded-sm"
        style={{ background: colour }}
      />
      {label}
    </span>
  );
}

function ChartBlock({ rows }: { rows: ChartRow[] }) {
  const height = Math.max(rows.length * 28 + 40, 120);
  return (
    <div style={{ height }} data-testid="mcp-policy-dry-run-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            horizontal={false}
          />
          <XAxis
            type="number"
            stroke="var(--text-muted)"
            tick={{ fontSize: 11 }}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="server_name"
            stroke="var(--text-muted)"
            tick={{ fontSize: 11 }}
            width={120}
          />
          <RechartsTooltip
            cursor={{
              fill: "color-mix(in srgb, var(--accent) 8%, transparent)",
            }}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--text)",
            }}
            labelStyle={{ color: "var(--text)" }}
            formatter={(value, name) => {
              const v = typeof value === "number" ? value : 0;
              const key = String(name);
              if (key === "would_allow") return [v, "Would allow"];
              if (key === "would_warn") return [v, "Would warn"];
              if (key === "would_block") return [v, "Would block"];
              return [v, key];
            }}
          />
          <Bar dataKey="would_allow" stackId="counts">
            {rows.map((row) => (
              <Cell
                key={`a-${row.fingerprint}`}
                fill={COLOUR_ALLOW}
              />
            ))}
          </Bar>
          <Bar dataKey="would_warn" stackId="counts">
            {rows.map((row) => (
              <Cell
                key={`w-${row.fingerprint}`}
                fill={COLOUR_WARN}
              />
            ))}
          </Bar>
          <Bar dataKey="would_block" stackId="counts">
            {rows.map((row) => (
              <Cell
                key={`b-${row.fingerprint}`}
                fill={COLOUR_BLOCK}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function IdleState() {
  return (
    <div
      className="rounded-md border px-4 py-6 text-center text-sm"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
        color: "var(--text-muted)",
      }}
      data-testid="mcp-policy-dry-run-idle"
    >
      Click <span style={{ color: "var(--text)" }}>Run dry-run</span> to
      replay the selected window of MCP traffic against the saved policy.
    </div>
  );
}

function EmptyState({ eventsReplayed }: { eventsReplayed: number }) {
  return (
    <div
      className="rounded-md border px-4 py-6 text-center text-sm"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
        color: "var(--text-muted)",
      }}
      data-testid="mcp-policy-dry-run-empty"
    >
      {eventsReplayed === 0
        ? "No MCP traffic recorded in this window."
        : "Replay returned no per-server breakdown."}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: "var(--danger)",
        background: "color-mix(in srgb, var(--danger) 10%, transparent)",
        color: "var(--danger)",
      }}
      data-testid="mcp-policy-dry-run-error"
    >
      {message}
    </div>
  );
}
