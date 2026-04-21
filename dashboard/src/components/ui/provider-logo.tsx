import { Sparkles } from "lucide-react";
import type { Provider } from "@/lib/models";
import { PROVIDER_META } from "@/lib/models";
import {
  PROVIDER_ICONS,
  getProviderColor,
  isDarkTheme,
} from "./provider-icons";

interface ProviderLogoProps {
  provider: Provider;
  size?: number;
  className?: string;
  /** Overrides the default tooltip / aria-label (normally the
   *  brand-cased provider name from ``PROVIDER_META``). Pass an empty
   *  string to opt out when the icon sits next to already-visible
   *  label text. */
  title?: string;
}

/** HTML-context wrapper around the shared ``PROVIDER_ICONS`` map.
 *  Renders a full ``<svg>`` element sized at ``size`` × ``size`` with
 *  the provider's brand path filled in the resolved theme color.
 *  Providers without a bespoke mark fall back to the lucide
 *  ``Sparkles`` icon so the visual slot stays filled. For use inside
 *  an existing SVG (recharts Y-axis tick) use ``ProviderIconSvg``
 *  instead -- nesting two ``<svg>`` elements via this component works,
 *  but the sibling is designed for that positioning.
 *
 *  Every rendered variant carries an inline ``<title>`` child (hover
 *  tooltip) plus ``role="img"`` and ``aria-label`` so screen readers
 *  announce the provider name. Pass ``title=""`` to suppress when the
 *  caller already renders a visible label. */
export function ProviderLogo({
  provider,
  size = 14,
  className,
  title,
}: ProviderLogoProps) {
  const resolvedTitle = title ?? PROVIDER_META[provider]?.label ?? provider;
  const icon = PROVIDER_ICONS[provider];
  if (!icon) {
    return (
      <Sparkles
        size={size}
        className={className}
        aria-label={resolvedTitle || undefined}
        aria-hidden={resolvedTitle ? undefined : true}
        role={resolvedTitle ? "img" : undefined}
        style={{
          color: "var(--text-muted)",
          display: "inline-block",
          verticalAlign: "middle",
        }}
      >
        {resolvedTitle && <title>{resolvedTitle}</title>}
      </Sparkles>
    );
  }
  const fill = getProviderColor(provider, isDarkTheme());
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon.viewBox}
      fill="currentColor"
      className={className}
      aria-label={resolvedTitle || undefined}
      aria-hidden={resolvedTitle ? undefined : true}
      role={resolvedTitle ? "img" : undefined}
      style={{ color: fill, display: "inline-block", verticalAlign: "middle" }}
    >
      {resolvedTitle && <title>{resolvedTitle}</title>}
      <path d={icon.path} fillRule={icon.fillRule} />
    </svg>
  );
}
