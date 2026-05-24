import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      // hover:bg-<token>/<N> drops on hex-valued vars; both
      // --primary-hover and --danger-hover live in themes.css and
      // resolve to a darker shade in each theme — using them
      // directly preserves the "slightly darker on hover" intent
      // that a transparent color-mix can't achieve on a light
      // surface (mixing with transparent lightens, doesn't darken).
      variant: {
        default: "bg-primary text-white shadow hover:bg-[var(--primary-hover)]",
        outline: "border border-border bg-transparent hover:bg-surface-hover",
        ghost: "hover:bg-surface-hover",
        destructive: "bg-danger text-white hover:bg-[var(--danger-hover)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-7 px-3 text-xs",
        lg: "h-11 px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
