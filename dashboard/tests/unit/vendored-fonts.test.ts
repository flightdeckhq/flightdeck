import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// globals.css loads the Geist variable fonts from the vendored copy
// under src/assets/fonts/geist. A wrong url() would only show as a
// silent fallback font, so pin that every referenced file exists.
const stylesDir = path.resolve(import.meta.dirname, "../../src/styles");

describe("vendored Geist fonts", () => {
  const css = readFileSync(path.join(stylesDir, "globals.css"), "utf8");
  const urls = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]!);

  it("globals.css references both Geist variable fonts from the vendored folder", () => {
    expect(urls).toEqual([
      "../assets/fonts/geist/Geist-Variable.woff2",
      "../assets/fonts/geist/GeistMono-Variable.woff2",
    ]);
  });

  it("every referenced font file exists, alongside the license", () => {
    for (const url of urls) {
      expect(existsSync(path.resolve(stylesDir, url)), url).toBe(true);
    }
    expect(existsSync(path.resolve(stylesDir, "../assets/fonts/geist/LICENSE.txt"))).toBe(true);
  });
});
