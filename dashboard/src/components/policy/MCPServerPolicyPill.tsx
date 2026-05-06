import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MCPPolicyResolveResult } from "@/lib/types";

export type MCPServerDecision =
  | { kind: "loading" }
  | { kind: "ok"; result: MCPPolicyResolveResult }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * Per-server policy decision pill rendered next to the server
 * name in the SessionDrawer MCP servers panel. Chroma-coded:
 * allow=success-green, warn=amber, block=danger-red,
 * unknown=neutral with a "no policy entry — using mode default"
 * tooltip. Skeleton pill while the resolve call is in flight;
 * a "no URL" pill for fingerprints whose URL the sensor didn't
 * capture.
 *
 * Lives outside SessionDrawer.tsx so it can be unit-tested
 * without mounting the full drawer + session-fetch + fleet store.
 */
export function MCPServerPolicyPill({
  decision,
  testId,
}: {
  decision: MCPServerDecision | undefined;
  testId: string;
}) {
  if (!decision || decision.kind === "loading") {
    return (
      <span
        className="inline-block h-3 w-12 animate-pulse rounded-full"
        style={{
          background:
            "color-mix(in srgb, var(--text-muted) 18%, transparent)",
        }}
        aria-hidden="true"
        data-testid={`mcp-server-policy-pill-${testId}-skeleton`}
      />
    );
  }
  if (decision.kind === "missing") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="cursor-help rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              borderColor: "var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
            }}
            data-testid={`mcp-server-policy-pill-${testId}-missing`}
          >
            no URL
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          The sensor didn&apos;t capture a URL for this server, so the policy
          can&apos;t resolve it.
        </TooltipContent>
      </Tooltip>
    );
  }
  if (decision.kind === "error") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="cursor-help rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              borderColor: "var(--danger)",
              background:
                "color-mix(in srgb, var(--danger) 10%, transparent)",
              color: "var(--danger)",
            }}
            data-testid={`mcp-server-policy-pill-${testId}-error`}
          >
            error
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {decision.message}
        </TooltipContent>
      </Tooltip>
    );
  }

  const result = decision.result;
  let label: string;
  let bg: string;
  let fg: string;
  let isUnknown = false;

  if (result.decision_path === "mode_default") {
    isUnknown = true;
    label = "unknown";
    bg = "transparent";
    fg = "var(--text-muted)";
  } else if (result.decision === "allow") {
    label = "allow";
    bg = "color-mix(in srgb, var(--success, #16a34a) 12%, transparent)";
    fg = "var(--success, #16a34a)";
  } else if (result.decision === "warn") {
    label = "warn";
    bg = "color-mix(in srgb, var(--warning, #d97706) 12%, transparent)";
    fg = "var(--warning, #d97706)";
  } else {
    label = "block";
    bg = "color-mix(in srgb, var(--danger) 12%, transparent)";
    fg = "var(--danger)";
  }

  const pill = (
    <span
      className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ borderColor: fg, background: bg, color: fg }}
      data-testid={`mcp-server-policy-pill-${testId}-${label}`}
    >
      {label}
    </span>
  );

  if (isUnknown) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{pill}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          No policy entry for this server — using the global mode default.
        </TooltipContent>
      </Tooltip>
    );
  }
  return pill;
}
