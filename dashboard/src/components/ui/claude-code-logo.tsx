import {
  CLAUDE_CODE_ICON,
  isDarkTheme,
} from "./provider-icons";

export const CLAUDE_CODE_TOOLTIP = "Coding agent (Claude Code)";

interface ClaudeCodeLogoProps {
  size?: number;
  className?: string;
  /** Overrides the default tooltip / aria-label. Use when the icon
   *  sits next to text that already identifies the tool (e.g. the
   *  drawer badge has a visible "Claude Code" label alongside) -- pass
   *  an empty string to suppress duplicate labelling of the same
   *  content twice in the accessibility tree. */
  title?: string;
}

/** HTML-context Claude Code badge. Mirrors the API of ``ProviderLogo``
 *  but reads the Claude Code mark from ``CLAUDE_CODE_ICON`` rather
 *  than the provider map -- Claude Code is an Anthropic-made agent,
 *  not a billing provider, so it lives outside the ``Provider`` enum.
 *  Both components below share the single source of truth on the icon
 *  path, colors, and fill-rule, so the visual stays in sync.
 *
 *  Accessibility: the ``<svg>`` carries the canonical tooltip via an
 *  inline ``<title>`` child (hover pop) AND role="img" + aria-label
 *  (screen readers). Passing ``title=""`` opts out -- useful when the
 *  icon is co-located with visible label text so screen readers do not
 *  read the tool name twice. */
export function ClaudeCodeLogo({
  size = 14,
  className,
  title = CLAUDE_CODE_TOOLTIP,
}: ClaudeCodeLogoProps) {
  const dark = isDarkTheme();
  const fill =
    typeof CLAUDE_CODE_ICON.color === "string"
      ? CLAUDE_CODE_ICON.color
      : dark
        ? CLAUDE_CODE_ICON.color.dark
        : CLAUDE_CODE_ICON.color.light;
  return (
    <svg
      width={size}
      height={size}
      viewBox={CLAUDE_CODE_ICON.viewBox}
      fill="currentColor"
      className={className}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={{ color: fill, display: "inline-block", verticalAlign: "middle" }}
    >
      {title && <title>{title}</title>}
      <path d={CLAUDE_CODE_ICON.path} fillRule={CLAUDE_CODE_ICON.fillRule} />
    </svg>
  );
}

interface ClaudeCodeIconSvgProps {
  x: number;
  y: number;
  size: number;
  isDark?: boolean;
  opacity?: number;
  title?: string;
}

/** SVG-context sibling for recharts ticks / other nested-SVG surfaces.
 *  Anchored at ``(x, y)`` inside the parent SVG, sized ``size`` px.
 *  Carries the same ``<title>`` tooltip as the HTML variant. */
export function ClaudeCodeIconSvg({
  x,
  y,
  size,
  isDark,
  opacity,
  title = CLAUDE_CODE_TOOLTIP,
}: ClaudeCodeIconSvgProps) {
  const resolvedDark =
    isDark ??
    (typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"));
  const fill =
    typeof CLAUDE_CODE_ICON.color === "string"
      ? CLAUDE_CODE_ICON.color
      : resolvedDark
        ? CLAUDE_CODE_ICON.color.dark
        : CLAUDE_CODE_ICON.color.light;
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox={CLAUDE_CODE_ICON.viewBox}
      opacity={opacity}
      aria-label={title || undefined}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      <path d={CLAUDE_CODE_ICON.path} fill={fill} fillRule={CLAUDE_CODE_ICON.fillRule} />
    </svg>
  );
}
