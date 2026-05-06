import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
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
 * name in the SessionDrawer MCP servers panel.
 *
 * Three rendering branches keyed on decision_path (D135):
 * - flavor_entry / global_entry → solid chroma fill matching
 *   timeline badges (allow=success-green, warn=amber, block=
 *   danger-red). The decision is explicit policy state.
 * - mode_default → SUBDUED treatment of the same chroma: dashed
 *   border, lower-opacity fill, italic text, "(default)" suffix
 *   on the label. The decision is real (operators DO need to
 *   know what would happen), but the visual weight signals
 *   "this isn't an explicit policy entry" at a glance — see
 *   step 6.7 A2 lock.
 * - missing/error/loading → skeleton, "no URL" outline, or
 *   error pill respectively.
 *
 * All tooltips are wrapped in a TooltipProvider with
 * `side="bottom"` + collisionPadding so the floating content
 * never spills above the viewport (pre-fix the SessionDrawer
 * MCP panel rendered tooltip portals at y=-324 against the
 * top edge — A2 layout bug).
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
      <TooltipProvider>
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
          <TooltipContent
            side="bottom"
            collisionPadding={8}
            className="max-w-xs text-xs"
          >
            The sensor didn&apos;t capture a URL for this server, so the policy
            can&apos;t resolve it.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (decision.kind === "error") {
    return (
      <TooltipProvider>
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
          <TooltipContent
            side="bottom"
            collisionPadding={8}
            className="max-w-xs text-xs"
          >
            {decision.message}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const result = decision.result;
  const isModeDefault = result.decision_path === "mode_default";

  // Chroma maps to the actual decision (allow/warn/block) — even
  // for mode_default the underlying decision is real and
  // operators need to see what would happen. The visual weight
  // distinction (subdued vs solid) signals explicit-vs-default,
  // not the decision itself.
  let chromaFg: string;
  let chromaBg: string;
  if (result.decision === "allow") {
    chromaFg = "var(--success, #16a34a)";
    chromaBg = "color-mix(in srgb, var(--success, #16a34a) 12%, transparent)";
  } else if (result.decision === "warn") {
    chromaFg = "var(--warning, #d97706)";
    chromaBg = "color-mix(in srgb, var(--warning, #d97706) 12%, transparent)";
  } else {
    chromaFg = "var(--danger)";
    chromaBg = "color-mix(in srgb, var(--danger) 12%, transparent)";
  }

  // Step 6.7 A2 visual-weight lock: operators must distinguish
  // explicit-policy pills from mode-default pills in 1 second of
  // glance — see the side-by-side Chrome verification. Three
  // signals stack: (a) DASHED border vs solid (peripheral cue),
  // (b) reduced-opacity fill (4% vs 12%, half saturation),
  // (c) "(default)" SUFFIX (textual confirmation when the
  // operator does focus). The label still leads with the actual
  // decision (allow/warn/block) so the chroma + word agree even
  // under quick scan.
  const label = isModeDefault ? `${result.decision} (default)` : result.decision;
  const subduedBg = isModeDefault
    ? `color-mix(in srgb, ${chromaFg} 4%, transparent)`
    : chromaBg;
  const borderStyle = isModeDefault ? "dashed" : "solid";
  // Italic mode-default; upright explicit. Reinforces the "this
  // isn't a real entry" cue typographically without changing
  // size (size-reduction was an option but the pill is already
  // small at 10px — italics give the same weight signal at
  // current size).
  const fontStyle = isModeDefault ? "italic" : "normal";

  const pill = (
    <span
      className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{
        borderColor: chromaFg,
        borderStyle,
        background: subduedBg,
        color: chromaFg,
        fontStyle,
      }}
      data-testid={`mcp-server-policy-pill-${testId}-${
        isModeDefault ? `${result.decision}-default` : result.decision
      }`}
    >
      {label}
    </span>
  );

  if (isModeDefault) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help">{pill}</span>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            collisionPadding={8}
            className="max-w-xs text-xs"
          >
            No explicit policy entry for this server — falling through to
            the global mode default ({result.decision}).
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return pill;
}
