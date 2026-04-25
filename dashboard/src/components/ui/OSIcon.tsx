/**
 * OSIcon — small inline-SVG operating system glyph used in the
 * session drawer metadata bar and the session-event row left panel.
 *
 * Darwin and Linux use the official brand paths from the
 * `simple-icons` package so the rendering is pixel-perfect at any
 * size. Windows is NOT in simple-icons (the Microsoft logo was
 * removed for trademark reasons), so it falls back to a hand-crafted
 * 4-square grid that matches the actual Windows-logo geometry.
 *
 * Color for Darwin overrides siApple.hex (which is #000000 black and
 * invisible on dark backgrounds) with a neutral grey.
 */

import { siApple, siLinux } from "simple-icons";

interface OSIconProps {
  os?: string | null;
  size?: number;
  className?: string;
}

// Darwin: brand-neutral grey chosen because siApple.hex is pure
// black (#000000) and would be invisible on the dark theme. The
// siApple.hex value is invisible on light theme too at 14px, so
// brand-neutral grey reads on BOTH themes -- moving this to a
// CSS var would require splitting it per theme and gain nothing
// since the goal is theme-independence. Linux/Windows use brand
// colors that read correctly against either background. Phase 4.5
// N-6: documented theme-neutral choice rather than CSS-var
// migration (Rule 15 themes.css gate not exercised here).
const OS_COLORS: Record<string, string> = {
  Darwin: "#909090",
  Linux: "#E8914A",
  Windows: "#0078D4",
};

// ------------------------------------------------------------------
// Shared simple-icons <svg> wrapper.
// ------------------------------------------------------------------

interface SimpleIconSvgProps {
  path: string;
  size: number;
  color: string;
  title: string;
  className?: string;
  testId?: string;
}

/**
 * Render a simple-icons path at the standard 24x24 viewBox used by
 * the package. Every brand icon in `simple-icons` ships with a path
 * authored against this viewBox, so callers just pass `icon.path`.
 */
export function SimpleIconSvg({
  path,
  size,
  color,
  title,
  className,
  testId,
}: SimpleIconSvgProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      className={className}
      style={{
        color,
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
      role="img"
      aria-label={title}
      data-testid={testId}
    >
      <title>{title}</title>
      <path d={path} />
    </svg>
  );
}

export function OSIcon({ os, size = 14, className }: OSIconProps) {
  if (!os) return null;
  const color = OS_COLORS[os];
  if (!color) return null;

  if (os === "Darwin") {
    return (
      <SimpleIconSvg
        path={siApple.path}
        size={size}
        color={color}
        title={siApple.title}
        className={className}
        testId="os-icon-darwin"
      />
    );
  }

  if (os === "Linux") {
    return (
      <SimpleIconSvg
        path={siLinux.path}
        size={size}
        color={color}
        title={siLinux.title}
        className={className}
        testId="os-icon-linux"
      />
    );
  }

  // Windows: not in simple-icons (removed for trademark reasons).
  // Four-square grid matches the actual Windows logo geometry.
  // viewBox stays 14x14 for this fallback since the path data is
  // authored to that coordinate space.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill={color}
      className={className}
      style={{
        color,
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
      role="img"
      aria-label="Windows"
      data-testid="os-icon-windows"
    >
      <title>Windows</title>
      <rect x="1" y="1" width="5.5" height="5.5" />
      <rect x="7.5" y="1" width="5.5" height="5.5" />
      <rect x="1" y="7.5" width="5.5" height="5.5" />
      <rect x="7.5" y="7.5" width="5.5" height="5.5" />
    </svg>
  );
}
