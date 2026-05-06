import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MCPPolicy } from "@/lib/types";

export type Mode = "allowlist" | "blocklist";

export interface MCPPolicyHeaderProps {
  policy: MCPPolicy;
  scopeKey: string;
  /** Global tab → editable mode toggle. Flavor tabs hide it (D134). */
  modeEditable: boolean;
  /** Global mode value to render context on flavor tabs. */
  globalMode: Mode | null;
  onModeChange: (next: Mode) => Promise<void>;
  onBlockOnUncertaintyChange: (next: boolean) => Promise<void>;
}

/**
 * Renders the per-tab toolbar — segmented mode control (Global tab
 * only, D134) plus the ``block_on_uncertainty`` switch (every tab,
 * with low-key visual treatment when the resolved global mode is
 * ``blocklist`` because the toggle is a semantic no-op there per
 * ARCHITECTURE.md → "Per-server resolution").
 *
 * Mutations fire optimistically against the parent's PUT handler.
 * The toolbar surfaces the in-flight save state as a subtle
 * "Saving…" pill so the operator gets immediate feedback without a
 * blocking spinner.
 */
export function MCPPolicyHeader({
  policy,
  scopeKey,
  modeEditable,
  globalMode,
  onModeChange,
  onBlockOnUncertaintyChange,
}: MCPPolicyHeaderProps) {
  const [savingMode, setSavingMode] = useState(false);
  const [savingBOU, setSavingBOU] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveMode: Mode | null = modeEditable
    ? (policy.mode ?? null)
    : globalMode;
  const bouMeaningful = effectiveMode === "allowlist";

  async function handleMode(next: Mode) {
    if (next === policy.mode) return;
    setSavingMode(true);
    setError(null);
    try {
      await onModeChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update mode");
    } finally {
      setSavingMode(false);
    }
  }

  async function handleBOU(next: boolean) {
    if (next === policy.block_on_uncertainty) return;
    setSavingBOU(true);
    setError(null);
    try {
      await onBlockOnUncertaintyChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update toggle");
    } finally {
      setSavingBOU(false);
    }
  }

  return (
    <TooltipProvider>
      <div
        className="rounded-md border p-4"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface)",
        }}
        data-testid={`mcp-policy-header-${scopeKey}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-[18rem] flex-1">
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: "var(--text-muted)" }}
              >
                Mode
              </span>
              {modeEditable && savingMode ? (
                <span
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Saving…
                </span>
              ) : null}
            </div>

            {modeEditable ? (
              <ModeSegmented
                value={(policy.mode as Mode) ?? "blocklist"}
                onChange={handleMode}
                disabled={savingMode}
                testid={`mcp-policy-mode-segmented-${scopeKey}`}
              />
            ) : (
              <div
                className="mt-2 inline-flex items-center rounded-md border px-3 py-1.5 text-sm"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--background-elevated)",
                  color: "var(--text-muted)",
                }}
                data-testid={`mcp-policy-mode-readonly-${scopeKey}`}
              >
                Inherits global mode:{" "}
                <span
                  className="ml-1 font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {globalMode ?? "—"}
                </span>
              </div>
            )}
          </div>

          <div className={cn("min-w-[16rem]", !bouMeaningful && "opacity-60")}>
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: "var(--text-muted)" }}
              >
                Block on uncertainty
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="cursor-help text-[11px] underline decoration-dotted"
                    style={{ color: "var(--text-muted)" }}
                    data-testid={`mcp-policy-bou-tooltip-trigger-${scopeKey}`}
                  >
                    info
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  className="max-w-sm text-xs leading-relaxed"
                  data-testid={`mcp-policy-bou-tooltip-${scopeKey}`}
                >
                  Per-policy boolean toggle, default false, only meaningful in
                  allowlist mode. When true, the resolution algorithm's
                  fall-through case becomes "block + emit policy_mcp_block"
                  instead of the standard allowlist-mode block. The semantic
                  difference is auditing: block_on_uncertainty=true means "I
                  want a block decision recorded against this URL the first
                  time it's seen so I can promote it to a deliberate allow."
                  Under blocklist mode the toggle is ignored because the mode
                  default is already permissive.
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="mt-2 flex items-center gap-3">
              <Switch
                checked={policy.block_on_uncertainty}
                onCheckedChange={handleBOU}
                disabled={savingBOU}
                label="Block on uncertainty"
                data-testid={`mcp-policy-bou-switch-${scopeKey}`}
              />
              <span
                className="text-sm"
                style={{
                  color: bouMeaningful
                    ? "var(--text)"
                    : "var(--text-muted)",
                }}
              >
                {policy.block_on_uncertainty ? "On" : "Off"}
                {!bouMeaningful && (
                  <span className="ml-1 text-[11px]">
                    (no-op under {effectiveMode ?? "current"} mode)
                  </span>
                )}
              </span>
              {savingBOU ? (
                <span
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Saving…
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {error ? (
          <div
            className="mt-3 rounded-md border px-3 py-1.5 text-xs"
            style={{
              borderColor: "var(--danger)",
              background:
                "color-mix(in srgb, var(--danger) 10%, transparent)",
              color: "var(--danger)",
            }}
            data-testid={`mcp-policy-header-error-${scopeKey}`}
          >
            {error}
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

function ModeSegmented({
  value,
  onChange,
  disabled,
  testid,
}: {
  value: Mode;
  onChange: (next: Mode) => void;
  disabled: boolean;
  testid: string;
}) {
  const options: { value: Mode; label: string; helper: string }[] = [
    {
      value: "allowlist",
      label: "Allow-list",
      helper: "Block any server not explicitly allowed",
    },
    {
      value: "blocklist",
      label: "Block-list",
      helper: "Allow any server not explicitly blocked",
    },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="mt-2 inline-flex rounded-md border p-1"
      style={{
        borderColor: "var(--border)",
        background: "var(--background-elevated)",
      }}
      data-testid={testid}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          aria-label={`${opt.label}: ${opt.helper}`}
          title={opt.helper}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-sm px-3 py-1.5 text-sm transition-all",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            "disabled:cursor-not-allowed disabled:opacity-60",
            value === opt.value
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
          data-testid={`${testid}-${opt.value}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
