import {
  createContext,
  forwardRef,
  useContext,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

// Header context. TableHeader flips this to true; TableRow reads it
// to pick header styling (border-border + bg-surface) vs body
// styling (border-border-subtle + optional hover). A context flag
// is unambiguous at runtime; descendant Tailwind selectors collide
// with class ordering and would resolve non-deterministically.
const TableHeaderContext = createContext<boolean>(false);

export const Table = forwardRef<
  HTMLTableElement,
  HTMLAttributes<HTMLTableElement>
>(function Table({ className, ...props }, ref) {
  return (
    <table
      ref={ref}
      className={cn("w-full border-collapse", className)}
      {...props}
    />
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ children, ...props }, ref) {
  return (
    <TableHeaderContext.Provider value={true}>
      <thead ref={ref} {...props}>
        {children}
      </thead>
    </TableHeaderContext.Provider>
  );
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ ...props }, ref) {
  return <tbody ref={ref} {...props} />;
});

interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Body rows only. Adds hover highlight + pointer cursor for
   *  click targets (the row's onClick belongs to the consumer). */
  interactive?: boolean;
}

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  function TableRow({ className, interactive, ...props }, ref) {
    const inHeader = useContext(TableHeaderContext);
    const classes = inHeader
      ? "border-b border-border bg-surface"
      : cn(
          "border-b border-border-subtle",
          interactive && "cursor-pointer hover:bg-surface-hover",
        );
    return <tr ref={ref} className={cn(classes, className)} {...props} />;
  },
);

interface AlignProp {
  /** Pass-through to the cell's native `align` attribute. Numeric
   *  columns use `align="right"` so headers + cells share alignment
   *  without a per-call style override. */
  align?: "left" | "center" | "right";
}

interface TableHeadProps
  extends Omit<ThHTMLAttributes<HTMLTableCellElement>, "align">,
    AlignProp {
  children?: ReactNode;
}

export const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>(
  function TableHead({ className, align, children, ...props }, ref) {
    return (
      <th
        ref={ref}
        align={align}
        scope={props.scope ?? "col"}
        className={cn(
          "px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-secondary whitespace-nowrap",
          align === "right" && "text-right",
          align === "center" && "text-center",
          className,
        )}
        {...props}
      >
        {children}
      </th>
    );
  },
);

interface TableCellProps
  extends Omit<TdHTMLAttributes<HTMLTableCellElement>, "align">,
    AlignProp {
  /** Switch the cell to font-mono. Use for numbers, measurements,
   *  IDs, timestamps, and model strings — the canonical
   *  mono-for-data / UI-for-labels split. */
  mono?: boolean;
  children?: ReactNode;
}

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  function TableCell({ className, align, mono, children, ...props }, ref) {
    return (
      <td
        ref={ref}
        align={align}
        className={cn(
          "px-3 py-2 text-[12px] align-middle",
          mono && "font-mono",
          align === "right" && "text-right",
          align === "center" && "text-center",
          className,
        )}
        {...props}
      >
        {children}
      </td>
    );
  },
);
