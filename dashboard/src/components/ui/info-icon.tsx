// Shared "info" tooltip primitive (D146 step 6.9). Renders the
// lucide ``Info`` icon at 14px in muted text colour, wrapped by a
// Radix Tooltip carrying ``content``. Replaces ad-hoc info-link
// spans (text-styled "info" with a dotted underline) that grew
// organically across the policy surface — those landed in three
// shapes (text "info", "?" button, abbr) and were impossible to
// theme consistently.
//
// API kept small on purpose: ``content`` is the tooltip body
// (ReactNode so callers can drop in formatted copy), ``ariaLabel``
// is the screen-reader label for the icon trigger. Callers don't
// supply test IDs — the primitive derives a stable one from
// ``ariaLabel`` so a sweep across info sites can grep them.

import { Info } from "lucide-react";
import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
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
  const resolvedTestId = testId ?? `info-icon-${slugify(ariaLabel)}`;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            // Tabbable so keyboard users can land on it and Radix
            // surfaces the tooltip on focus. ``cursor-help`` mirrors
            // the previous text-link affordance.
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
    </TooltipProvider>
  );
}
