import { Sparkles } from "lucide-react";
import type { Provider } from "@/lib/models";
import {
  PROVIDER_ICONS,
  getProviderColor,
  isDarkTheme,
} from "./provider-icons";

interface ProviderLogoProps {
  provider: Provider;
  size?: number;
  className?: string;
}

/** HTML-context wrapper around the shared ``PROVIDER_ICONS`` map.
 *  Renders a full ``<svg>`` element sized at ``size`` × ``size`` with
 *  the provider's brand path filled in the resolved theme color.
 *  Providers without a bespoke mark fall back to the lucide
 *  ``Sparkles`` icon so the visual slot stays filled. For use inside
 *  an existing SVG (recharts Y-axis tick) use ``ProviderIconSvg``
 *  instead -- nesting two ``<svg>`` elements via this component works,
 *  but the sibling is designed for that positioning. */
export function ProviderLogo({ provider, size = 14, className }: ProviderLogoProps) {
  const icon = PROVIDER_ICONS[provider];
  if (!icon) {
    return (
      <Sparkles
        size={size}
        className={className}
        style={{
          color: "var(--text-muted)",
          display: "inline-block",
          verticalAlign: "middle",
        }}
      />
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
      style={{ color: fill, display: "inline-block", verticalAlign: "middle" }}
    >
      <path d={icon.path} fillRule={icon.fillRule} />
    </svg>
  );
}
