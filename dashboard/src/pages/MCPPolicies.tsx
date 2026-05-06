import { useCallback, useEffect, useMemo, useState } from "react";

import { MCPSoftLaunchBanner } from "@/components/policy/MCPSoftLaunchBanner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchFlavorMCPPolicy,
  fetchFlavors,
  fetchGlobalMCPPolicy,
} from "@/lib/api";
import type { MCPPolicy } from "@/lib/types";

/**
 * MCP Protection Policy management page (D128 / D131 / D135 / D139).
 *
 * v1 surface: a tabs shell with a Global tab plus one tab per flavor
 * that has runtime activity. Each tab renders its policy's
 * configuration -- mode (warn / block / allowlist), the
 * block-on-uncertainty toggle (global only, per D134), the entry
 * list, dry-run preview, version history, audit log, and metrics.
 *
 * Commit 2 of step 6 ships the page scaffold + routing only. The
 * mode / BOU toggles, entry table, editor dialog, resolve preview,
 * version history, diff, dry-run, metrics, YAML i/o, templates, and
 * audit trail land in commits 3-7.
 *
 * Soft-launch behaviour (D133) is surfaced via MCPSoftLaunchBanner
 * at the top of the page when SOFT_LAUNCH_ACTIVE is true and the
 * operator hasn't dismissed it.
 */
export function MCPPolicies() {
  const [globalPolicy, setGlobalPolicy] = useState<MCPPolicy | null>(null);
  const [flavors, setFlavors] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>("global");
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const loadGlobal = useCallback(async () => {
    setGlobalLoading(true);
    setGlobalError(null);
    try {
      const policy = await fetchGlobalMCPPolicy();
      setGlobalPolicy(policy);
    } catch {
      setGlobalError("Failed to load global MCP policy");
    } finally {
      setGlobalLoading(false);
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
        <TabsList
          className="flex flex-wrap"
          data-testid="mcp-policies-tablist"
        >
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              data-testid={`mcp-policies-tab-${tab.value}`}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="global" data-testid="mcp-policies-panel-global">
          <PolicyPanel
            scopeLabel="Global"
            scopeKey="global"
            loading={globalLoading}
            error={globalError}
            policy={globalPolicy}
            allowsBOU
          />
        </TabsContent>

        {flavors.map((flavor) => (
          <TabsContent
            key={flavor}
            value={`flavor:${flavor}`}
            data-testid={`mcp-policies-panel-${flavor}`}
          >
            <FlavorPolicyPanel flavor={flavor} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

interface PolicyPanelProps {
  scopeLabel: string;
  scopeKey: string;
  loading: boolean;
  error: string | null;
  policy: MCPPolicy | null;
  allowsBOU: boolean;
}

/**
 * Renders the read-only summary block for a given scope (global or
 * a flavor). Mode / BOU / entry counts come straight from the
 * policy DTO. The interactive editor / entry table / dry-run panels
 * land in commits 3-5 alongside this same component.
 */
function PolicyPanel({
  scopeLabel,
  scopeKey,
  loading,
  error,
  policy,
  allowsBOU,
}: PolicyPanelProps) {
  if (loading) {
    return (
      <div
        className="mt-4 rounded-md border px-4 py-6 text-sm"
        style={{
          borderColor: "var(--border)",
          background: "var(--background-elevated)",
          color: "var(--text-muted)",
        }}
        data-testid={`mcp-policy-loading-${scopeKey}`}
      >
        Loading {scopeLabel.toLowerCase()} policy&hellip;
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="mt-4 rounded-md border px-4 py-3 text-sm"
        style={{
          borderColor: "var(--danger)",
          background: "color-mix(in srgb, var(--danger) 10%, transparent)",
          color: "var(--danger)",
        }}
        data-testid={`mcp-policy-error-${scopeKey}`}
      >
        {error}
      </div>
    );
  }

  if (!policy) {
    return (
      <div
        className="mt-4 rounded-md border px-4 py-6 text-sm"
        style={{
          borderColor: "var(--border)",
          background: "var(--background-elevated)",
          color: "var(--text-muted)",
        }}
        data-testid={`mcp-policy-empty-${scopeKey}`}
      >
        No flavor policy. This flavor inherits the global policy.
      </div>
    );
  }

  const entryCount = policy.entries?.length ?? 0;
  const lastModified = formatTimestamp(policy.updated_at ?? policy.created_at);

  return (
    <div
      className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      data-testid={`mcp-policy-summary-${scopeKey}`}
    >
      <SummaryCard
        label="Mode"
        value={formatMode(policy.mode)}
        testid={`mcp-policy-mode-${scopeKey}`}
      />
      {allowsBOU ? (
        <SummaryCard
          label="Block on uncertainty"
          value={policy.block_on_uncertainty ? "On" : "Off"}
          testid={`mcp-policy-bou-${scopeKey}`}
        />
      ) : (
        <SummaryCard
          label="Block on uncertainty"
          value="Inherits from global"
          testid={`mcp-policy-bou-${scopeKey}`}
        />
      )}
      <SummaryCard
        label="Entries"
        value={String(entryCount)}
        testid={`mcp-policy-entries-${scopeKey}`}
      />
      <SummaryCard
        label="Version"
        value={`v${policy.version} · ${lastModified}`}
        testid={`mcp-policy-version-${scopeKey}`}
      />
    </div>
  );
}

function FlavorPolicyPanel({ flavor }: { flavor: string }) {
  const [policy, setPolicy] = useState<MCPPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFlavorMCPPolicy(flavor)
      .then((p) => {
        if (!cancelled) setPolicy(p);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load flavor policy");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flavor]);

  return (
    <PolicyPanel
      scopeLabel={`Flavor "${flavor}"`}
      scopeKey={flavor}
      loading={loading}
      error={error}
      policy={policy}
      allowsBOU={false}
    />
  );
}

function SummaryCard({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid: string;
}) {
  return (
    <div
      className="rounded-md border px-4 py-3"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
      }}
      data-testid={testid}
    >
      <div
        className="text-[11px] uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-sm font-medium"
        style={{ color: "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString();
}

function formatMode(mode: MCPPolicy["mode"]): string {
  if (mode === "allowlist") return "Allow-list";
  if (mode === "blocklist") return "Block-list";
  return "Inherits global mode";
}
