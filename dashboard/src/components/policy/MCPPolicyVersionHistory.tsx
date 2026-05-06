import { useCallback, useEffect, useMemo, useState } from "react";
import { History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SyntaxJson } from "@/components/ui/syntax-json";
import {
  ApiError,
  diffMCPPolicyVersions,
  listMCPPolicyVersions,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  MCPPolicyDiff,
  MCPPolicyVersionMeta,
} from "@/lib/types";

export interface MCPPolicyVersionHistoryProps {
  /** "global" or a flavor name — matches the URL ``/{flavor}`` slot. */
  flavorOrGlobal: string;
  /** Stable test-id suffix (matches the parent panel's scopeKey). */
  scopeKey: string;
  /** Latest known version — used to seed the default diff "to" axis. */
  latestVersion: number;
}

const PAGE_SIZE = 25;

/**
 * Version history list + diff viewer for a single MCP Protection
 * Policy scope (Global or one flavor). Calls
 * ``GET /v1/mcp-policies/:flavorOrGlobal/versions`` for the list
 * and ``/diff?from=&to=`` for the structural diff. The diff
 * renders as three sections — added / removed / changed entries
 * — plus mode-changed and ``block_on_uncertainty``-changed badges
 * when those policy-level fields moved between the two snapshots.
 *
 * Selection model: the operator picks two versions from the list
 * via two columns of radio buttons. By default the diff loads
 * latest→previous so the operator sees the most recent change at
 * page-open without any extra clicks.
 */
export function MCPPolicyVersionHistory({
  flavorOrGlobal,
  scopeKey,
  latestVersion,
}: MCPPolicyVersionHistoryProps) {
  const [versions, setVersions] = useState<MCPPolicyVersionMeta[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(true);

  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  const load = useCallback(async () => {
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const list = await listMCPPolicyVersions(flavorOrGlobal, {
        limit: PAGE_SIZE,
      });
      setVersions(list);
      if (list.length >= 2) {
        setFrom(list[1].version);
        setTo(list[0].version);
      } else if (list.length === 1) {
        setFrom(list[0].version);
        setTo(list[0].version);
      }
    } catch (err) {
      setVersionsError(
        err instanceof ApiError && err.status === 403
          ? "Admin token required to view version history."
          : "Failed to load version history",
      );
    } finally {
      setVersionsLoading(false);
    }
  }, [flavorOrGlobal]);

  useEffect(() => {
    void load();
  }, [load, latestVersion]);

  return (
    <section
      className="rounded-md border"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
      }}
      data-testid={`mcp-policy-versions-${scopeKey}`}
    >
      <header
        className="flex items-center justify-between gap-2 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <History
            className="h-4 w-4"
            style={{ color: "var(--text-muted)" }}
            aria-hidden="true"
          />
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text)" }}
          >
            Version history
          </h2>
        </div>
        <span
          className="text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          Last {PAGE_SIZE} versions
        </span>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <VersionList
          versions={versions}
          loading={versionsLoading}
          error={versionsError}
          from={from}
          to={to}
          onSelect={(axis, version) => {
            if (axis === "from") setFrom(version);
            else setTo(version);
          }}
          scopeKey={scopeKey}
        />
        <DiffViewer
          flavorOrGlobal={flavorOrGlobal}
          scopeKey={scopeKey}
          from={from}
          to={to}
        />
      </div>
    </section>
  );
}

function VersionList({
  versions,
  loading,
  error,
  from,
  to,
  onSelect,
  scopeKey,
}: {
  versions: MCPPolicyVersionMeta[] | null;
  loading: boolean;
  error: string | null;
  from: number | null;
  to: number | null;
  onSelect: (axis: "from" | "to", version: number) => void;
  scopeKey: string;
}) {
  if (loading) {
    return (
      <div
        className="px-3 py-4 text-sm"
        style={{ color: "var(--text-muted)" }}
        data-testid={`mcp-policy-versions-loading-${scopeKey}`}
      >
        Loading version list…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-md border px-3 py-2 text-xs"
        style={{
          borderColor: "var(--danger)",
          background: "color-mix(in srgb, var(--danger) 10%, transparent)",
          color: "var(--danger)",
        }}
        data-testid={`mcp-policy-versions-error-${scopeKey}`}
      >
        {error}
      </div>
    );
  }

  if (!versions || versions.length === 0) {
    return (
      <div
        className="rounded-md border px-3 py-4 text-sm"
        style={{
          borderColor: "var(--border)",
          background: "var(--background-elevated)",
          color: "var(--text-muted)",
        }}
        data-testid={`mcp-policy-versions-empty-${scopeKey}`}
      >
        Version history will appear after your first save.
      </div>
    );
  }

  return (
    <table
      className="w-full text-sm"
      data-testid={`mcp-policy-versions-table-${scopeKey}`}
    >
      <thead>
        <tr
          className="border-b text-left"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-muted)",
          }}
        >
          <th className="w-10 px-2 py-1 text-[10px] font-medium uppercase">
            From
          </th>
          <th className="w-10 px-2 py-1 text-[10px] font-medium uppercase">
            To
          </th>
          <th className="px-2 py-1 text-[10px] font-medium uppercase">
            Version
          </th>
          <th className="px-2 py-1 text-[10px] font-medium uppercase">
            When
          </th>
          <th className="px-2 py-1 text-[10px] font-medium uppercase">
            Actor
          </th>
        </tr>
      </thead>
      <tbody>
        {versions.map((row) => (
          <tr
            key={row.id}
            className={cn(
              "border-b transition-colors",
              "hover:bg-[var(--background-elevated)]",
            )}
            style={{ borderColor: "var(--border)" }}
            data-testid={`mcp-policy-version-row-${row.version}`}
          >
            <td className="px-2 py-1 align-middle">
              <input
                type="radio"
                name={`mcp-version-from-${scopeKey}`}
                checked={from === row.version}
                onChange={() => onSelect("from", row.version)}
                aria-label={`Diff from version ${row.version}`}
              />
            </td>
            <td className="px-2 py-1 align-middle">
              <input
                type="radio"
                name={`mcp-version-to-${scopeKey}`}
                checked={to === row.version}
                onChange={() => onSelect("to", row.version)}
                aria-label={`Diff to version ${row.version}`}
              />
            </td>
            <td
              className="px-2 py-1 font-mono text-[12px]"
              style={{ color: "var(--text)" }}
            >
              v{row.version}
            </td>
            <td
              className="px-2 py-1 text-[12px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {formatTimestamp(row.created_at)}
            </td>
            <td
              className="px-2 py-1 text-[12px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {row.created_by ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface DiffViewerProps {
  flavorOrGlobal: string;
  scopeKey: string;
  from: number | null;
  to: number | null;
}

function DiffViewer({
  flavorOrGlobal,
  scopeKey,
  from,
  to,
}: DiffViewerProps) {
  const [diff, setDiff] = useState<MCPPolicyDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedJson, setExpandedJson] = useState(false);

  const eligible = useMemo(() => from != null && to != null, [from, to]);

  useEffect(() => {
    if (!eligible || from == null || to == null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    diffMCPPolicyVersions(flavorOrGlobal, from, to)
      .then((d) => {
        if (cancelled) return;
        setDiff(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiff(null);
        if (err instanceof ApiError && err.status === 403) {
          setError("Admin token required to view diffs.");
        } else {
          setError(err instanceof Error ? err.message : "Failed to load diff");
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flavorOrGlobal, from, to, eligible]);

  if (!eligible) {
    return (
      <div
        className="rounded-md border px-3 py-4 text-sm"
        style={{
          borderColor: "var(--border)",
          background: "var(--background-elevated)",
          color: "var(--text-muted)",
        }}
        data-testid={`mcp-policy-diff-empty-${scopeKey}`}
      >
        Pick a "from" and a "to" version to see what changed.
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="px-3 py-4 text-sm"
        style={{ color: "var(--text-muted)" }}
        data-testid={`mcp-policy-diff-loading-${scopeKey}`}
      >
        Loading diff…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-md border px-3 py-2 text-xs"
        style={{
          borderColor: "var(--danger)",
          background: "color-mix(in srgb, var(--danger) 10%, transparent)",
          color: "var(--danger)",
        }}
        data-testid={`mcp-policy-diff-error-${scopeKey}`}
      >
        {error}
      </div>
    );
  }

  if (!diff) return null;

  const isNoOp =
    !diff.mode_changed &&
    !diff.block_on_uncertainty_changed &&
    diff.entries_added.length === 0 &&
    diff.entries_removed.length === 0 &&
    diff.entries_changed.length === 0;

  return (
    <div
      className="rounded-md border"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid={`mcp-policy-diff-${scopeKey}`}
    >
      <header
        className="flex items-center justify-between gap-2 border-b px-3 py-2 text-[11px]"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        <span>
          v{diff.from_version} → v{diff.to_version}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExpandedJson((v) => !v)}
          data-testid={`mcp-policy-diff-rawtoggle-${scopeKey}`}
        >
          {expandedJson ? "Hide raw JSON" : "View raw JSON"}
        </Button>
      </header>

      <div className="space-y-3 px-3 py-3">
        {isNoOp ? (
          <p
            className="text-[12px]"
            style={{ color: "var(--text-muted)" }}
            data-testid={`mcp-policy-diff-empty-changes-${scopeKey}`}
          >
            No structural differences between these versions.
          </p>
        ) : null}

        {diff.mode_changed ? (
          <Badge
            label="Mode"
            from={diff.mode_changed.from}
            to={diff.mode_changed.to}
            tone="warning"
            testid={`mcp-policy-diff-mode-${scopeKey}`}
          />
        ) : null}
        {diff.block_on_uncertainty_changed ? (
          <Badge
            label="Block on uncertainty"
            from={String(diff.block_on_uncertainty_changed.from)}
            to={String(diff.block_on_uncertainty_changed.to)}
            tone="warning"
            testid={`mcp-policy-diff-bou-${scopeKey}`}
          />
        ) : null}

        <DiffSection
          tone="success"
          label="Entries added"
          entries={diff.entries_added}
          scopeKey={scopeKey}
          variant="added"
        />
        <DiffSection
          tone="danger"
          label="Entries removed"
          entries={diff.entries_removed}
          scopeKey={scopeKey}
          variant="removed"
        />
        {diff.entries_changed.length > 0 ? (
          <ChangedSection
            entries={diff.entries_changed}
            scopeKey={scopeKey}
          />
        ) : null}
      </div>

      {expandedJson ? (
        <div
          className="border-t px-3 py-3"
          style={{ borderColor: "var(--border)" }}
          data-testid={`mcp-policy-diff-rawjson-${scopeKey}`}
        >
          <p
            className="mb-1 text-[10px] uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            v{diff.from_version} snapshot
          </p>
          <SyntaxJson data={diff.from_snapshot} />
          <p
            className="mb-1 mt-3 text-[10px] uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            v{diff.to_version} snapshot
          </p>
          <SyntaxJson data={diff.to_snapshot} />
        </div>
      ) : null}
    </div>
  );
}

function Badge({
  label,
  from,
  to,
  tone,
  testid,
}: {
  label: string;
  from: string;
  to: string;
  tone: "warning" | "info";
  testid: string;
}) {
  const colour =
    tone === "warning" ? "var(--warning, #d97706)" : "var(--info, #7c3aed)";
  return (
    <div
      className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
      style={{
        borderColor: colour,
        background: `color-mix(in srgb, ${colour} 10%, transparent)`,
      }}
      data-testid={testid}
    >
      <span
        className="text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: colour }}
      >
        {label}
      </span>
      <span style={{ color: "var(--text)" }}>
        <span className="font-mono">{from}</span>{" "}
        <span style={{ color: "var(--text-muted)" }}>→</span>{" "}
        <span className="font-mono">{to}</span>
      </span>
    </div>
  );
}

function DiffSection({
  label,
  entries,
  tone,
  scopeKey,
  variant,
}: {
  label: string;
  entries: { fingerprint: string; server_name: string; server_url: string; entry_kind: string; enforcement?: string | null }[];
  tone: "success" | "danger";
  scopeKey: string;
  variant: "added" | "removed";
}) {
  if (entries.length === 0) return null;
  const colour =
    tone === "success" ? "var(--success, #16a34a)" : "var(--danger)";
  return (
    <div
      className="rounded-md border px-3 py-2"
      style={{
        borderColor: colour,
        background: `color-mix(in srgb, ${colour} 8%, transparent)`,
      }}
      data-testid={`mcp-policy-diff-${variant}-${scopeKey}`}
    >
      <div
        className="mb-1 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: colour }}
      >
        {label} · {entries.length}
      </div>
      <ul className="space-y-1">
        {entries.map((e) => (
          <li
            key={e.fingerprint}
            className="flex items-center gap-2 font-mono text-[11px]"
            style={{ color: "var(--text)" }}
          >
            <span style={{ color: "var(--text-muted)" }}>
              {e.entry_kind}
              {e.enforcement ? ` · ${e.enforcement}` : ""}
            </span>
            <span>{e.server_name}</span>
            <span style={{ color: "var(--text-secondary)" }}>{e.server_url}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangedSection({
  entries,
  scopeKey,
}: {
  entries: {
    fingerprint: string;
    before: { server_name: string; entry_kind: string; enforcement?: string | null };
    after: { server_name: string; entry_kind: string; enforcement?: string | null };
  }[];
  scopeKey: string;
}) {
  const colour = "var(--info, #7c3aed)";
  return (
    <div
      className="rounded-md border px-3 py-2"
      style={{
        borderColor: colour,
        background: `color-mix(in srgb, ${colour} 8%, transparent)`,
      }}
      data-testid={`mcp-policy-diff-changed-${scopeKey}`}
    >
      <div
        className="mb-1 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: colour }}
      >
        Entries changed · {entries.length}
      </div>
      <ul className="space-y-1">
        {entries.map((e) => (
          <li
            key={e.fingerprint}
            className="flex items-center gap-2 font-mono text-[11px]"
            style={{ color: "var(--text)" }}
          >
            <span>{e.before.server_name}</span>
            <span style={{ color: "var(--text-muted)" }}>
              {e.before.entry_kind}
              {e.before.enforcement ? ` · ${e.before.enforcement}` : ""} →{" "}
              {e.after.entry_kind}
              {e.after.enforcement ? ` · ${e.after.enforcement}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString();
}
