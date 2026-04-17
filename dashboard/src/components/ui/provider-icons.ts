import type { Provider } from "@/lib/models";

/** Raw provider brand-mark data, shared by every surface that renders
 *  a provider icon. ``ProviderLogo`` (HTML context, summary cards /
 *  chart legends) and ``ProviderIconSvg`` (SVG context, recharts
 *  Y-axis ticks) both read from this map -- there is no other source
 *  of truth for the path strings.
 *
 *  ``color`` is a single string when the mark is theme-invariant
 *  (e.g. OpenAI's flat green reads well in both themes) and a
 *  ``{ light, dark }`` pair when the brand uses different tones per
 *  theme (Anthropic's orange has a darker tone on light backgrounds
 *  for contrast). Use ``getProviderColor`` to resolve the active
 *  value -- do not inline the lookup.
 *
 *  Providers with no bespoke mark -- google, xai, mistral, meta,
 *  other, unknown -- are mapped to ``null``. HTML consumers render a
 *  lucide ``Sparkles`` fallback; SVG consumers render a muted circle.
 *  This keeps the module free of non-canonical brand art we have not
 *  vetted. */
export interface ProviderIcon {
  viewBox: string;
  path: string;
  color: string | { light: string; dark: string };
  /** Optional fill-rule override. Icons whose ``path`` encodes a
   *  negative-space cutout (e.g. the Claude Code terminal outline with
   *  a chevron inside) need ``evenodd`` so SVG XORs the subpaths.
   *  Default (omitted) is nonzero, which is what every provider brand
   *  mark below relies on. */
  fillRule?: "evenodd" | "nonzero";
}

/** Claude Code visual identity. Rounded-square terminal outline with
 *  a "``>``" chevron inside -- visually distinct from the Anthropic
 *  star glyph so a fleet operator can tell at a glance which sessions
 *  came from the Claude Code plugin versus direct Anthropic SDK use.
 *
 *  The path stacks two subpaths:
 *    1. A rounded-square ring (outer clockwise, inner counter-clockwise)
 *    2. A filled chevron pointing right
 *  Rendered with ``fill-rule=evenodd`` so the inner subpath punches
 *  a hole in the outer and the chevron stays solid.
 *
 *  Color is the same Anthropic warm tone as the ``anthropic`` entry
 *  above -- Claude Code *is* Anthropic's terminal agent, so the brand
 *  family reads consistently while the glyph signals the tool. */
export const CLAUDE_CODE_ICON: ProviderIcon = {
  viewBox: "0 0 24 24",
  fillRule: "evenodd",
  path:
    // Outer rounded square (clockwise)
    "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z " +
    // Inner rounded square (counter-clockwise -> cuts a 1.5px border)
    "M6 4.5A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 18 4.5H6z " +
    // Chevron "Claude-Code-typed-this" prompt glyph
    "M10.22 8.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 1 1-1.06-1.06L12.94 12l-2.72-2.72a.75.75 0 0 1 0-1.06z",
  color: { light: "#D4763B", dark: "#E8915A" },
};

export const PROVIDER_ICONS: Record<Provider, ProviderIcon | null> = {
  anthropic: {
    viewBox: "0 0 24 24",
    path: "M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L17 20.48h-3.767L6.569 3.52z",
    color: { light: "#D4763B", dark: "#E8915A" },
  },
  openai: {
    viewBox: "0 0 24 24",
    path: "M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.032.067L9.845 19.95a4.5 4.5 0 0 1-6.245-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.843-3.369 2.02-1.168a.076.076 0 0 1 .071 0l4.83 2.78a4.5 4.5 0 0 1-.676 8.123v-5.68a.79.79 0 0 0-.407-.686zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.496 4.496 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z",
    color: "#10a37f",
  },
  google: null,
  xai: null,
  mistral: null,
  meta: null,
  other: null,
  unknown: null,
};

/** Resolve the brand color for a provider given the active theme.
 *  Returns ``var(--text-muted)`` when the provider has no icon so
 *  callers can reuse the same lookup for fallback circle fills. */
export function getProviderColor(provider: Provider, isDark: boolean): string {
  const icon = PROVIDER_ICONS[provider];
  if (!icon) return "var(--text-muted)";
  if (typeof icon.color === "string") return icon.color;
  return isDark ? icon.color.dark : icon.color.light;
}

/** Small helper for components that do not already know the active
 *  theme. Matches the sniff that lived inline in ``provider-logo.tsx``
 *  before the refactor so colors stay identical across themes. */
export function isDarkTheme(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}
