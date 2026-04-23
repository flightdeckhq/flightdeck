import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Single-line truncating text primitive with auto-revealing tooltip.
 *
 * Behaviour:
 *
 *   * Renders ``text`` with ``overflow: hidden; text-overflow:
 *     ellipsis; white-space: nowrap`` so it collapses to a one-line
 *     ellipsis when the container is narrower than the intrinsic
 *     text width.
 *   * Detects at runtime whether the text is ACTUALLY truncated by
 *     comparing ``scrollWidth`` to ``clientWidth`` and re-checks on
 *     every container resize via ResizeObserver. If the text fits,
 *     no tooltip attribute is set -- avoids noisy hover reveals on
 *     values that happen to be the same as their own tooltip.
 *   * When truncated, sets the native ``title`` attribute to the
 *     full text. Native tooltips are a11y-free, browser-consistent,
 *     and need no Provider wrapping -- that's the floor; callers who
 *     want richer Radix-based tooltips can wrap ``<TruncatedText/>``
 *     in a ``<Tooltip>`` at the site level.
 *
 * Rule (added to ``audit-phase-2.md`` in this same PR): any
 * dashboard component rendering text sourced from user / DB /
 * dynamic data MUST default to ``<TruncatedText/>``. Raw ``truncate``
 * Tailwind utility or hand-rolled ``textOverflow: ellipsis`` styles
 * on dynamic text are the anti-pattern; they hide full values from
 * the user with no way to recover.
 */
export interface TruncatedTextProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "title" | "children"> {
  /** Full text. Renders verbatim; tooltip surfaces it on truncation. */
  text: string;
  /**
   * Render tag. ``span`` by default; callers using this inside a
   * table cell should pass ``div`` (the cell's layout already
   * establishes the truncation container) or set ``block`` via
   * ``className``.
   */
  as?: "span" | "div";
}

export function TruncatedText({
  text,
  as = "span",
  className,
  style,
  ...rest
}: TruncatedTextProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // scrollWidth measures the intrinsic content width; clientWidth
    // measures the visible box. A difference of >= 1px means the
    // browser would be rendering an ellipsis, so the user needs a
    // tooltip to see the hidden tail.
    const next = el.scrollWidth > el.clientWidth;
    setIsTruncated((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    check();
  }, [text, check]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => check());
    ro.observe(el);
    // Also observe the parent so width changes that come from the
    // container collapsing (e.g. sidebar drag) still fire.
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [check]);

  const commonProps = {
    ref: ref as unknown as React.Ref<never>,
    className: cn(
      "inline-block max-w-full overflow-hidden whitespace-nowrap align-bottom",
      className,
    ),
    style: { textOverflow: "ellipsis" as const, ...style },
    // Only set the tooltip when the ellipsis is actually rendered.
    // A fits-in-container value gets no hover affordance.
    title: isTruncated ? text : undefined,
    ...rest,
  };

  if (as === "div") {
    return <div {...(commonProps as HTMLAttributes<HTMLDivElement>)}>{text}</div>;
  }
  return <span {...commonProps}>{text}</span>;
}
