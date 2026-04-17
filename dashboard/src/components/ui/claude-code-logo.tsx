import {
  CLAUDE_CODE_ICON,
  isDarkTheme,
} from "./provider-icons";

interface ClaudeCodeLogoProps {
  size?: number;
  className?: string;
}

/** HTML-context Claude Code badge. Mirrors the API of ``ProviderLogo``
 *  but reads the Claude Code mark from ``CLAUDE_CODE_ICON`` rather
 *  than the provider map -- Claude Code is an Anthropic-made agent,
 *  not a billing provider, so it lives outside the ``Provider`` enum.
 *  Both components below share the single source of truth on the icon
 *  path, colors, and fill-rule, so the visual stays in sync. */
export function ClaudeCodeLogo({ size = 14, className }: ClaudeCodeLogoProps) {
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
      aria-label="Claude Code"
      role="img"
      style={{ color: fill, display: "inline-block", verticalAlign: "middle" }}
    >
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
}

/** SVG-context sibling for recharts ticks / other nested-SVG surfaces.
 *  Anchored at ``(x, y)`` inside the parent SVG, sized ``size`` px. */
export function ClaudeCodeIconSvg({
  x,
  y,
  size,
  isDark,
  opacity,
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
    <svg x={x} y={y} width={size} height={size} viewBox={CLAUDE_CODE_ICON.viewBox} opacity={opacity}>
      <path d={CLAUDE_CODE_ICON.path} fill={fill} fillRule={CLAUDE_CODE_ICON.fillRule} />
    </svg>
  );
}
