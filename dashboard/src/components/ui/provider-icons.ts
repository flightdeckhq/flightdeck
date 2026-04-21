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

/** Claude Code visual identity. A rounded-square terminal frame with
 *  a ``>`` chevron prompt and an underscore cursor inside -- reads
 *  literally as "terminal / CLI" which is Claude Code's primary
 *  interface. Swap-in for the earlier abstract chevron-in-square
 *  glyph, which Supervisor feedback flagged as cryptic at 12-14px.
 *
 *  The path stacks four subpaths rendered with ``fill-rule=evenodd``:
 *    1. Outer rounded square (the outer edge of the frame)
 *    2. Inner rounded square (punches the hole that turns the outer
 *       into a 1.5px ring)
 *    3. Solid ``>`` chevron positioned upper-centre
 *    4. Solid ``_`` underscore positioned bottom-right of the chevron
 *  Because the chevron and underscore lie INSIDE the inner rectangle,
 *  they're enclosed by three subpaths (outer + inner + themselves)
 *  so even-odd winding counts them as fill; the "empty" terminal
 *  interior between glyphs has two crossings and stays hollow.
 *
 *  Color is the same Anthropic warm tone as the ``anthropic`` entry
 *  above -- Claude Code *is* Anthropic's terminal agent, so the brand
 *  family reads consistently while the glyph signals the tool. */
export const CLAUDE_CODE_ICON: ProviderIcon = {
  viewBox: "0 0 24 24",
  fillRule: "evenodd",
  path:
    // Outer rounded square (clockwise)
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z " +
    // Inner rounded square (cuts the frame hole)
    "M6 4.5A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 18 4.5H6z " +
    // ``>`` chevron, centred near (8.5, 12)
    "M6.75 9.1L10.5 12L6.75 14.9L5.95 13.85L8.6 12L5.95 10.15z " +
    // ``_`` underscore, sitting to the right of the chevron
    "M11.5 14.25H17V15.5H11.5z",
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
