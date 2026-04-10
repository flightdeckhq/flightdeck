/**
 * OSIcon — small inline-SVG operating system glyph used in the
 * session drawer metadata bar and the session-event row left panel.
 *
 * Renders one of three simple geometric shapes (Apple silhouette for
 * Darwin, terminal-prompt circle for Linux, 2x2 grid for Windows)
 * with a fixed brand-adjacent color baked into inline style. Returns
 * `null` for unknown / missing values so callers can render
 * unconditionally without extra null checks.
 *
 * Why inline SVG and not lucide / an external library: at 12px these
 * need to be ultra-simple geometric forms with no per-icon margin
 * weirdness, and we already established the inline-SVG-with-fixed-
 * color pattern in ProviderLogo.tsx -- see that file for the same
 * approach with Anthropic / OpenAI logos.
 */

interface OSIconProps {
  os?: string | null;
  size?: number;
  className?: string;
}

const OS_COLORS: Record<string, string> = {
  Darwin: "#909090",
  Linux: "#E8914A",
  Windows: "#0078D4",
};

export function OSIcon({ os, size = 14, className }: OSIconProps) {
  if (!os) return null;
  const color = OS_COLORS[os];
  if (!color) return null;

  const common = {
    width: size,
    height: size,
    className,
    style: {
      color,
      display: "inline-block",
      verticalAlign: "middle",
      flexShrink: 0,
    } as const,
    "data-testid": `os-icon-${os.toLowerCase()}`,
  };

  if (os === "Darwin") {
    // Simplified apple silhouette + leaf. Geometric, not the
    // copyrighted Apple logo, but recognisable at 12-14px.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <path d="M10.5 7.2c0-1.6 1.1-2.4 1.2-2.5-0.6-0.9-1.6-1-2-1-0.8-0.1-1.6 0.5-2 0.5-0.4 0-1.1-0.5-1.8-0.5-0.9 0-1.8 0.5-2.3 1.4-1 1.7-0.3 4.2 0.7 5.6 0.5 0.7 1 1.4 1.7 1.4 0.7 0 1-0.4 1.8-0.4 0.8 0 1.1 0.4 1.8 0.4 0.7 0 1.2-0.7 1.7-1.4 0.5-0.8 0.7-1.6 0.7-1.6-0.1 0-1.5-0.6-1.5-1.9zM9.4 2.6c0.4-0.5 0.6-1.1 0.6-1.8-0.5 0-1.1 0.4-1.5 0.8-0.3 0.4-0.7 1-0.6 1.7 0.6 0.1 1.1-0.3 1.5-0.7z" />
      </svg>
    );
  }

  if (os === "Linux") {
    // Terminal-prompt-in-a-circle. Recognisable at small sizes,
    // brand-adjacent without using the copyrighted Tux mascot.
    return (
      <svg
        {...common}
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        <circle cx="7" cy="7" r="6" />
        <text
          x="3"
          y="9.5"
          fontSize="6"
          fontFamily="monospace"
          fill="currentColor"
          stroke="none"
        >
          {">_"}
        </text>
      </svg>
    );
  }

  // Windows: 2x2 grid of rounded squares.
  return (
    <svg {...common} viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="1" width="5.5" height="5.5" rx="0.5" />
      <rect x="7.5" y="1" width="5.5" height="5.5" rx="0.5" />
      <rect x="1" y="7.5" width="5.5" height="5.5" rx="0.5" />
      <rect x="7.5" y="7.5" width="5.5" height="5.5" rx="0.5" />
    </svg>
  );
}
