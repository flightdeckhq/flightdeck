import { useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MCPQuickStartTemplates } from "@/components/policy/MCPQuickStartTemplates";
import { cn } from "@/lib/utils";
import type { MCPPolicyEntry } from "@/lib/types";

export interface MCPPolicyEntryTableProps {
  entries: MCPPolicyEntry[];
  /** allowlist | blocklist — drives the empty-state copy. */
  mode: "allowlist" | "blocklist" | null;
  scopeKey: string;
  /** "global" or the flavor name — passed through to the quick-start
   *  templates element rendered inside the empty state (D146). */
  flavor: string;
  /** Discriminates the global policy from a flavor policy. The
   *  quick-start templates element is hidden on the global scope
   *  because POST /v1/mcp-policies/global/apply_template returns
   *  400 by design (D138 + D134 — templates apply to flavor
   *  policies only). Without this gate the empty state on the
   *  Global tab rendered an Apply button that the API rejected. */
  scope: "global" | "flavor";
  loading: boolean;
  onAdd: () => void;
  onEdit: (entry: MCPPolicyEntry) => void;
  onDelete: (entry: MCPPolicyEntry) => Promise<void>;
  /** Caller's reload callback. Threaded through to the quick-start
   *  templates apply flow so the empty state refreshes with the
   *  freshly applied entries (D146). */
  onApplied: () => Promise<void>;
}

/**
 * Renders the entries on a policy as a searchable, sortable
 * table (D128 + ARCHITECTURE.md → "Entry table"). Each row
 * shows a chroma-coded status pill — green for allow, red /
 * amber / purple for deny depending on the per-entry
 * enforcement override — plus inline edit / delete actions.
 *
 * Empty state is mode-aware ("Add your first allow rule…" vs
 * "Add your first deny rule…") so the next action is taught
 * rather than left to the operator's intuition.
 */
export function MCPPolicyEntryTable({
  entries,
  mode,
  scopeKey,
  flavor,
  scope,
  loading,
  onAdd,
  onEdit,
  onDelete,
  onApplied,
}: MCPPolicyEntryTableProps) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"server_name" | "server_url" | "kind">(
    "server_name",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? entries.filter(
          (e) =>
            e.server_name.toLowerCase().includes(needle) ||
            e.server_url.toLowerCase().includes(needle) ||
            e.fingerprint.toLowerCase().includes(needle),
        )
      : entries.slice();

    list.sort((a, b) => {
      const left = sortKey === "kind" ? a.entry_kind : a[sortKey];
      const right = sortKey === "kind" ? b.entry_kind : b[sortKey];
      const cmp = String(left).localeCompare(String(right));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [entries, search, sortKey, sortDir]);

  function flipSort(key: typeof sortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <div
      className="rounded-md border"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
      }}
      data-testid={`mcp-policy-entries-${scopeKey}`}
    >
      <header
        className="flex items-center gap-3 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <h2
          className="text-sm font-semibold"
          style={{ color: "var(--text)" }}
        >
          Entries
          <span
            className="ml-2 text-[11px] font-normal"
            style={{ color: "var(--text-muted)" }}
          >
            {entries.length}
          </span>
        </h2>
        <div className="relative ml-4 flex-1 max-w-xs">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            style={{ color: "var(--text-muted)" }}
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search URL, name, or fingerprint"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md border bg-[var(--background-elevated)] pl-7 pr-3 text-xs outline-none transition-colors focus:border-[var(--accent)]"
            style={{
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
            data-testid={`mcp-policy-entries-search-${scopeKey}`}
          />
        </div>
        <Button
          size="sm"
          onClick={onAdd}
          className="gap-1.5"
          data-testid={`mcp-policy-entries-add-${scopeKey}`}
        >
          <Plus className="h-3.5 w-3.5" />
          Add entry
        </Button>
      </header>

      {loading ? (
        <SkeletonRows />
      ) : filtered.length === 0 ? (
        <EmptyState
          mode={mode}
          hasSearch={search.trim().length > 0}
          flavor={flavor}
          scope={scope}
          scopeKey={scopeKey}
          entryCount={entries.length}
          onApplied={onApplied}
        />
      ) : (
        <table className="w-full text-sm" data-testid={`mcp-policy-entries-table-${scopeKey}`}>
          <thead>
            <tr
              className="border-b text-left"
              style={{
                borderColor: "var(--border)",
                color: "var(--text-muted)",
              }}
            >
              <SortableTh
                label="Decision"
                active={sortKey === "kind"}
                dir={sortDir}
                onClick={() => flipSort("kind")}
              />
              <SortableTh
                label="Name"
                active={sortKey === "server_name"}
                dir={sortDir}
                onClick={() => flipSort("server_name")}
              />
              <SortableTh
                label="URL"
                active={sortKey === "server_url"}
                dir={sortDir}
                onClick={() => flipSort("server_url")}
              />
              <th
                className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide"
                scope="col"
              >
                Fingerprint
              </th>
              <th
                className="w-24 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide"
                scope="col"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr
                key={entry.id}
                className="border-b transition-colors hover:bg-[var(--background-elevated)]"
                style={{ borderColor: "var(--border)" }}
                data-testid={`mcp-policy-entry-${entry.id}`}
              >
                <td className="px-3 py-2">
                  <DecisionPill entry={entry} />
                </td>
                <td className="px-3 py-2 font-medium" style={{ color: "var(--text)" }}>
                  {entry.server_name}
                </td>
                <td
                  className="px-3 py-2 font-mono text-[12px]"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {entry.server_url}
                </td>
                <td
                  className="px-3 py-2 font-mono text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                  title={entry.fingerprint}
                >
                  {entry.fingerprint.slice(0, 16)}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEdit(entry)}
                      aria-label={`Edit ${entry.server_name}`}
                      data-testid={`mcp-policy-entry-edit-${entry.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `Delete entry for ${entry.server_name}?`,
                          )
                        ) {
                          return;
                        }
                        setDeletingId(entry.id);
                        try {
                          await onDelete(entry);
                        } finally {
                          setDeletingId(null);
                        }
                      }}
                      disabled={deletingId === entry.id}
                      aria-label={`Delete ${entry.server_name}`}
                      data-testid={`mcp-policy-entry-delete-${entry.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide" scope="col">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 transition-colors",
          active ? "text-[var(--text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
        )}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active ? (
          <span aria-hidden="true">{dir === "asc" ? "↑" : "↓"}</span>
        ) : null}
      </button>
    </th>
  );
}

function DecisionPill({ entry }: { entry: MCPPolicyEntry }) {
  // Chroma map (locked in step 6 plan):
  //   allow → green
  //   deny + warn → amber
  //   deny + block → red
  //   deny + interactive → purple/info
  //   deny + no enforcement → red (treated as block by default)
  let label: string;
  let bg: string;
  let fg: string;

  if (entry.entry_kind === "allow") {
    label = "Allow";
    bg = "color-mix(in srgb, var(--success, #16a34a) 12%, transparent)";
    fg = "var(--success, #16a34a)";
  } else if (entry.enforcement === "warn") {
    label = "Deny · warn";
    bg = "color-mix(in srgb, var(--warning, #d97706) 12%, transparent)";
    fg = "var(--warning, #d97706)";
  } else if (entry.enforcement === "interactive") {
    label = "Deny · interactive";
    bg = "color-mix(in srgb, var(--info, #7c3aed) 12%, transparent)";
    fg = "var(--info, #7c3aed)";
  } else {
    label = "Deny · block";
    bg = "color-mix(in srgb, var(--danger) 12%, transparent)";
    fg = "var(--danger)";
  }

  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{
        borderColor: fg,
        background: bg,
        color: fg,
      }}
      data-testid={`mcp-policy-entry-pill-${entry.id}`}
    >
      {label}
    </span>
  );
}

function EmptyState({
  mode,
  hasSearch,
  flavor,
  scope,
  scopeKey,
  entryCount,
  onApplied,
}: {
  mode: "allowlist" | "blocklist" | null;
  hasSearch: boolean;
  flavor: string;
  scope: "global" | "flavor";
  scopeKey: string;
  entryCount: number;
  onApplied: () => Promise<void>;
}) {
  if (hasSearch) {
    return (
      <div
        className="px-6 py-10 text-center text-sm"
        style={{ color: "var(--text-muted)" }}
        data-testid="mcp-policy-entries-empty-search"
      >
        No entries match your search.
      </div>
    );
  }

  const copy =
    mode === "allowlist"
      ? "Add your first allow rule to start gating this scope."
      : mode === "blocklist"
        ? "Add your first deny rule to block specific servers."
        : "Add an entry to start managing access.";

  return (
    <div
      className="px-6 py-10 text-center text-sm"
      style={{ color: "var(--text-muted)" }}
      data-testid="mcp-policy-entries-empty"
    >
      {copy}
      {scope === "flavor" ? (
        <MCPQuickStartTemplates
          flavor={flavor}
          scopeKey={scopeKey}
          entryCount={entryCount}
          onApplied={onApplied}
        />
      ) : null}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="px-4 py-4" data-testid="mcp-policy-entries-skeleton">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="mb-2 h-8 animate-pulse rounded"
          style={{
            background:
              "color-mix(in srgb, var(--text-muted) 10%, transparent)",
          }}
        />
      ))}
    </div>
  );
}
