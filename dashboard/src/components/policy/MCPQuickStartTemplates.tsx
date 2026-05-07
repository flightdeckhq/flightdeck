// D146: MCP Protection Policy quick-start link. Renders inside the
// entries table's empty state when entryCount === 0 AND the
// operator hasn't applied a template on this scope this session
// (per-scope ephemeral flag in useMCPQuickStartStore) AND the
// bearer token is admin (apply is admin-gated per D147; viewers
// see no link). Replaces the standalone three-card grid that
// previously sat above the entries table.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  adminTokenError,
  ApiError,
  applyMCPPolicyTemplate,
  listMCPPolicyTemplates,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MCPPolicyTemplate } from "@/lib/types";
import { useMCPQuickStartStore } from "@/store/quickStart";
import { useWhoamiStore } from "@/store/whoami";

const MAINTENANCE_WARNING_TEMPLATE = "strict-with-common-allows";

export interface MCPQuickStartTemplatesProps {
  /** Apply target — "global" or the flavor name. */
  flavor: string;
  /** Per-scope dedup key for the ephemeral flag. */
  scopeKey: string;
  /** Caller's current entries; the link hides when > 0. */
  entryCount: number;
  /** Callback the parent fires post-apply to reload its policy. */
  onApplied: () => Promise<void>;
}

export function MCPQuickStartTemplates({
  flavor,
  scopeKey,
  entryCount,
  onApplied,
}: MCPQuickStartTemplatesProps) {
  const role = useWhoamiStore((s) => s.role);
  const wasApplied = useMCPQuickStartStore((s) => s.wasApplied(scopeKey));
  const markApplied = useMCPQuickStartStore((s) => s.markApplied);

  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<MCPPolicyTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [applyingName, setApplyingName] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Click-outside-to-close. The popover-close gesture is the
  // natural reset for a stale apply error (no auto-dismiss timer).
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setApplyError(null);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // Lazy-load templates only on first open. Keeps the empty-state
  // render cheap — one HTTP roundtrip per session instead of one
  // per render.
  useEffect(() => {
    if (!open || templates !== null || loading) return;
    setLoading(true);
    setError(null);
    listMCPPolicyTemplates()
      .then((list) => setTemplates(list))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load templates"),
      )
      .finally(() => setLoading(false));
  }, [open, templates, loading]);

  // Visibility gates. role === null → whoami in flight; treat as
  // hidden to prevent the brief flash a viewer would otherwise see
  // (D147).
  if (role !== "admin") return null;
  if (entryCount > 0) return null;
  if (wasApplied) return null;

  async function handleApply(template: MCPPolicyTemplate) {
    setApplyingName(template.name);
    setApplyError(null);
    try {
      await applyMCPPolicyTemplate(flavor, template.name);
      markApplied(scopeKey);
      setOpen(false);
      await onApplied();
    } catch (err) {
      // 403 race-guard: token swap mid-flight where an admin
      // become a viewer between component-mount visibility check
      // and the apply request landing. Surfaces actionable copy.
      if (err instanceof ApiError && err.status === 403) {
        setApplyError(adminTokenError("apply templates."));
      } else {
        setApplyError(err instanceof Error ? err.message : "Apply failed");
      }
    } finally {
      setApplyingName(null);
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="relative mt-4"
      data-testid={`mcp-quickstart-templates-${scopeKey}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 text-[13px] font-medium",
          "underline decoration-dotted underline-offset-2",
          "transition-colors hover:text-[var(--accent)]",
        )}
        style={{ color: "var(--text-secondary)" }}
        data-testid={`mcp-quickstart-templates-trigger-${scopeKey}`}
        aria-expanded={open}
      >
        <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
        Quick start: apply a template
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            open ? "rotate-180" : "rotate-0",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          className="absolute left-1/2 top-full z-20 mt-2 w-[420px] -translate-x-1/2 rounded-md border p-2 shadow-lg"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface)",
          }}
          data-testid={`mcp-quickstart-templates-popover-${scopeKey}`}
        >
          {loading ? (
            <div
              className="px-3 py-4 text-center text-[12px]"
              style={{ color: "var(--text-muted)" }}
              data-testid={`mcp-quickstart-templates-loading-${scopeKey}`}
            >
              Loading templates…
            </div>
          ) : error ? (
            <div
              className="px-3 py-4 text-center text-[12px]"
              style={{ color: "var(--danger, #ef4444)" }}
              data-testid={`mcp-quickstart-templates-error-${scopeKey}`}
            >
              {error}
            </div>
          ) : templates && templates.length > 0 ? (
            <ul className="space-y-1">
              {templates.map((tpl) => (
                <li
                  key={tpl.name}
                  className="rounded px-3 py-2 transition-colors hover:bg-[var(--background-elevated)]"
                  data-testid={`mcp-quickstart-templates-row-${tpl.name}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-mono text-[12px] font-semibold"
                          style={{ color: "var(--text)" }}
                        >
                          {tpl.name}
                        </span>
                        {tpl.name === MAINTENANCE_WARNING_TEMPLATE ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              borderColor: "var(--warning, #d97706)",
                              background:
                                "color-mix(in srgb, var(--warning, #d97706) 12%, transparent)",
                              color: "var(--warning, #d97706)",
                            }}
                            title="URL-maintenance warning"
                            data-testid={`mcp-quickstart-templates-maintenance-chip-${tpl.name}`}
                          >
                            <AlertTriangle
                              className="h-3 w-3"
                              aria-hidden="true"
                            />
                            maintenance
                          </span>
                        ) : null}
                      </div>
                      <p
                        className="mt-1 text-[11px] leading-snug"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {tpl.description}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={applyingName !== null}
                      onClick={() => handleApply(tpl)}
                      data-testid={`mcp-quickstart-templates-apply-${tpl.name}`}
                    >
                      {applyingName === tpl.name ? "Applying…" : "Apply"}
                    </Button>
                  </div>
                </li>
              ))}
              {applyError ? (
                <li
                  className="px-3 py-2 text-[11px]"
                  style={{ color: "var(--danger, #ef4444)" }}
                  data-testid={`mcp-quickstart-templates-apply-error-${scopeKey}`}
                >
                  {applyError}
                </li>
              ) : null}
            </ul>
          ) : (
            <div
              className="px-3 py-4 text-center text-[12px]"
              style={{ color: "var(--text-muted)" }}
            >
              No templates available.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
