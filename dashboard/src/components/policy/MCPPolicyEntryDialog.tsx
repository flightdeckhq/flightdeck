import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { resolveMCPPolicy } from "@/lib/api";
import type {
  MCPPolicyEntry,
  MCPPolicyMutationEntry,
  MCPPolicyResolveResult,
} from "@/lib/types";

export type EnforcementValue = "warn" | "block" | "interactive" | "none";

export interface MCPPolicyEntryDialogProps {
  open: boolean;
  /** undefined → add. defined → edit. */
  initial?: MCPPolicyEntry;
  /** flavor scope for the resolve preview; null → resolve against global. */
  flavor: string | null;
  onClose: () => void;
  onSave: (mutation: MCPPolicyMutationEntry) => Promise<void>;
}

const RESOLVE_DEBOUNCE_MS = 300;

const inputClass =
  "h-9 w-full rounded-md border bg-[var(--background-elevated)] px-3 py-1 text-sm outline-none transition-colors focus:border-[var(--accent)]";

/**
 * Add / edit dialog for an MCP policy entry. While the operator
 * types into the URL or Name fields, the dialog fires a debounced
 * (300ms — D135 § "Add / edit dialog") ``GET /v1/mcp-policies/
 * resolve`` and renders the server's authoritative decision in a
 * preview pill alongside the canonical fingerprint that will be
 * stored. This is the operator's loop-closer: they see exactly what
 * the policy will say about this server before committing the
 * mutation.
 *
 * Mutations are submitted as a single ``MCPPolicyMutationEntry`` to
 * the parent; the parent bundles the change with the rest of the
 * draft and PUTs the whole policy (D128 — replace semantics).
 */
export function MCPPolicyEntryDialog({
  open,
  initial,
  flavor,
  onClose,
  onSave,
}: MCPPolicyEntryDialogProps) {
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("");
  const [entryKind, setEntryKind] = useState<"allow" | "deny">("allow");
  const [enforcement, setEnforcement] = useState<EnforcementValue>("none");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset every time the dialog opens with a new ``initial``.
  useEffect(() => {
    if (!open) return;
    setServerUrl(initial?.server_url ?? "");
    setServerName(initial?.server_name ?? "");
    setEntryKind(initial?.entry_kind ?? "allow");
    setEnforcement(
      (initial?.enforcement as EnforcementValue | null) ?? "none",
    );
    setError(null);
  }, [open, initial]);

  const debouncedUrl = useDebouncedValue(serverUrl, RESOLVE_DEBOUNCE_MS);
  const debouncedName = useDebouncedValue(serverName, RESOLVE_DEBOUNCE_MS);

  const [resolveResult, setResolveResult] = useState<MCPPolicyResolveResult | null>(
    null,
  );
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!debouncedUrl.trim() || !debouncedName.trim()) {
      setResolveResult(null);
      setResolveError(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    setResolveError(null);
    resolveMCPPolicy({
      flavor: flavor ?? undefined,
      server_url: debouncedUrl.trim(),
      server_name: debouncedName.trim(),
    })
      .then((res) => {
        if (cancelled) return;
        setResolveResult(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResolveResult(null);
        setResolveError(
          err instanceof Error ? err.message : "Resolve preview failed",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedUrl, debouncedName, flavor, open]);

  const validation = useMemo(() => validate(serverUrl, serverName), [
    serverUrl,
    serverName,
  ]);

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (validation.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        server_url: serverUrl.trim(),
        server_name: serverName.trim(),
        entry_kind: entryKind,
        enforcement: enforcement === "none" ? null : enforcement,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save entry");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="w-full max-w-lg">
        <DialogTitle data-testid="mcp-policy-entry-dialog-title">
          {initial ? "Edit entry" : "Add entry"}
        </DialogTitle>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="mcp-policy-entry-url"
              className="mb-1 block text-xs font-medium"
              style={{ color: "var(--text)" }}
            >
              Server URL
            </label>
            <input
              id="mcp-policy-entry-url"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://maps.example.com or stdio:///opt/bin/srv"
              autoComplete="off"
              className={inputClass}
              style={{
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
              data-testid="mcp-policy-entry-url"
              required
            />
            <p
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              HTTP / HTTPS / SSE / WebSocket URLs are canonicalised
              (lowercase scheme + host, default port stripped, trailing
              root slash dropped). Stdio launches use the
              <code className="mx-0.5 rounded bg-[var(--background-elevated)] px-1 py-0.5 font-mono text-[10px]">
                stdio://
              </code>
              prefix.
            </p>
          </div>

          <div>
            <label
              htmlFor="mcp-policy-entry-name"
              className="mb-1 block text-xs font-medium"
              style={{ color: "var(--text)" }}
            >
              Server name
            </label>
            <input
              id="mcp-policy-entry-name"
              type="text"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="maps"
              autoComplete="off"
              className={inputClass}
              style={{
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
              data-testid="mcp-policy-entry-name"
              required
            />
            <p
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              Human-readable identifier shipped by the agent's MCP
              client. The fingerprint is{" "}
              <code className="rounded bg-[var(--background-elevated)] px-1 py-0.5 font-mono text-[10px]">
                sha256(canonical_url + 0x00 + name)
              </code>
              ; both fields participate.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                style={{ color: "var(--text)" }}
              >
                Decision
              </label>
              <Select
                value={entryKind}
                onValueChange={(v) => setEntryKind(v as "allow" | "deny")}
              >
                <SelectTrigger
                  className="w-full"
                  data-testid="mcp-policy-entry-kind"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                style={{ color: "var(--text)" }}
              >
                Enforcement
              </label>
              <Select
                value={enforcement}
                onValueChange={(v) => setEnforcement(v as EnforcementValue)}
              >
                <SelectTrigger
                  className="w-full"
                  data-testid="mcp-policy-entry-enforcement"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Default for this kind</SelectItem>
                  <SelectItem value="warn">Warn</SelectItem>
                  <SelectItem value="block">Block</SelectItem>
                  <SelectItem value="interactive">Interactive</SelectItem>
                </SelectContent>
              </Select>
              <p
                className="mt-1 text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Interactive is Claude Code plugin only — the sensor
                never sees it on the per-call hot path.
              </p>
            </div>
          </div>

          <ResolvePreview
            url={debouncedUrl}
            name={debouncedName}
            resolving={resolving}
            result={resolveResult}
            error={resolveError}
          />

          {validation.length > 0 ? (
            <ul
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--danger)",
                background:
                  "color-mix(in srgb, var(--danger) 10%, transparent)",
                color: "var(--danger)",
              }}
              data-testid="mcp-policy-entry-validation"
            >
              {validation.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <div
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--danger)",
                background:
                  "color-mix(in srgb, var(--danger) 10%, transparent)",
                color: "var(--danger)",
              }}
              data-testid="mcp-policy-entry-error"
            >
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || validation.length > 0}
              data-testid="mcp-policy-entry-submit"
            >
              {saving ? "Saving…" : initial ? "Update entry" : "Add entry"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResolvePreview({
  url,
  name,
  resolving,
  result,
  error,
}: {
  url: string;
  name: string;
  resolving: boolean;
  result: MCPPolicyResolveResult | null;
  error: string | null;
}) {
  const empty = !url.trim() || !name.trim();
  if (empty) {
    return (
      <div
        className="rounded-md border px-3 py-2 text-[11px]"
        style={{
          borderColor: "var(--border)",
          background: "var(--background-elevated)",
          color: "var(--text-muted)",
        }}
        data-testid="mcp-policy-entry-resolve-empty"
      >
        Live preview will appear after you fill URL and Name.
      </div>
    );
  }

  return (
    <div
      className="rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid="mcp-policy-entry-resolve"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            Live preview
          </span>
          {resolving ? (
            <span
              className="text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              resolving…
            </span>
          ) : null}
        </div>
        {result ? (
          <DecisionPreviewPill decision={result.decision} />
        ) : null}
      </div>

      {error ? (
        <p
          className="mt-1 text-[11px]"
          style={{ color: "var(--danger)" }}
        >
          {error}
        </p>
      ) : result ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <DT label="Source">{formatSource(result.decision_path)}</DT>
          <DT label="Scope">{result.scope}</DT>
          <DT label="Policy">
            <span className="font-mono">
              {result.policy_id.slice(0, 8)}…
            </span>
          </DT>
          <DT label="Fingerprint">
            <span className="font-mono">
              {result.fingerprint.slice(0, 16)}
            </span>
          </DT>
        </dl>
      ) : !resolving ? (
        <p
          className="mt-1 text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          Awaiting resolve…
        </p>
      ) : null}
    </div>
  );
}

function DT({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt
        className="min-w-[5rem] text-[10px] uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </dt>
      <dd style={{ color: "var(--text)" }}>{children}</dd>
    </div>
  );
}

function DecisionPreviewPill({
  decision,
}: {
  decision: MCPPolicyResolveResult["decision"];
}) {
  let bg: string;
  let fg: string;
  let label: string;

  if (decision === "allow") {
    label = "Allow";
    bg = "color-mix(in srgb, var(--success, #16a34a) 14%, transparent)";
    fg = "var(--success, #16a34a)";
  } else if (decision === "warn") {
    label = "Warn";
    bg = "color-mix(in srgb, var(--warning, #d97706) 14%, transparent)";
    fg = "var(--warning, #d97706)";
  } else {
    label = "Block";
    bg = "color-mix(in srgb, var(--danger) 14%, transparent)";
    fg = "var(--danger)";
  }

  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold"
      style={{ borderColor: fg, background: bg, color: fg }}
      data-testid={`mcp-policy-entry-resolve-pill-${decision}`}
    >
      {label}
    </span>
  );
}

function formatSource(path: MCPPolicyResolveResult["decision_path"]): string {
  if (path === "flavor_entry") return "Flavor entry";
  if (path === "global_entry") return "Global entry";
  return "Mode default";
}

function validate(url: string, name: string): string[] {
  const errs: string[] = [];
  if (!url.trim()) errs.push("Server URL is required.");
  if (!name.trim()) errs.push("Server name is required.");
  return errs;
}
