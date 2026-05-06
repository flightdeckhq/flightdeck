import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MCPPolicyAuditPanel } from "@/components/policy/MCPPolicyAuditPanel";
import { MCPPolicyDryRunPanel } from "@/components/policy/MCPPolicyDryRunPanel";
import { MCPPolicyEntryDialog } from "@/components/policy/MCPPolicyEntryDialog";
import { MCPPolicyEntryTable } from "@/components/policy/MCPPolicyEntryTable";
import { MCPPolicyHeader } from "@/components/policy/MCPPolicyHeader";
import { MCPPolicyMetricsPanel } from "@/components/policy/MCPPolicyMetricsPanel";
import { MCPPolicyResolvePanel } from "@/components/policy/MCPPolicyResolvePanel";
import { MCPPolicyTemplatesPanel } from "@/components/policy/MCPPolicyTemplatesPanel";
import { MCPPolicyVersionHistory } from "@/components/policy/MCPPolicyVersionHistory";
import { MCPPolicyYamlPanel } from "@/components/policy/MCPPolicyYamlPanel";
import { MCPSoftLaunchBanner } from "@/components/policy/MCPSoftLaunchBanner";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  createFlavorMCPPolicy,
  fetchFlavorMCPPolicy,
  fetchFlavors,
  fetchGlobalMCPPolicy,
  updateFlavorMCPPolicy,
  updateGlobalMCPPolicy,
} from "@/lib/api";
import type {
  MCPPolicy,
  MCPPolicyEntry,
  MCPPolicyMutation,
  MCPPolicyMutationEntry,
} from "@/lib/types";

/**
 * MCP Protection Policy management page (D128 / D131 / D135 / D139).
 *
 * Top-level surface at ``/mcp-policies``. A tabs shell with a Global
 * tab plus one tab per flavor that has runtime activity. Each tab
 * renders the per-scope toolbar (mode segmented control + BOU
 * switch), the searchable entry table with chroma-coded chips, and
 * an add / edit dialog with debounced (300ms) live resolve preview.
 *
 * Mutations follow the D128 replace-semantics: a single
 * ``MCPPolicyMutation`` carries the full intended state and is
 * PUT'd atomically. The page builds the mutation from the current
 * policy + the operator's diff (toolbar change OR entry add / edit
 * / delete) and reloads on success.
 *
 * Resolve preview / version history / diff / dry-run / metrics /
 * YAML i/o / templates / audit trail land in commits 4-7 of step 6.
 */
export function MCPPolicies() {
  const [globalState, setGlobalState] = useState<PolicyState>({
    policy: null,
    loading: true,
    error: null,
  });
  const [flavors, setFlavors] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>("global");

  const [dialog, setDialog] = useState<DialogState>({ open: false });

  const loadGlobal = useCallback(async () => {
    setGlobalState((s) => ({ ...s, loading: true, error: null }));
    try {
      const policy = await fetchGlobalMCPPolicy();
      setGlobalState({ policy, loading: false, error: null });
    } catch {
      setGlobalState({
        policy: null,
        loading: false,
        error: "Failed to load global MCP policy",
      });
    }
  }, []);

  const loadFlavors = useCallback(async () => {
    const list = await fetchFlavors();
    setFlavors(list);
  }, []);

  useEffect(() => {
    void loadGlobal();
    void loadFlavors();
  }, [loadGlobal, loadFlavors]);

  const tabs = useMemo<{ value: string; label: string }[]>(
    () => [
      { value: "global", label: "Global" },
      ...flavors.map((f) => ({ value: `flavor:${f}`, label: f })),
    ],
    [flavors],
  );

  return (
    <div className="h-full overflow-auto p-6">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-text">
          MCP Protection Policy
        </h1>
        <p
          className="mt-1 text-sm"
          style={{ color: "var(--text-muted)" }}
          data-testid="mcp-policies-subtitle"
        >
          Gate which MCP servers your agents may talk to. Decisions
          fall through flavor entry &rarr; global entry &rarr; mode
          default (D135).
        </p>
      </header>

      <div className="mb-6">
        <MCPSoftLaunchBanner />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div
          className="mb-4 flex items-center gap-3"
          data-testid="mcp-policies-scope-picker"
        >
          <label
            htmlFor="mcp-policies-scope-select"
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            Editing scope
          </label>
          <ScopePicker
            tabs={tabs}
            value={activeTab}
            onChange={setActiveTab}
          />
          <span
            className="text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            {flavors.length === 0
              ? "Global only — no flavor activity yet"
              : `${flavors.length} flavor${flavors.length === 1 ? "" : "s"} + Global`}
          </span>
        </div>

        <TabsContent value="global" data-testid="mcp-policies-panel-global">
          <GlobalPanel
            state={globalState}
            onChanged={loadGlobal}
            onOpenAdd={(scope) =>
              setDialog({ open: true, scope, initial: undefined })
            }
            onOpenEdit={(scope, entry) =>
              setDialog({ open: true, scope, initial: entry })
            }
          />
        </TabsContent>

        {flavors.map((flavor) => (
          <TabsContent
            key={flavor}
            value={`flavor:${flavor}`}
            data-testid={`mcp-policies-panel-${flavor}`}
          >
            <FlavorPanel
              flavor={flavor}
              globalMode={(globalState.policy?.mode as Mode | null) ?? null}
              onOpenAdd={(scope) =>
                setDialog({ open: true, scope, initial: undefined })
              }
              onOpenEdit={(scope, entry) =>
                setDialog({ open: true, scope, initial: entry })
              }
            />
          </TabsContent>
        ))}
      </Tabs>

      {dialog.open ? (
        <MCPPolicyEntryDialog
          open
          initial={dialog.initial}
          flavor={dialog.scope.kind === "flavor" ? dialog.scope.flavor : null}
          onClose={() => setDialog({ open: false })}
          onSave={async (entry) => {
            await dialog.scope.onSaveEntry(entry, dialog.initial);
            setDialog({ open: false });
          }}
        />
      ) : null}
    </div>
  );
}

type Mode = "allowlist" | "blocklist";

interface PolicyState {
  policy: MCPPolicy | null;
  loading: boolean;
  error: string | null;
}

type DialogScope =
  | {
      kind: "global";
      onSaveEntry: (
        next: MCPPolicyMutationEntry,
        previous?: MCPPolicyEntry,
      ) => Promise<void>;
    }
  | {
      kind: "flavor";
      flavor: string;
      onSaveEntry: (
        next: MCPPolicyMutationEntry,
        previous?: MCPPolicyEntry,
      ) => Promise<void>;
    };

type DialogState =
  | { open: false }
  | { open: true; scope: DialogScope; initial?: MCPPolicyEntry };

interface GlobalPanelProps {
  state: PolicyState;
  onChanged: () => Promise<void>;
  onOpenAdd: (scope: DialogScope) => void;
  onOpenEdit: (scope: DialogScope, entry: MCPPolicyEntry) => void;
}

function GlobalPanel({
  state,
  onChanged,
  onOpenAdd,
  onOpenEdit,
}: GlobalPanelProps) {
  const policy = state.policy;

  const saveEntry = useCallback(
    async (next: MCPPolicyMutationEntry, previous?: MCPPolicyEntry) => {
      if (!policy) return;
      const mutation = mergeEntry(policy, next, previous);
      await updateGlobalMCPPolicy(mutation);
      await onChanged();
    },
    [policy, onChanged],
  );

  const dialogScope = useMemo<DialogScope>(
    () => ({ kind: "global", onSaveEntry: saveEntry }),
    [saveEntry],
  );

  if (state.loading) return <PanelStatus tone="info">Loading global policy…</PanelStatus>;
  if (state.error) return <PanelStatus tone="error">{state.error}</PanelStatus>;
  if (!policy) return null;

  return (
    <div className="mt-4 space-y-4">
      <MCPPolicyHeader
        policy={policy}
        scopeKey="global"
        modeEditable
        globalMode={(policy.mode as Mode | null) ?? null}
        onModeChange={async (next) => {
          await updateGlobalMCPPolicy(buildMutation(policy, { mode: next }));
          await onChanged();
        }}
        onBlockOnUncertaintyChange={async (next) => {
          await updateGlobalMCPPolicy(
            buildMutation(policy, { block_on_uncertainty: next }),
          );
          await onChanged();
        }}
      />

      <MCPPolicyEntryTable
        entries={policy.entries ?? []}
        mode={(policy.mode as Mode | null) ?? null}
        scopeKey="global"
        loading={false}
        onAdd={() => onOpenAdd(dialogScope)}
        onEdit={(entry) => onOpenEdit(dialogScope, entry)}
        onDelete={async (entry) => {
          await updateGlobalMCPPolicy(removeEntry(policy, entry));
          await onChanged();
        }}
      />

      <MCPPolicyResolvePanel flavor={null} scopeKey="global" />

      <MCPPolicyDryRunPanel
        flavor="global"
        scopeKey="global"
        policy={policy}
      />

      <MCPPolicyMetricsPanel flavorOrGlobal="global" scopeKey="global" />

      <MCPPolicyTemplatesPanel
        flavor="global"
        scopeKey="global"
        onApplied={onChanged}
      />

      <MCPPolicyYamlPanel
        flavor="global"
        scopeKey="global"
        onImported={onChanged}
      />

      <MCPPolicyVersionHistory
        flavorOrGlobal="global"
        scopeKey="global"
        latestVersion={policy.version}
      />

      <MCPPolicyAuditPanel flavorOrGlobal="global" scopeKey="global" />
    </div>
  );
}

interface FlavorPanelProps {
  flavor: string;
  globalMode: Mode | null;
  onOpenAdd: (scope: DialogScope) => void;
  onOpenEdit: (scope: DialogScope, entry: MCPPolicyEntry) => void;
}

function FlavorPanel({
  flavor,
  globalMode,
  onOpenAdd,
  onOpenEdit,
}: FlavorPanelProps) {
  const [state, setState] = useState<PolicyState>({
    policy: null,
    loading: true,
    error: null,
  });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const policy = await fetchFlavorMCPPolicy(flavor);
      setState({ policy, loading: false, error: null });
    } catch {
      setState({
        policy: null,
        loading: false,
        error: "Failed to load flavor policy",
      });
    }
  }, [flavor]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveEntry = useCallback(
    async (next: MCPPolicyMutationEntry, previous?: MCPPolicyEntry) => {
      if (!state.policy) {
        // No flavor policy yet — create it with this single entry.
        await createFlavorMCPPolicy(flavor, {
          block_on_uncertainty: false,
          entries: [next],
        });
      } else {
        const mutation = mergeEntry(state.policy, next, previous);
        await updateFlavorMCPPolicy(flavor, mutation);
      }
      await reload();
    },
    [flavor, state.policy, reload],
  );

  const dialogScope = useMemo<DialogScope>(
    () => ({ kind: "flavor", flavor, onSaveEntry: saveEntry }),
    [flavor, saveEntry],
  );

  if (state.loading) return <PanelStatus tone="info">Loading flavor policy…</PanelStatus>;
  if (state.error) return <PanelStatus tone="error">{state.error}</PanelStatus>;

  if (!state.policy) {
    return (
      <div className="mt-4 space-y-4">
        <PanelStatus tone="info">
          No flavor policy. <em>{flavor}</em> currently inherits the global
          policy. Add an entry below to create a flavor-scoped override.
        </PanelStatus>
        <MCPPolicyEntryTable
          entries={[]}
          mode={globalMode}
          scopeKey={flavor}
          loading={false}
          onAdd={() => onOpenAdd(dialogScope)}
          onEdit={() => undefined}
          onDelete={async () => undefined}
        />
        <MCPPolicyResolvePanel flavor={flavor} scopeKey={flavor} />
      </div>
    );
  }

  const policy = state.policy;
  return (
    <div className="mt-4 space-y-4">
      <MCPPolicyHeader
        policy={policy}
        scopeKey={flavor}
        modeEditable={false}
        globalMode={globalMode}
        onModeChange={async () => {
          throw new Error("Mode is global-only (D134).");
        }}
        onBlockOnUncertaintyChange={async (next) => {
          await updateFlavorMCPPolicy(
            flavor,
            buildMutation(policy, { block_on_uncertainty: next }),
          );
          await reload();
        }}
      />
      <MCPPolicyEntryTable
        entries={policy.entries ?? []}
        mode={globalMode}
        scopeKey={flavor}
        loading={false}
        onAdd={() => onOpenAdd(dialogScope)}
        onEdit={(entry) => onOpenEdit(dialogScope, entry)}
        onDelete={async (entry) => {
          await updateFlavorMCPPolicy(flavor, removeEntry(policy, entry));
          await reload();
        }}
      />

      <MCPPolicyResolvePanel flavor={flavor} scopeKey={flavor} />

      <MCPPolicyDryRunPanel
        flavor={flavor}
        scopeKey={flavor}
        policy={policy}
      />

      <MCPPolicyMetricsPanel flavorOrGlobal={flavor} scopeKey={flavor} />

      <MCPPolicyTemplatesPanel
        flavor={flavor}
        scopeKey={flavor}
        onApplied={reload}
      />

      <MCPPolicyYamlPanel
        flavor={flavor}
        scopeKey={flavor}
        onImported={reload}
      />

      <MCPPolicyVersionHistory
        flavorOrGlobal={flavor}
        scopeKey={flavor}
        latestVersion={policy.version}
      />

      <MCPPolicyAuditPanel flavorOrGlobal={flavor} scopeKey={flavor} />
    </div>
  );
}

function PanelStatus({
  tone,
  children,
}: {
  tone: "info" | "error";
  children: React.ReactNode;
}) {
  const isError = tone === "error";
  return (
    <div
      className="mt-4 rounded-md border px-4 py-3 text-sm"
      style={{
        borderColor: isError ? "var(--danger)" : "var(--border)",
        background: isError
          ? "color-mix(in srgb, var(--danger) 10%, transparent)"
          : "var(--background-elevated)",
        color: isError ? "var(--danger)" : "var(--text-muted)",
      }}
      data-testid={`mcp-panel-status-${tone}`}
    >
      {children}
    </div>
  );
}

// ----- Mutation helpers -----

function buildMutation(
  policy: MCPPolicy,
  overrides: Partial<MCPPolicyMutation>,
): MCPPolicyMutation {
  return {
    mode: overrides.mode ?? (policy.mode ?? null),
    block_on_uncertainty:
      overrides.block_on_uncertainty ?? policy.block_on_uncertainty,
    entries: overrides.entries ?? entriesToMutation(policy.entries ?? []),
  };
}

function entriesToMutation(entries: MCPPolicyEntry[]): MCPPolicyMutationEntry[] {
  return entries.map((e) => ({
    server_url: e.server_url,
    server_name: e.server_name,
    entry_kind: e.entry_kind,
    enforcement: e.enforcement ?? null,
  }));
}

function mergeEntry(
  policy: MCPPolicy,
  next: MCPPolicyMutationEntry,
  previous?: MCPPolicyEntry,
): MCPPolicyMutation {
  const current = entriesToMutation(policy.entries ?? []);
  if (previous) {
    const idx = current.findIndex(
      (e) =>
        e.server_url === previous.server_url &&
        e.server_name === previous.server_name,
    );
    if (idx >= 0) {
      current[idx] = next;
    } else {
      current.push(next);
    }
  } else {
    current.push(next);
  }
  return buildMutation(policy, { entries: current });
}

function removeEntry(
  policy: MCPPolicy,
  toRemove: MCPPolicyEntry,
): MCPPolicyMutation {
  const remaining = entriesToMutation(policy.entries ?? []).filter(
    (e) =>
      !(
        e.server_url === toRemove.server_url &&
        e.server_name === toRemove.server_name
      ),
  );
  return buildMutation(policy, { entries: remaining });
}

// Step 6.7 (d): searchable scope picker. The pre-fix dropdown was a
// Radix Select rendering all flavors alphabetically; with 67+
// flavors the list became impossible to scan. Standard pattern for
// any dropdown over ~20 items is type-to-filter.
//
// Implementation: a button + absolute-positioned panel with a
// search input + filtered list of buttons. Avoids adding cmdk +
// @radix-ui/react-popover as new deps for a single use site.
// Click-outside collapse via document mousedown listener; Escape
// also collapses. Keyboard navigation is arrow-up/down through the
// filtered options, Enter to select, Escape to dismiss.
function ScopePicker({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return tabs;
    const q = query.trim().toLowerCase();
    return tabs.filter((t) => t.label.toLowerCase().includes(q));
  }, [tabs, query]);

  // Reset query + highlight whenever the panel opens. Focus the
  // input on the next paint so the operator can type immediately.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Click-outside collapse.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function commit(scopeValue: string) {
    onChange(scopeValue);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[highlight];
      if (target) commit(target.value);
      return;
    }
  }

  const activeLabel =
    tabs.find((t) => t.value === value)?.label ?? value ?? "Select scope";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        id="mcp-policies-scope-select"
        data-testid="mcp-policies-scope-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        // B10 styling preserved verbatim — accent left-border +
        // font-semibold so the scope being edited reads as the
        // page's primary context.
        className="flex h-9 w-[28rem] max-w-full items-center justify-between rounded-md border border-l-2 border-border bg-surface px-3 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-primary"
        style={{
          borderLeftColor: "var(--accent)",
          color: "var(--text)",
        }}
      >
        <span className="truncate">{activeLabel}</span>
        <span
          aria-hidden="true"
          className="ml-2 shrink-0 text-[10px] opacity-60"
        >
          ▼
        </span>
      </button>
      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+4px)] z-50 w-[28rem] max-w-[calc(100vw-3rem)] rounded-md border shadow-md"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface)",
          }}
          data-testid="mcp-policies-scope-panel"
        >
          <div
            className="border-b p-2"
            style={{ borderColor: "var(--border)" }}
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Filter scopes…"
              spellCheck={false}
              className="block w-full rounded border px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
              style={{
                borderColor: "var(--border)",
                background: "var(--background-elevated)",
                color: "var(--text)",
              }}
              data-testid="mcp-policies-scope-search"
            />
          </div>
          <div
            className="max-h-72 overflow-auto p-1"
            role="listbox"
            aria-label="Scope"
            data-testid="mcp-policies-scope-options"
          >
            {filtered.length === 0 ? (
              <div
                className="px-3 py-2 text-xs"
                style={{ color: "var(--text-muted)" }}
                data-testid="mcp-policies-scope-empty"
              >
                No scopes match “{query}”.
              </div>
            ) : (
              filtered.map((tab, i) => {
                const isActive = tab.value === value;
                const isHighlighted = i === highlight;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => commit(tab.value)}
                    onMouseEnter={() => setHighlight(i)}
                    data-testid={`mcp-policies-tab-${tab.value}`}
                    className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-left text-sm"
                    style={{
                      background: isHighlighted
                        ? "var(--background-elevated)"
                        : "transparent",
                      color: isActive ? "var(--accent)" : "var(--text)",
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    <span className="truncate">{tab.label}</span>
                    {isActive ? (
                      <span aria-hidden="true" className="ml-2 shrink-0">
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
