import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every CSS custom property the dashboard's source reads is defined. A
 * var() of a name nothing defines is invalid at computed-value time, so the
 * property falls back to its initial value: a background reads as
 * transparent, and nothing in the build or the type check says so.
 *
 * The scan reads src/ (.ts, .tsx, .css) with comments removed, and takes
 * both ways the source reads a property: `var(--name)` and Tailwind's
 * shorthand `bg-(--name)` (any utility, with or without a type hint such
 * as `bg-(color:--name)`). A name counts as defined when themes.css or
 * globals.css declares it.
 */

const DASHBOARD = resolve(__dirname, "../..");
const STYLESHEETS = ["src/styles/themes.css", "src/styles/globals.css"];

/** Names the code sets itself and reads back, with where and why. */
const SET_BY_CODE: Readonly<Record<string, string>> = {
  "--runs-chip-border":
    "SwimLane sets it in the runs chip's inline style (the colour follows the chip's state) and the chip's border-(--runs-chip-border) class reads it",
};

/** Names defined outside the two stylesheets. */
const DEFINED_ELSEWHERE: Readonly<Record<string, string>> = {
  "--color-gray-200":
    "Tailwind's default theme palette; globals.css reads it, with a currentcolor fallback, in the border-colour base style Tailwind gives for v3 compatibility",
};

/** References to names nothing defines that wait on a design choice, with
 *  the files they are known in. The same name in another file fails, and
 *  so does an entry no file needs any more. */
const KNOWN_UNDEFINED: Readonly<Record<string, { files: readonly string[]; reason: string }>> = {
  "--background": {
    files: ["src/components/ui/switch.tsx", "src/components/ui/tabs.tsx"],
    reason:
      "shadcn's name for the page background, used for the active tab's background and the focus ring's offset colour; the themes have --bg (the page) and --surface (panels), and which one these take is a design choice",
  },
  "--info": {
    files: ["src/components/policy/MCPPolicyEntryTable.tsx"],
    reason:
      "the Deny · interactive pill's colour, drawn through its #7c3aed fallback; the themes have no info token, so this needs a new token or a choice of an existing one",
  },
};

const REFERENCE = /var\(\s*(--[A-Za-z0-9_-]+)|-\((?:[a-z-]+:)?(--[A-Za-z0-9_-]+)\)/g;
const DECLARATION = /(--[A-Za-z0-9_-]+)\s*:/g;

/** ``text`` without its comments, line breaks kept so line numbers hold.
 *  A `//` after a colon or a quote (a URL in a string) is not a comment. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(e.name) ? [path] : [];
  });
}

interface Reference {
  name: string;
  file: string;
  line: number;
}

function references(): Reference[] {
  const out: Reference[] = [];
  for (const path of sourceFiles(join(DASHBOARD, "src"))) {
    const file = relative(DASHBOARD, path).split("\\").join("/");
    withoutComments(readFileSync(path, "utf8"))
      .split("\n")
      .forEach((text, i) => {
        for (const m of text.matchAll(REFERENCE)) out.push({ name: (m[1] ?? m[2])!, file, line: i + 1 });
      });
  }
  return out;
}

function definedInStylesheets(): Set<string> {
  const names = new Set<string>();
  for (const sheet of STYLESHEETS) {
    const css = withoutComments(readFileSync(join(DASHBOARD, sheet), "utf8"));
    for (const m of css.matchAll(DECLARATION)) names.add(m[1]!);
  }
  return names;
}

const REFS = references();
const DEFINED = definedInStylesheets();

function allowed(ref: Reference): boolean {
  if (DEFINED.has(ref.name) || ref.name in SET_BY_CODE || ref.name in DEFINED_ELSEWHERE) return true;
  return KNOWN_UNDEFINED[ref.name]?.files.includes(ref.file) ?? false;
}

describe("the CSS custom properties the dashboard reads", () => {
  it("reads both forms across src/, so a broken scan cannot pass for a clean one", () => {
    expect(DEFINED.has("--bg-elevated")).toBe(true);
    expect(REFS.length).toBeGreaterThan(500);
    const at = (file: string) => REFS.filter((r) => r.file === file).map((r) => r.name);
    // A var() in an inline style, and a Tailwind shorthand class.
    expect(at("src/components/policy/MCPPolicyAuditPanel.tsx")).toEqual(expect.arrayContaining(["--border", "--accent"]));
    expect(at("src/components/ui/tabs.tsx")).toContain("--text-muted");
  });

  it("are each defined in themes.css or globals.css, or set by the code itself", () => {
    const undefinedRefs = REFS.filter((r) => !allowed(r)).map((r) => `${r.name} at ${r.file}:${r.line}`);
    expect(undefinedRefs, `undefined custom properties:\n${undefinedRefs.join("\n")}`).toEqual([]);
  });

  it("allow-list entries are still read, and still not defined in the stylesheets", () => {
    for (const name of [...Object.keys(SET_BY_CODE), ...Object.keys(DEFINED_ELSEWHERE), ...Object.keys(KNOWN_UNDEFINED)]) {
      expect(REFS.some((r) => r.name === name), `${name} is no longer read`).toBe(true);
      expect(DEFINED.has(name), `${name} is now defined in a stylesheet`).toBe(false);
    }
    for (const [name, { files }] of Object.entries(KNOWN_UNDEFINED)) {
      for (const file of files) {
        expect(REFS.some((r) => r.name === name && r.file === file), `${name} is no longer read in ${file}`).toBe(true);
      }
    }
    // The code still sets each name it is allowed to set.
    const setters = sourceFiles(join(DASHBOARD, "src")).map((p) => readFileSync(p, "utf8")).join("\n");
    for (const name of Object.keys(SET_BY_CODE)) expect(setters).toContain(`"${name}":`);
  });
});
