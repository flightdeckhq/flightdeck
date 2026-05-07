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
import { useWhoamiStore } from "@/store/whoami";
// ``cn`` is preserved on import because ModeSegmented uses it for
// the segmented-control active-state styling below.

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

  // D147: viewer-mode treatment. Mode toggle + BOU switch render
  // disabled-with-tooltip for non-admin tokens; while whoami is in
  // flight (role === null) treat as disabled to prevent the brief
  // enabled flash a viewer would otherwise see.
  const role = useWhoamiStore((s) => s.role);
  const mutationsDisabled = role !== "admin";
  const mutationsTooltip =
    role === null
      ? "Loading…"
      : "Read-only — admin token required to change mode";

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
        className="rounded-md border p-5"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface)",
        }}
        data-testid={`mcp-policy-header-${scopeKey}`}
      >
        {/* Policy mode — load-bearing setting, deserves prominence */}
        <section
          aria-labelledby={`mcp-policy-mode-heading-${scopeKey}`}
          data-testid={`mcp-policy-mode-section-${scopeKey}`}
        >
          <div className="flex items-center gap-2">
            <h3
              id={`mcp-policy-mode-heading-${scopeKey}`}
              className="text-base font-semibold"
              style={{ color: "var(--text)" }}
            >
              Policy mode
            </h3>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="cursor-help text-[11px] underline decoration-dotted"
                  style={{ color: "var(--text-muted)" }}
                  data-testid={`mcp-policy-mode-tooltip-trigger-${scopeKey}`}
                >
                  info
                </span>
              </TooltipTrigger>
              <TooltipContent
                className="max-w-sm text-xs leading-relaxed"
                data-testid={`mcp-policy-mode-tooltip-${scopeKey}`}
              >
                For an (URL, name) evaluated against (global, flavor): if the
                per-flavor policy has a matching entry, use that entry's
                enforcement decision. Else if the global policy has a matching
                entry, use that. Else apply the global mode default: allowlist
                mode → block; blocklist mode → allow. Mode lives on the global
                policy only (D134).
              </TooltipContent>
            </Tooltip>
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
            <>
              <div className="mt-3">
                {mutationsDisabled ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-block"
                        data-testid={`mcp-policy-mode-segmented-disabled-${scopeKey}`}
                      >
                        <ModeSegmented
                          value={(policy.mode as Mode) ?? "blocklist"}
                          onChange={handleMode}
                          disabled
                          testid={`mcp-policy-mode-segmented-${scopeKey}`}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      className="max-w-xs text-xs leading-relaxed"
                      data-testid={`mcp-policy-mode-segmented-tooltip-${scopeKey}`}
                    >
                      {mutationsTooltip}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <ModeSegmented
                    value={(policy.mode as Mode) ?? "blocklist"}
                    onChange={handleMode}
                    disabled={savingMode}
                    testid={`mcp-policy-mode-segmented-${scopeKey}`}
                  />
                )}
              </div>
              <div
                className="mt-3 space-y-1 text-[12px] leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
                data-testid={`mcp-policy-mode-help-${scopeKey}`}
              >
                <p>
                  <span style={{ color: "var(--text)", fontWeight: 600 }}>
                    Allow-list:
                  </span>{" "}
                  every server blocked by default; explicit allow entries
                  open access.
                </p>
                <p>
                  <span style={{ color: "var(--text)", fontWeight: 600 }}>
                    Block-list:
                  </span>{" "}
                  every server allowed by default; explicit deny entries
                  block access.
                </p>
              </div>
            </>
          ) : (
            <div
              className="mt-3 inline-flex items-center rounded-md border px-3 py-1.5 text-sm"
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
        </section>

        {/* Block-on-uncertainty — hidden under blocklist mode (D134
            says BOU is only meaningful under allowlist; B2 spec
            chose hide-rather-than-grey to match Salesforce /
            Atlassian / Linear precedent — server-side value persists
            across mode flips so toggling allowlist back restores it). */}
        {bouMeaningful ? (
          <section
            className="mt-5 border-t pt-5"
            style={{ borderColor: "var(--border)" }}
            aria-labelledby={`mcp-policy-bou-heading-${scopeKey}`}
            data-testid={`mcp-policy-bou-section-${scopeKey}`}
          >
            <div className="flex items-center gap-2">
              <h4
                id={`mcp-policy-bou-heading-${scopeKey}`}
                className="text-sm font-semibold"
                style={{ color: "var(--text)" }}
              >
                Block on uncertainty
              </h4>
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
              {mutationsDisabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-block"
                      data-testid={`mcp-policy-bou-switch-disabled-${scopeKey}`}
                    >
                      <Switch
                        checked={policy.block_on_uncertainty}
                        onCheckedChange={handleBOU}
                        disabled
                        label="Block on uncertainty"
                        data-testid={`mcp-policy-bou-switch-${scopeKey}`}
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    className="max-w-xs text-xs leading-relaxed"
                    data-testid={`mcp-policy-bou-switch-tooltip-${scopeKey}`}
                  >
                    {mutationsTooltip}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Switch
                  checked={policy.block_on_uncertainty}
                  onCheckedChange={handleBOU}
                  disabled={savingBOU}
                  label="Block on uncertainty"
                  data-testid={`mcp-policy-bou-switch-${scopeKey}`}
                />
              )}
              <span
                className="text-sm"
                style={{ color: "var(--text)" }}
              >
                {policy.block_on_uncertainty ? "On" : "Off"}
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
          </section>
        ) : null}

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
