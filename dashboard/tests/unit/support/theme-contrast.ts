import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * WCAG contrast from the themes' own tokens: themes.css read as it is,
 * each colour resolved through its var() chain, a translucent
 * background composited over the one behind it. Used by the Prompts
 * tab's contrast test, which renders the tab and checks the colour pair
 * of every text node in both themes, and by the badge and decision pill
 * label tests, which check each label over its tint on every row
 * surface it sits on.
 */

export type Theme = "dark" | "light";
export const THEMES: readonly Theme[] = ["dark", "light"];

/** WCAG 2's minimum ratio for normal-size text (AA). */
export const AA_NORMAL_TEXT = 4.5;

/** The ratio the Prompts tab's text is held to: AA's 4.5:1 and 0.1 to
 *  spare, so that a browser's 8-bit compositing of a badge's tint, or a
 *  small edit to a token, cannot take a text under AA. themes.css's
 *  text-safe tokens are chosen to meet it on every surface they sit on. */
export const TEXT_SAFE_FLOOR = 4.6;

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const THEMES_CSS = resolve(__dirname, "../../../src/styles/themes.css");

/** Each theme's custom properties as written in themes.css. */
export function readThemeTokens(css = readFileSync(THEMES_CSS, "utf8")): Record<Theme, Map<string, string>> {
  const out = {} as Record<Theme, Map<string, string>>;
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const theme of THEMES) {
    const block = new RegExp(`\\.${theme}\\s*\\{([^}]*)\\}`).exec(bare);
    if (!block) throw new Error(`themes.css has no .${theme} block`);
    const tokens = new Map<string, string>();
    for (const m of block[1]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1]!, m[2]!.trim());
    out[theme] = tokens;
  }
  return out;
}

function hex(value: string): Rgba | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
}

/** A CSS colour as the themes write it, resolved in ``theme``: a hex, a
 *  var() of a token, rgb()/rgba(), ``transparent``, or color-mix(in
 *  srgb, X N%, transparent) (X at N% opacity). Anything else throws, so
 *  a colour the test cannot read fails it rather than passing it. */
export function resolveColor(tokens: Map<string, string>, value: string, depth = 0): Rgba {
  if (depth > 10) throw new Error(`var() chain too deep at ${value}`);
  const v = value.trim();
  const asHex = hex(v);
  if (asHex) return asHex;
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  // A var() with a fallback reads the token, which themes.css defines.
  const ref = /^var\((--[a-z0-9-]+)(?:\s*,\s*#[0-9a-f]{3,6})?\)$/i.exec(v);
  if (ref) {
    const next = tokens.get(ref[1]!);
    if (next === undefined) throw new Error(`no token ${ref[1]}`);
    return resolveColor(tokens, next, depth + 1);
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgb) return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]!, a: rgb[4] === undefined ? 1 : +rgb[4] };
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const c = resolveColor(tokens, mix[1]!, depth + 1);
    return { ...c, a: c.a * (+mix[2]! / 100) };
  }
  throw new Error(`cannot read the colour ${value}`);
}

/** ``top`` over the opaque ``under``. */
export function over(top: Rgba, under: Rgba): Rgba {
  return {
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG 2 contrast ratio of two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A text node's colour and the backgrounds behind it, as written in
 *  the markup: the nearest ``color`` (an inline style, or a Tailwind
 *  text colour class), and each inline ``background`` from the element
 *  out to the root, innermost first. */
export interface TextPaint {
  text: string;
  color: string;
  backgrounds: string[];
}

const TEXT_CLASS = /(?:^|\s)text-(?:\[(var\(--[a-z0-9-]+\))\]|text(-muted|-secondary|-disabled)?)(?=\s|$)/;

function styleValue(el: Element, prop: "color" | "background"): string | null {
  const style = el.getAttribute("style") ?? "";
  const re = prop === "color" ? /(?:^|;)\s*color\s*:\s*([^;]+)/ : /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/;
  return re.exec(style)?.[1]?.trim() ?? null;
}

function colorOf(el: Element): string | null {
  const inline = styleValue(el, "color");
  if (inline) return inline;
  const cls = TEXT_CLASS.exec(el.getAttribute("class") ?? "");
  if (!cls) return null;
  return cls[1] ?? `var(--text${cls[2] ?? ""})`;
}

/** Every element under ``root`` holding text of its own, with its paint.
 *  Text with no colour set anywhere up to ``root`` is the page's
 *  ``--text``. An SVG's text (a logo's ``<title>``, its accessible name)
 *  is not drawn as text, and is left out. */
export function textPaints(root: Element): TextPaint[] {
  const out: TextPaint[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.closest("svg")) continue;
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim())
      .map((n) => (n.textContent ?? "").trim())
      .join(" ");
    if (!own) continue;
    let color: string | null = null;
    const backgrounds: string[] = [];
    for (let e: Element | null = el; e; e = e === root ? null : e.parentElement) {
      color ??= colorOf(e);
      const bg = styleValue(e, "background");
      if (bg && bg !== "none") backgrounds.push(bg);
    }
    out.push({ text: own.slice(0, 60), color: color ?? "var(--text)", backgrounds });
  }
  return out;
}

/** A row an event-type badge or an MCP policy decision pill sits in:
 *  its background layers, bottom first. */
export interface BadgeRowSurface {
  name: string;
  layers: readonly string[];
}

const GLOW = "var(--accent-glow)";

/** Every row background a badge or a decision pill sits on: the four
 *  surfaces (--surface-hover is a hovered list row; --bg-elevated is a
 *  hovered policy-table row), a focused row's --accent-glow over the
 *  surfaces a focused row is drawn on, the Neighbors list's anchor (8%
 *  --accent over --bg), the Live feed's linked row (12% --accent over
 *  --bg) and the Events page's active facet (15% --primary over the
 *  page's --bg). themes.css's badge text tokens are chosen to read at
 *  TEXT_SAFE_FLOOR on each, under the label's tint. */
export const BADGE_ROW_SURFACES: readonly BadgeRowSurface[] = [
  { name: "--surface", layers: ["var(--surface)"] },
  { name: "--bg-elevated", layers: ["var(--bg-elevated)"] },
  { name: "--bg", layers: ["var(--bg)"] },
  { name: "a hovered row (--surface-hover)", layers: ["var(--surface-hover)"] },
  { name: "a focused row on --surface", layers: ["var(--surface)", GLOW] },
  { name: "a focused row on --bg-elevated", layers: ["var(--bg-elevated)", GLOW] },
  { name: "a focused row on --bg", layers: ["var(--bg)", GLOW] },
  { name: "the Neighbors anchor", layers: ["var(--bg)", "color-mix(in srgb, var(--accent) 8%, transparent)"] },
  { name: "a linked Live feed row", layers: ["var(--bg)", "color-mix(in srgb, var(--accent) 12%, transparent)"] },
  { name: "an active Events facet", layers: ["var(--bg)", "color-mix(in srgb, var(--primary) 15%, transparent)"] },
];

/** A label's contrast over its tint (``tint``, a color-mix of the hue)
 *  in ``row``: the lower of the exact composite and the 8-bit colour a
 *  browser draws. */
export function labelRatio(tokens: Map<string, string>, text: string, tint: string, row: BadgeRowSurface): number {
  let bg = resolveColor(tokens, row.layers[0]!);
  for (const layer of [...row.layers.slice(1), tint]) bg = over(resolveColor(tokens, layer), bg);
  const eightBit = { r: Math.round(bg.r), g: Math.round(bg.g), b: Math.round(bg.b), a: 1 };
  const fg = resolveColor(tokens, text);
  return Math.min(contrastRatio(fg, bg), contrastRatio(fg, eightBit));
}

/** A paint's contrast in ``theme``, its backgrounds composited over
 *  ``base`` (the surface the Prompts tab sits on). */
export function paintRatio(tokens: Map<string, string>, paint: TextPaint, base = "var(--surface)"): number {
  let bg = resolveColor(tokens, base);
  for (const layer of [...paint.backgrounds].reverse()) {
    const c = resolveColor(tokens, layer);
    bg = c.a >= 1 ? c : over(c, bg);
  }
  const fg = resolveColor(tokens, paint.color);
  return contrastRatio(over(fg, bg), bg);
}
