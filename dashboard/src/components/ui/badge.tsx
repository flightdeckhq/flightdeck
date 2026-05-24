import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      // bg-<theme-token>/<N> drops to no background under Tailwind v3
      // when the token is a hex CSS var; the arbitrary color-mix
      // value paints reliably in both neon-dark and clean-light.
      variant: {
        default: "bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] text-primary",
        active: "bg-[color-mix(in_srgb,var(--success)_20%,transparent)] text-success",
        idle: "bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] text-primary",
        stale: "bg-[color-mix(in_srgb,var(--warning)_20%,transparent)] text-warning",
        closed: "bg-[color-mix(in_srgb,var(--text-muted)_20%,transparent)] text-text-muted",
        lost: "bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] text-danger",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
