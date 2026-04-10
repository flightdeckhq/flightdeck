/**
 * OSIcon — small inline-SVG operating system glyph used in the
 * session drawer metadata bar and the session-event row left panel.
 *
 * Renders one of three simple geometric shapes (apple silhouette for
 * Darwin, penguin silhouette for Linux, 2x2 grid for Windows) with a
 * fixed brand-adjacent color baked into inline style. Returns `null`
 * for unknown / missing values so callers can render unconditionally
 * without extra null checks.
 *
 * Why inline SVG and not lucide / an external library: at 12px these
 * need to be ultra-simple geometric forms with no per-icon margin
 * weirdness, and we already established the inline-SVG-with-fixed-
 * color pattern in ProviderLogo.tsx.
 */

interface OSIconProps {
  os?: string | null;
  size?: number;
  className?: string;
}

const OS_COLORS: Record<string, string> = {
  Darwin: "#8B8B8B",
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
    // Apple silhouette + leaf notch. Geometric, not the copyrighted
    // Apple logo, but recognisable at 12-14px.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <path d="M9.5 2C9.5 2 9 1 7.5 1 C6 1 5.2 2 5.2 2 C3.5 2 2 3.8 2 6 C2 9 4 12 5.5 12 C6.2 12 6.5 11.5 7.5 11.5 C8.5 11.5 8.8 12 9.5 12 C11 12 13 9 13 6 C13 3.8 11.5 2 9.5 2Z M7.5 0.5 C8 0 9 0.3 8.8 1.2 C8.3 1.5 7.3 1.2 7.5 0.5Z" />
      </svg>
    );
  }

  if (os === "Linux") {
    // Penguin silhouette. The eye ellipses and the body-interior
    // ellipse use var(--bg) so the "white" cutouts blend with
    // whichever row background the icon is painted on, remaining
    // legible in both themes. #1a1a1a is the dark-theme fallback.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <ellipse cx="7" cy="5" rx="3.5" ry="4" />
        <ellipse
          cx="7"
          cy="5"
          rx="2"
          ry="2.5"
          fill="var(--bg, #1a1a1a)"
        />
        <ellipse cx="7" cy="10" rx="4" ry="2.5" />
        <ellipse
          cx="5.5"
          cy="4.2"
          rx="0.7"
          ry="0.7"
          fill="var(--bg, #1a1a1a)"
        />
        <ellipse
          cx="8.5"
          cy="4.2"
          rx="0.7"
          ry="0.7"
          fill="var(--bg, #1a1a1a)"
        />
      </svg>
    );
  }

  // Windows: 2x2 grid of plain squares (no rounding).
  return (
    <svg {...common} viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="1" width="5.5" height="5.5" />
      <rect x="7.5" y="1" width="5.5" height="5.5" />
      <rect x="1" y="7.5" width="5.5" height="5.5" />
      <rect x="7.5" y="7.5" width="5.5" height="5.5" />
    </svg>
  );
}
