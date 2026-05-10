import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SyntaxJson } from "@/components/ui/syntax-json";
import { listMCPPolicyAuditLog } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MCPPolicyAuditLog } from "@/lib/types";

const EVENT_TYPES = [
  { value: "", label: "All event types" },
  { value: "policy_created", label: "policy_created" },
  { value: "policy_updated", label: "policy_updated" },
  { value: "policy_deleted", label: "policy_deleted" },
  { value: "mode_changed", label: "mode_changed" },
  { value: "entry_added", label: "entry_added" },
  { value: "entry_removed", label: "entry_removed" },
  {
    value: "block_on_uncertainty_changed",
    label: "block_on_uncertainty_changed",
  },
] as const;

const PAGE_SIZE = 25;
const ALL_EVENT_TYPES_VALUE = "__all__";

export interface MCPPolicyAuditPanelProps {
  flavorOrGlobal: string;
  scopeKey: string;
}

/**
 * Audit log surface for a single MCP Protection Policy scope.
 * Calls ``GET /v1/mcp-policies/:flavorOrGlobal/audit-log`` with
 * event_type / from / to / limit / offset filters. Each row
 * expands to reveal the full payload JSON via the existing
 * ``SyntaxJson`` component (D128 — payload is the full mutation
 * body so the operator can replay or inspect any change).
 *
 * Actor is rendered as the token UUID; token-name enrichment is
 * a future improvement that would require a join against
 * access_tokens (currently a separate API).
 */
export function MCPPolicyAuditPanel({
  flavorOrGlobal,
  scopeKey,
}: MCPPolicyAuditPanelProps) {
  const [eventType, setEventType] = useState<string>("");
  const [fromIso, setFromIso] = useState<string>("");
  const [toIso, setToIso] = useState<string>("");
  const [page, setPage] = useState(0);

  const [rows, setRows] = useState<MCPPolicyAuditLog[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const offset = page * PAGE_SIZE;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listMCPPolicyAuditLog(flavorOrGlobal, {
        event_type: eventType || undefined,
        from: fromIso || undefined,
        to: toIso || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setRows(list);
    } catch (err) {
      // GET audit-log is read-open per D147; no admin-wall special-
      // case — surface real errors as real errors.
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, [flavorOrGlobal, eventType, fromIso, toIso, offset]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasFilter = useMemo(
    () => Boolean(eventType || fromIso || toIso),
    [eventType, fromIso, toIso],
  );

  return (
    <section
      className="rounded-md border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid={`mcp-policy-audit-${scopeKey}`}
    >
      <header
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <FileText
          className="h-4 w-4"
          style={{ color: "var(--text-muted)" }}
          aria-hidden="true"
        />
        <h2
          className="text-sm font-semibold"
          style={{ color: "var(--text)" }}
        >
          Audit log
        </h2>
        <span
          className="text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          mutation history per D128
        </span>
      </header>

      <Filters
        eventType={eventType}
        setEventType={(v) => {
          setEventType(v);
          setPage(0);
        }}
        fromIso={fromIso}
        setFromIso={(v) => {
          setFromIso(v);
          setPage(0);
        }}
        toIso={toIso}
        setToIso={(v) => {
          setToIso(v);
          setPage(0);
        }}
        hasFilter={hasFilter}
        onClear={() => {
          setEventType("");
          setFromIso("");
          setToIso("");
          setPage(0);
        }}
        scopeKey={scopeKey}
      />

      <div className="border-t" style={{ borderColor: "var(--border)" }}>
        {error ? (
          <div
            className="m-4 rounded-md border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--danger)",
              background: "color-mix(in srgb, var(--danger) 10%, transparent)",
              color: "var(--danger)",
            }}
            data-testid={`mcp-policy-audit-error-${scopeKey}`}
          >
            {error}
          </div>
        ) : loading && !rows ? (
          <SkeletonRows />
        ) : !rows || rows.length === 0 ? (
          <EmptyState hasFilter={hasFilter} />
        ) : (
          <table
            className="w-full text-sm"
            data-testid={`mcp-policy-audit-table-${scopeKey}`}
          >
            <thead>
              <tr
                className="border-b text-left"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text-muted)",
                }}
              >
                <th className="w-8 px-3 py-2"></th>
                <th className="px-3 py-2 text-[11px] font-medium uppercase">
                  When
                </th>
                <th className="px-3 py-2 text-[11px] font-medium uppercase">
                  Event type
                </th>
                <th className="px-3 py-2 text-[11px] font-medium uppercase">
                  Actor
                </th>
                <th className="px-3 py-2 text-[11px] font-medium uppercase">
                  Summary
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isExpanded = expanded.has(row.id);
                return (
                  <RowGroup
                    key={row.id}
                    row={row}
                    expanded={isExpanded}
                    onToggle={() => toggle(row.id)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* B9: hide the pager entirely on the first-page empty state.
          Showing "0–0 on this page" with disabled Prev/Next adds
          noise to a panel that's already telling the operator
          "no audit entries yet". Keep the pager visible on
          page > 0 so the operator can step back if they paginated
          past the end. */}
      {page === 0 && (rows?.length ?? 0) === 0 ? null : (
        <Pager
          page={page}
          rowsOnPage={rows?.length ?? 0}
          loading={loading}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => p + 1)}
          scopeKey={scopeKey}
        />
      )}
    </section>
  );
}

function Filters({
  eventType,
  setEventType,
  fromIso,
  setFromIso,
  toIso,
  setToIso,
  hasFilter,
  onClear,
  scopeKey,
}: {
  eventType: string;
  setEventType: (v: string) => void;
  fromIso: string;
  setFromIso: (v: string) => void;
  toIso: string;
  setToIso: (v: string) => void;
  hasFilter: boolean;
  onClear: () => void;
  scopeKey: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 px-4 py-3">
      <div className="min-w-[10rem]">
        <label
          className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
          style={{ color: "var(--text-muted)" }}
        >
          Event type
        </label>
        <Select
          value={eventType || ALL_EVENT_TYPES_VALUE}
          onValueChange={(v) =>
            setEventType(v === ALL_EVENT_TYPES_VALUE ? "" : v)
          }
        >
          <SelectTrigger
            className="h-8"
            data-testid={`mcp-policy-audit-event-type-${scopeKey}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENT_TYPES.map((opt) => (
              <SelectItem
                key={opt.value || ALL_EVENT_TYPES_VALUE}
                value={opt.value || ALL_EVENT_TYPES_VALUE}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DateField
        label="From"
        value={fromIso}
        onChange={setFromIso}
        testid={`mcp-policy-audit-from-${scopeKey}`}
      />
      <DateField
        label="To"
        value={toIso}
        onChange={setToIso}
        testid={`mcp-policy-audit-to-${scopeKey}`}
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={onClear}
        disabled={!hasFilter}
        data-testid={`mcp-policy-audit-clear-${scopeKey}`}
      >
        Clear filters
      </Button>
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <div className="min-w-[10rem]">
      <label
        htmlFor={testid}
        className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </label>
      <input
        id={testid}
        type="datetime-local"
        value={dateToInput(value)}
        onChange={(e) => onChange(inputToISO(e.target.value))}
        className="h-8 w-full rounded-md border bg-[var(--background-elevated)] px-2 text-xs outline-none transition-colors focus:border-[var(--accent)]"
        style={{ borderColor: "var(--border)", color: "var(--text)" }}
        data-testid={testid}
      />
    </div>
  );
}

function dateToInput(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  // Trim seconds for the datetime-local control.
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
    `T${pad(t.getHours())}:${pad(t.getMinutes())}`
  );
}

function inputToISO(value: string): string {
  if (!value) return "";
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return "";
  return t.toISOString();
}

function RowGroup({
  row,
  expanded,
  onToggle,
}: {
  row: MCPPolicyAuditLog;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={cn(
          "border-b transition-colors",
          "hover:bg-[var(--background-elevated)]",
        )}
        style={{ borderColor: "var(--border)" }}
        data-testid={`mcp-policy-audit-row-${row.id}`}
      >
        <td className="w-8 px-3 py-2 align-middle">
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Collapse payload" : "Expand payload"}
            aria-expanded={expanded}
            className="text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
            data-testid={`mcp-policy-audit-row-toggle-${row.id}`}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </td>
        <td
          className="px-3 py-2 text-[12px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {formatTimestamp(row.occurred_at)}
        </td>
        <td className="px-3 py-2">
          <span
            className="inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px]"
            style={{
              borderColor: "var(--border)",
              background: "var(--background-elevated)",
              color: "var(--text)",
            }}
          >
            {row.event_type}
          </span>
        </td>
        <td
          className="px-3 py-2 font-mono text-[11px]"
          style={{ color: "var(--text-muted)" }}
          title={row.actor ?? "—"}
        >
          {row.actor ? `${row.actor.slice(0, 8)}…` : "—"}
        </td>
        <td
          className="px-3 py-2 text-[12px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {summarisePayload(row.payload)}
        </td>
      </tr>
      {expanded ? (
        <tr style={{ borderColor: "var(--border)" }}>
          <td colSpan={5} className="px-3 py-3">
            <div
              className="rounded-md border px-3 py-2"
              style={{
                borderColor: "var(--border)",
                background: "var(--background-elevated)",
              }}
              data-testid={`mcp-policy-audit-row-payload-${row.id}`}
            >
              <SyntaxJson data={row.payload} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function summarisePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof payload.entry_count === "number") {
    parts.push(`${payload.entry_count} entries`);
  }
  if (typeof payload.mode === "string") {
    parts.push(`mode=${payload.mode}`);
  }
  if (typeof payload.block_on_uncertainty === "boolean") {
    parts.push(`bou=${payload.block_on_uncertainty ? "on" : "off"}`);
  }
  return parts.join(" · ") || "—";
}

function Pager({
  page,
  rowsOnPage,
  loading,
  onPrev,
  onNext,
  scopeKey,
}: {
  page: number;
  rowsOnPage: number;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  scopeKey: string;
}) {
  const start = page * PAGE_SIZE + (rowsOnPage > 0 ? 1 : 0);
  const end = page * PAGE_SIZE + rowsOnPage;
  return (
    <footer
      className="flex items-center justify-between gap-3 border-t px-4 py-3 text-[11px]"
      style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
    >
      <span data-testid={`mcp-policy-audit-pager-range-${scopeKey}`}>
        {rowsOnPage > 0
          ? `${start}–${end} on this page`
          : "0 rows"}
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onPrev}
          disabled={loading || page === 0}
          data-testid={`mcp-policy-audit-prev-${scopeKey}`}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onNext}
          disabled={loading || rowsOnPage < PAGE_SIZE}
          data-testid={`mcp-policy-audit-next-${scopeKey}`}
        >
          Next
        </Button>
      </div>
    </footer>
  );
}

function EmptyState({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div
      className="px-4 py-6 text-center text-sm"
      style={{ color: "var(--text-muted)" }}
      data-testid="mcp-policy-audit-empty"
    >
      {hasFilter ? (
        "No audit log entries match the active filters."
      ) : (
        <>
          <p>No audit log entries yet.</p>
          <p className="mt-1 text-xs">
            Adding an entry, changing the mode, or importing YAML
            creates an entry here.
          </p>
        </>
      )}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2 p-4" data-testid="mcp-policy-audit-skeleton">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-7 w-full animate-pulse rounded"
          style={{
            background:
              "color-mix(in srgb, var(--text-muted) 10%, transparent)",
          }}
        />
      ))}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString();
}
