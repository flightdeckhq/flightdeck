// Shared "info" tooltip primitive.
//
// Two interaction defects an earlier implementation shipped are
// handled here:
//
//   - "Tooltip auto-opens on dialog mount." Radix Tooltip's default
//     trigger fires on focus, and Radix Dialog's focus-trap moves
//     focus to the first focusable inside DialogContent on open. The
//     URL field's InfoIcon button rendered before the URL <input>,
//     so the dialog auto-focused it → tooltip auto-opened. The
//     dialog-side fix (onOpenAutoFocus preventDefault + manual
//     ref-focus on the URL input) lives in MCPPolicyEntryDialog.
//
//   - "Click doesn't reopen after dismissal." Radix Tooltip's
//     uncontrolled state has a pointerDown handler that closes the
//     tooltip on trigger click — so the click cycle is
//     pointerDown→close, pointerUp→focus-already-on-button→nothing.
//     Subsequent clicks land on an already-focused button → no
//     state change → tooltip stays closed. The fix here: explicit
//     controlled ``open`` state + ``onClick`` that toggles it. Hover
//     and Escape keep working via Radix's onOpenChange callback;
//     click-toggle layers on top.
//
// API kept small on purpose: ``content`` is the tooltip body
// (ReactNode so callers can drop in formatted copy), ``ariaLabel``
// is the screen-reader label for the icon trigger. Callers don't
// supply test IDs — the primitive derives a stable one from
// ``ariaLabel`` so a sweep across info sites can grep them.
//
// Consumers must wrap their tree in a ``<TooltipProvider>``. No
// provider is nested here because every current consumer
// (MCPPolicyHeader, MCPPolicyEntryDialog) already wraps, and the
// redundant nesting was harmless but obscured ownership.

import { Info } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface InfoIconProps {
  /** Tooltip body. ReactNode so callers can drop in formatted copy. */
  content: ReactNode;
  /** Screen-reader label for the icon trigger. Also drives the
   *  derived test ID (lowercased, non-alnum → '-'). Required so
   *  every info site declares its purpose explicitly — there's
   *  no sensible default. */
  ariaLabel: string;
  /** Optional caller-supplied test ID. Falls back to the derived
   *  ``info-icon-<slug>`` shape when omitted. */
  testId?: string;
  /** Class hook for the rendered ``<button>`` trigger. The icon
   *  itself is fixed at 14px to keep the visual rhythm uniform. */
  className?: string;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function InfoIcon({
  content,
  ariaLabel,
  testId,
  className,
}: InfoIconProps) {
  const [open, setOpen] = useState(false);
  const resolvedTestId = testId ?? `info-icon-${slugify(ariaLabel)}`;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-expanded={open}
          // Click toggles explicitly — overrides Radix's default
          // pointerDown-close so a second click reopens.
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex h-3.5 w-3.5 cursor-help items-center justify-center align-middle text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
            className,
          )}
          data-testid={resolvedTestId}
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        className="max-w-sm text-xs leading-relaxed"
        data-testid={`${resolvedTestId}-content`}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
