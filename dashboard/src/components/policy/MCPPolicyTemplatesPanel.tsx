import { useEffect, useState } from "react";
import { AlertTriangle, BookOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  adminTokenError,
  ApiError,
  applyMCPPolicyTemplate,
  listMCPPolicyTemplates,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MCPPolicyTemplate } from "@/lib/types";
import { useWhoamiStore } from "@/store/whoami";

const MAINTENANCE_WARNING_TEMPLATE = "strict-with-common-allows";

export interface MCPPolicyTemplatesPanelProps {
  flavor: string;
  scopeKey: string;
  onApplied: () => Promise<void>;
}

/**
 * Templates picker (D138) for one MCP Protection Policy scope.
 * Calls ``GET /v1/mcp-policies/templates`` for the catalogue and
 * renders three cards (one per template) with name, description,
 * and recommended-for blurb. Apply triggers a confirmation dialog
 * — "This replaces your current policy" — before posting to
 * ``/apply_template``.
 *
 * The ``strict-with-common-allows`` template surfaces an extra
 * URL-maintenance warning prominently because the pre-populated
 * server URLs reflect well-known endpoints as of v0.6 release and
 * Flightdeck does not track upstream URL drift. The architecture
 * lifts this verbatim.
 */
export function MCPPolicyTemplatesPanel({
  flavor,
  scopeKey,
  onApplied,
}: MCPPolicyTemplatesPanelProps) {
  const [templates, setTemplates] = useState<MCPPolicyTemplate[] | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirm, setConfirm] = useState<{ template: MCPPolicyTemplate } | null>(
    null,
  );
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // D147: GET /templates is read-open — every authenticated bearer
  // can browse the catalogue. Apply still requires admin scope, so
  // hide the Apply button (and the confirm-dialog Apply CTA) for
  // viewers; the cards remain visible so operators can read what's
  // available before requesting an admin token.
  const role = useWhoamiStore((s) => s.role);
  const canMutate = role === "admin";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMCPPolicyTemplates()
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // GET /templates is read-open per D147; no 403 special-case
        // — surface real errors as real errors.
        setError(err instanceof Error ? err.message : "Failed to load templates");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleApply(template: MCPPolicyTemplate) {
    setApplying(true);
    setApplyError(null);
    try {
      await applyMCPPolicyTemplate(flavor, template.name);
      setConfirm(null);
      await onApplied();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setApplyError(adminTokenError("apply templates."));
      } else {
        setApplyError(err instanceof Error ? err.message : "Apply failed");
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <section
      className="rounded-md border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid={`mcp-policy-templates-${scopeKey}`}
    >
      <header
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <BookOpen
          className="h-4 w-4"
          style={{ color: "var(--text-muted)" }}
          aria-hidden="true"
        />
        <h2
          className="text-sm font-semibold"
          style={{ color: "var(--text)" }}
        >
          Templates
        </h2>
        <span
          className="text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          start from a curated baseline (D138)
        </span>
      </header>

      <div className="p-4">
        {loading ? (
          <SkeletonCards />
        ) : error ? (
          <ErrorState message={error} />
        ) : !templates || templates.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {templates.map((tpl) => (
              <TemplateCard
                key={tpl.name}
                template={tpl}
                onApply={
                  canMutate
                    ? () => setConfirm({ template: tpl })
                    : null
                }
                scopeKey={scopeKey}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={confirm != null}
        onOpenChange={(next) => {
          if (!next && !applying) {
            setConfirm(null);
            setApplyError(null);
          }
        }}
      >
        <DialogContent className="w-full max-w-md">
          <DialogTitle data-testid="mcp-policy-template-confirm-title">
            Apply template &ldquo;{confirm?.template.name}&rdquo;?
          </DialogTitle>
          <div className="mt-3 space-y-3 text-sm">
            <p style={{ color: "var(--text)" }}>
              This <strong>replaces</strong> your current policy. The previous
              state stays in version history and can be restored by re-applying
              an earlier export.
            </p>
            {confirm?.template.name === MAINTENANCE_WARNING_TEMPLATE ? (
              <div
                className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--warning, #d97706)",
                  background:
                    "color-mix(in srgb, var(--warning, #d97706) 10%, transparent)",
                  color: "var(--warning, #d97706)",
                }}
                data-testid="mcp-policy-template-confirm-warning"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  The pre-populated server URLs reflect well-known endpoints as
                  of the v0.6 release. Verify against your provider&rsquo;s
                  current documentation before relying on them — Flightdeck
                  does not track upstream MCP server URL changes.
                </span>
              </div>
            ) : null}
            {applyError ? (
              <div
                className="rounded-md border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--danger)",
                  background:
                    "color-mix(in srgb, var(--danger) 10%, transparent)",
                  color: "var(--danger)",
                }}
                data-testid="mcp-policy-template-confirm-error"
              >
                {applyError}
              </div>
            ) : null}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!applying) {
                  setConfirm(null);
                  setApplyError(null);
                }
              }}
              disabled={applying}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => confirm && handleApply(confirm.template)}
              disabled={applying || !confirm}
              data-testid="mcp-policy-template-confirm-apply"
            >
              {applying ? "Applying…" : "Replace policy"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TemplateCard({
  template,
  onApply,
  scopeKey,
}: {
  template: MCPPolicyTemplate;
  /** ``null`` for viewer tokens; the Apply button is hidden in that
   *  case (D147 — action-only affordances hide rather than disable). */
  onApply: (() => void) | null;
  scopeKey: string;
}) {
  const isMaintenanceWarning = template.name === MAINTENANCE_WARNING_TEMPLATE;
  return (
    <article
      className={cn(
        "flex h-full flex-col rounded-md border p-4 transition-colors",
        "hover:border-[var(--accent)]",
      )}
      style={{
        borderColor: isMaintenanceWarning
          ? "var(--warning, #d97706)"
          : "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid={`mcp-policy-template-card-${template.name}`}
    >
      <header className="flex items-start justify-between gap-2">
        <h3
          className="font-mono text-[13px] font-semibold"
          style={{ color: "var(--text)" }}
        >
          {template.name}
        </h3>
        {isMaintenanceWarning ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              borderColor: "var(--warning, #d97706)",
              background:
                "color-mix(in srgb, var(--warning, #d97706) 12%, transparent)",
              color: "var(--warning, #d97706)",
            }}
            title="URL-maintenance warning"
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            maintenance
          </span>
        ) : null}
      </header>
      <p
        className="mt-2 text-[12px] leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
        data-testid={`mcp-policy-template-card-desc-${template.name}`}
      >
        {template.description}
      </p>
      <p
        className="mt-3 text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        <span
          className="font-semibold uppercase tracking-wide"
          style={{ color: "var(--text-muted)" }}
        >
          Recommended for:
        </span>{" "}
        {template.recommended_for}
      </p>
      {onApply ? (
        <div className="mt-auto pt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={onApply}
            className="w-full"
            data-testid={`mcp-policy-template-card-apply-${template.name}`}
          >
            Apply to{" "}
            <span className="font-semibold">
              {scopeKey === "global" ? "Global" : scopeKey}
            </span>
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function SkeletonCards() {
  return (
    <div
      className="grid grid-cols-1 gap-3 lg:grid-cols-3"
      data-testid="mcp-policy-templates-skeleton"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-md border"
          style={{
            borderColor: "var(--border)",
            background:
              "color-mix(in srgb, var(--text-muted) 8%, transparent)",
          }}
        />
      ))}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="rounded-md border px-3 py-3 text-xs"
      style={{
        borderColor: "var(--danger)",
        background: "color-mix(in srgb, var(--danger) 10%, transparent)",
        color: "var(--danger)",
      }}
      data-testid="mcp-policy-templates-error"
    >
      {message}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded-md border px-4 py-6 text-center text-sm"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
        color: "var(--text-muted)",
      }}
      data-testid="mcp-policy-templates-empty"
    >
      No templates available.
    </div>
  );
}
