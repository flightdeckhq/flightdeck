import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Lightweight headless switch. shadcn ships
 * ``@radix-ui/react-switch`` but the rest of the dashboard already
 * uses native ``<button role="switch">`` patterns elsewhere; adding a
 * Radix dep just for this surface inflates the bundle without
 * changing keyboard or screen-reader behaviour. The button preserves
 * focus, is operable via Space / Enter through standard browser
 * semantics, and exposes ``aria-checked`` so assistive tech reads
 * the on/off state correctly.
 */
export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: string;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, label, className, disabled, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked
            ? "bg-[var(--accent)]"
            : "bg-[var(--border)]",
          className,
        )}
        {...rest}
      >
        <span
          className={cn(
            "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    );
  },
);
Switch.displayName = "Switch";
