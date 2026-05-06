import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { resolveMCPPolicy } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MCPPolicyResolveResult } from "@/lib/types";

const RESOLVE_DEBOUNCE_MS = 300;
const STORAGE_KEY = "flightdeck-mcp-resolve-panel-expanded";

export interface MCPPolicyResolvePanelProps {
  flavor: string | null;
  scopeKey: string;
}

/**
 * Collapsible resolve-preview card that lives at the bottom of
 * every MCP Protection Policy tab (Global + per-flavor). The
 * operator types a (server URL, server name) pair and gets the
 * server's authoritative resolve decision via ``GET
 * /v1/mcp-policies/resolve`` — same endpoint the entry-edit
 * dialog uses, but standalone so the operator can validate any
 * URL against the saved policy without opening the editor.
 *
 * Educational surface: the architecture lifts the rationale
 * "operators verify their policy's effective behaviour before
 * they save" — the panel is the post-save half of that loop.
 *
 * Expansion state persists per-browser via ``localStorage``;
 * collapse-by-default keeps the page lightweight on first load.
 */
export function MCPPolicyResolvePanel({
  flavor,
  scopeKey,
}: MCPPolicyResolvePanelProps) {
  const [expanded, setExpanded] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("");
  const [result, setResult] = useState<MCPPolicyResolveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const debouncedUrl = useDebouncedValue(serverUrl, RESOLVE_DEBOUNCE_MS);
  const debouncedName = useDebouncedValue(serverName, RESOLVE_DEBOUNCE_MS);

  useEffect(() => {
    if (!expanded) return;
    if (!debouncedUrl.trim() || !debouncedName.trim()) {
      setResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    resolveMCPPolicy({
      flavor: flavor ?? undefined,
      server_url: debouncedUrl.trim(),
      server_name: debouncedName.trim(),
    })
      .then((res) => {
        if (cancelled) return;
        setResult(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult(null);
        setError(err instanceof Error ? err.message : "Resolve failed");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedUrl, debouncedName, flavor, expanded]);

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    }
  }

  return (
    <section
      className="rounded-md border"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
      }}
      data-testid={`mcp-policy-resolve-panel-${scopeKey}`}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={expanded}
        data-testid={`mcp-policy-resolve-panel-toggle-${scopeKey}`}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown
              className="h-4 w-4"
              style={{ color: "var(--text-muted)" }}
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-4 w-4"
              style={{ color: "var(--text-muted)" }}
              aria-hidden="true"
            />
          )}
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text)" }}
          >
            Resolve preview
          </h2>
        </div>
        <span
          className="text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          Verify what this policy says about a specific server.
        </span>
      </button>

      {expanded ? (
        <div className="border-t px-4 py-4" style={{ borderColor: "var(--border)" }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField
              id={`resolve-url-${scopeKey}`}
              label="Server URL"
              value={serverUrl}
              onChange={setServerUrl}
              placeholder="https://maps.example.com"
            />
            <FormField
              id={`resolve-name-${scopeKey}`}
              label="Server name"
              value={serverName}
              onChange={setServerName}
              placeholder="maps"
            />
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {loading ? "resolving…" : "live preview · 300ms debounce"}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setServerUrl("");
                setServerName("");
                setResult(null);
                setError(null);
              }}
              disabled={!serverUrl && !serverName}
              data-testid={`mcp-policy-resolve-panel-clear-${scopeKey}`}
            >
              Clear
            </Button>
          </div>

          <ResolveResultBlock
            scopeKey={scopeKey}
            url={debouncedUrl}
            name={debouncedName}
            result={result}
            error={error}
          />
        </div>
      ) : null}
    </section>
  );
}

function FormField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[11px] font-medium"
        style={{ color: "var(--text)" }}
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="h-8 w-full rounded-md border px-3 py-1 text-xs outline-none transition-colors focus:border-[var(--accent)]"
        style={{
          borderColor: "var(--border)",
          background: "var(--background-elevated)",
          color: "var(--text)",
        }}
        data-testid={id}
      />
    </div>
  );
}

function ResolveResultBlock({
  scopeKey,
  url,
  name,
  result,
  error,
}: {
  scopeKey: string;
  url: string;
  name: string;
  result: MCPPolicyResolveResult | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div
        className="mt-3 rounded-md border px-3 py-2 text-xs"
        style={{
          borderColor: "var(--danger)",
          background: "color-mix(in srgb, var(--danger) 10%, transparent)",
          color: "var(--danger)",
        }}
        data-testid={`mcp-policy-resolve-panel-error-${scopeKey}`}
      >
        {error}
      </div>
    );
  }

  if (!url.trim() || !name.trim()) {
    return (
      <p
        className="mt-3 text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        Fill both fields to see the live decision.
      </p>
    );
  }

  if (!result) return null;

  const colour = pillColour(result.decision);

  return (
    <div
      className="mt-3 rounded-md border px-3 py-3"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid={`mcp-policy-resolve-panel-result-${scopeKey}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
          )}
          style={{
            borderColor: colour,
            background: `color-mix(in srgb, ${colour} 14%, transparent)`,
            color: colour,
          }}
          data-testid={`mcp-policy-resolve-panel-pill-${result.decision}`}
        >
          {labelDecision(result.decision)}
        </span>
        <span
          className="text-[10px] uppercase tracking-wide"
          style={{ color: "var(--text-muted)" }}
        >
          {labelPath(result.decision_path)}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <Field label="Scope" value={result.scope} />
        <Field
          label="Policy"
          value={
            <span className="font-mono">
              {result.policy_id.slice(0, 8)}…
            </span>
          }
        />
        <Field
          label="Fingerprint"
          value={
            <span className="font-mono" title={result.fingerprint}>
              {result.fingerprint.slice(0, 16)}
            </span>
          }
        />
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt
        className="min-w-[5rem] text-[10px] uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </dt>
      <dd style={{ color: "var(--text)" }}>{value}</dd>
    </div>
  );
}

function labelDecision(decision: string): string {
  if (decision === "allow") return "Allow";
  if (decision === "warn") return "Warn";
  if (decision === "block") return "Block";
  return decision;
}

function labelPath(path: string): string {
  if (path === "flavor_entry") return "via flavor entry";
  if (path === "global_entry") return "via global entry";
  return "via mode default";
}

function pillColour(decision: string): string {
  if (decision === "allow") return "var(--success, #16a34a)";
  if (decision === "warn") return "var(--warning, #d97706)";
  return "var(--danger)";
}
