import { useState } from "react";

import { InfoIcon } from "@/components/ui/info-icon";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MCPPolicy } from "@/lib/types";
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
            <InfoIcon
              ariaLabel="Policy mode help"
              testId={`mcp-policy-mode-tooltip-trigger-${scopeKey}`}
              content={
                <>
                  <strong>Allow-list:</strong> every server is blocked
                  unless explicitly in the entry list.{" "}
                  <strong>Block-list:</strong> every server is allowed
                  unless explicitly in the entry list. See your entries
                  below to see which servers match.
                </>
              }
            />
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
                <ModeSegmented
                  value={(policy.mode as Mode) ?? "blocklist"}
                  onChange={handleMode}
                  disabled={savingMode}
                  testid={`mcp-policy-mode-segmented-${scopeKey}`}
                />
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
              <InfoIcon
                ariaLabel="Block on uncertainty help"
                testId={`mcp-policy-bou-tooltip-trigger-${scopeKey}`}
                content={
                  <>
                    Allow-list mode only. When ON, blocks against
                    servers not in your allow list emit a{" "}
                    <code className="rounded bg-[var(--background-elevated)] px-1 py-0.5 font-mono text-[10px]">
                      policy_mcp_block
                    </code>{" "}
                    audit event so you can review first-time encounters
                    with new servers. Hidden under Block-list mode (the
                    mode is permissive by default, so this toggle has
                    nothing to qualify).
                  </>
                }
              />
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

  // Standard radio-group keyboard semantics: arrows move FOCUS
  // (not commit). Space/Enter activate the focused button via
  // the existing onClick — no immediate-commit on arrow because
  // "I just navigated and the policy changed" is a surprise.
  function onKeyDown(
    e: React.KeyboardEvent<HTMLButtonElement>,
    currentIdx: number,
  ) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const nextIdx =
      e.key === "ArrowRight"
        ? (currentIdx + 1) % options.length
        : (currentIdx - 1 + options.length) % options.length;
    const nextOption = options[nextIdx];
    if (!nextOption) return;
    const nextEl = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
      `[data-testid="${testid}-${nextOption.value}"]`,
    );
    nextEl?.focus();
  }

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
      {options.map((opt, idx) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${opt.label}: ${opt.helper}`}
            title={opt.helper}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cn(
              "rounded-sm px-3 py-1.5 text-sm font-medium",
              // Transition only on background-color + color so
              // unrelated properties don't flicker on click.
              "transition-[background-color,color] duration-150 ease-out",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
              "disabled:cursor-not-allowed disabled:opacity-60",
              active
                ? "bg-[var(--accent)] text-white shadow-sm"
                : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
            data-active={active}
            data-testid={`${testid}-${opt.value}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
