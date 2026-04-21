import type { Provider } from "@/lib/models";
import { PROVIDER_META } from "@/lib/models";
import { PROVIDER_ICONS, getProviderColor } from "./provider-icons";

interface ProviderIconSvgProps {
  provider: Provider;
  /** Top-left anchor in the parent SVG's coordinate space. */
  x: number;
  y: number;
  /** Rendered edge length (width = height). */
  size: number;
  /** Dark-theme override -- only required when the caller is rendering
   *  server-side or inside a portal where the ``<html class=dark>``
   *  sniff in ``ProviderLogo``'s default path isn't reliable. Normal
   *  client-side usage can omit this and let the value default to the
   *  current ``<html>`` class. */
  isDark?: boolean;
  /** Optional opacity override, handy for tick renderers that want to
   *  fade the mark under a hover state without changing the fill. */
  opacity?: number;
  /** Overrides the default tooltip (brand-cased provider name). Pass
   *  an empty string to suppress. */
  title?: string;
}

/** SVG-context sibling of ``ProviderLogo``. Both components read from
 *  the same ``PROVIDER_ICONS`` map so the icon definitions never
 *  diverge. Drop this inside an existing ``<svg>`` (e.g. a recharts
 *  custom Y-axis tick) at an explicit ``(x, y)`` anchor; it renders
 *  as a nested ``<svg>`` with viewBox scaling so the brand path's
 *  geometry maps cleanly onto ``size`` px regardless of the source
 *  viewBox. Nested SVG is valid and cross-browser -- deliberately
 *  avoided ``<foreignObject>`` here because it is flaky in Firefox
 *  when printed or exported.
 *
 *  Providers without a bespoke icon (``google``, ``xai``, ``mistral``,
 *  ``meta``, ``other``, ``unknown``) render as a muted filled circle
 *  at the same anchor so the column layout stays aligned across
 *  mixed-provider rows. */
export function ProviderIconSvg({
  provider,
  x,
  y,
  size,
  isDark,
  opacity,
  title,
}: ProviderIconSvgProps) {
  const icon = PROVIDER_ICONS[provider];
  const resolvedDark =
    isDark ??
    (typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"));
  const fill = getProviderColor(provider, resolvedDark);
  const resolvedTitle = title ?? PROVIDER_META[provider]?.label ?? provider;
  if (!icon) {
    const r = size / 2;
    return (
      <circle
        cx={x + r}
        cy={y + r}
        r={r * 0.7}
        fill={fill}
        opacity={opacity ?? 0.7}
      >
        {resolvedTitle && <title>{resolvedTitle}</title>}
      </circle>
    );
  }
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox={icon.viewBox}
      opacity={opacity}
      aria-label={resolvedTitle || undefined}
      role={resolvedTitle ? "img" : undefined}
    >
      {resolvedTitle && <title>{resolvedTitle}</title>}
      <path d={icon.path} fill={fill} fillRule={icon.fillRule} />
    </svg>
  );
}
