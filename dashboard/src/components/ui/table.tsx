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
  /** Horizontal alignment of the cell's content. Default is
   *  ``left`` — explicit on TableHead because the native ``<th>``
   *  default is ``text-align: center`` per HTML spec, which would
   *  float centered headers off the left-aligned values they sit
   *  above. Override to ``right`` for numeric columns whose cell
   *  content reads right-anchored. */
  align?: "left" | "center" | "right";
}

/**
 * Resolve {@link AlignProp.align} to a single text-align utility so
 * exactly one of ``text-left`` / ``text-center`` / ``text-right``
 * lands on the element. Conditionally adding multiple is fragile —
 * Tailwind's generated CSS ordering between these utilities is not
 * a contract, so the same element with both ``text-left`` and
 * ``text-right`` is non-deterministic. Picking one explicitly is.
 */
function alignClass(align: AlignProp["align"]): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
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
          alignClass(align),
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
          alignClass(align),
          className,
        )}
        {...props}
      >
        {children}
      </td>
    );
  },
);
