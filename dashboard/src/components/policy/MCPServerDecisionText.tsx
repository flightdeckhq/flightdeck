// D146: per-server policy decision rendered inline next to the
// server name in the SessionDrawer MCP SERVERS panel. Replaces
// MCPServerPolicyPill (retired step 6.8 commit 7) — two pill
// iterations (steps 6.6 + 6.7) failed the 1-second-glance bar
// because the pill's background-fill / text-contrast budget kept
// fighting the chroma readability. Inline coloured text passes
// the bar by removing the background-fill axis entirely.
//
// Rendering shape:
//   maps    · ALLOW
//   search  · ALLOW (default)   <- italic, opacity 0.7, "(default)" suffix
//   foo     · WARN
//   bar     · BLOCK
//
// Mode-default branch (D135 decision_path === "mode_default"):
// reduced opacity + italic + "(default)" textual qualifier so
// the operator can distinguish at a glance whether a server's
// decision came from an explicit policy entry vs the global
// mode fall-through. Native title attribute carries the
// attribution copy — no Radix Tooltip portal (the y=-324
// collision bug from step 6.7 A2 dies with the pill).

import type { MCPPolicyResolveResult } from "@/lib/types";

export type MCPServerDecision =
  | { kind: "loading" }
  | { kind: "ok"; result: MCPPolicyResolveResult }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function MCPServerDecisionText({
  decision,
  testId,
}: {
  decision: MCPServerDecision | undefined;
  testId: string;
}) {
  if (!decision || decision.kind === "loading") {
    return (
      <span
        className="inline-block h-3 w-16 animate-pulse rounded"
        style={{
          background:
            "color-mix(in srgb, var(--text-muted) 18%, transparent)",
        }}
        aria-hidden="true"
        data-testid={`mcp-server-decision-${testId}-skeleton`}
      />
    );
  }
  if (decision.kind === "missing") {
    return (
      <span
        className="text-[11px] italic"
        style={{ color: "var(--text-muted)" }}
        title="The sensor didn't capture a URL for this server, so the policy can't resolve it."
        data-testid={`mcp-server-decision-${testId}-missing`}
      >
        no URL
      </span>
    );
  }
  if (decision.kind === "error") {
    return (
      <span
        className="text-[11px]"
        style={{ color: "var(--danger)" }}
        title={decision.message}
        data-testid={`mcp-server-decision-${testId}-error`}
      >
        error
      </span>
    );
  }

  const result = decision.result;
  const isModeDefault = result.decision_path === "mode_default";

  let chroma: string;
  if (result.decision === "allow") {
    chroma = "var(--success, #16a34a)";
  } else if (result.decision === "warn") {
    chroma = "var(--warning, #d97706)";
  } else {
    chroma = "var(--danger)";
  }

  const label = result.decision.toUpperCase();
  const tooltip = isModeDefault
    ? `No explicit policy entry — falling through to global mode default (${result.decision}).`
    : undefined;

  return (
    <span
      className="inline-flex items-baseline gap-1 text-[11px] font-semibold uppercase tracking-wide"
      data-testid={`mcp-server-decision-${testId}-${
        isModeDefault ? `${result.decision}-default` : result.decision
      }`}
    >
      <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>
        ·
      </span>
      <span
        style={{
          color: chroma,
          opacity: isModeDefault ? 0.7 : 1,
          fontStyle: isModeDefault ? "italic" : "normal",
        }}
        title={tooltip}
      >
        {label}
        {isModeDefault ? (
          <span className="ml-1 font-normal normal-case">(default)</span>
        ) : null}
      </span>
    </span>
  );
}
