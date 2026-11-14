/**
 * Reading values the Claude Code plugin cut to a bound.
 *
 * The plugin marks a cut: a string it cut ends with ``…``, a list whose
 * trailing elements it dropped ends with a ``"…"`` element, and the
 * object holding a cut value names it in ``truncated`` (a tool input's
 * ``command`` cut at 200 characters, a tool output's ``stdout`` cut to
 * fit 2000). Tool outputs stored by earlier plugin versions are instead
 * the response's JSON text cut mid-way and followed by ``…``:
 * ``readCutJson`` reads such a text up to the cut.
 */

/** What ends a value the plugin cut. */
export const CUT_MARK = "…";

/** The key under which an object lists the fields of its own that were cut. */
export const CUT_LIST_KEY = "truncated";

/** The fields ``data`` lists as cut, or null when it lists none. A
 *  ``truncated`` that is not a list of names (Glob's own flag) is a
 *  field like any other. */
export function cutFields(data: Record<string, unknown>): string[] | null {
  const list = data[CUT_LIST_KEY];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.every((name) => typeof name === "string") ? (list as string[]) : null;
}

/** How much of a cut value was kept: the characters of a string before
 *  the mark, or the elements of a list before its mark element. */
export interface CutExtent {
  unit: "characters" | "entries";
  kept: number;
}

export function cutExtent(value: unknown): CutExtent | null {
  if (typeof value === "string" && value.endsWith(CUT_MARK)) {
    return { unit: "characters", kept: Array.from(value).length - 1 };
  }
  if (Array.isArray(value) && value.length > 0 && value[value.length - 1] === CUT_MARK) {
    return { unit: "entries", kept: value.length - 1 };
  }
  return null;
}

/** "cut at 200 characters", "cut after 26 entries", or "cut". */
export function describeCut(value: unknown): string {
  const extent = cutExtent(value);
  if (!extent) return "cut";
  const n = extent.kept.toLocaleString("en-US");
  return extent.unit === "characters"
    ? `cut at ${n} character${extent.kept === 1 ? "" : "s"}`
    : `cut after ${n} entr${extent.kept === 1 ? "y" : "ies"}`;
}

/* ---- The tolerant reader ---- */

/** A path from the root to a value: object keys and list indices. */
export type JsonPath = Array<string | number>;

export interface CutJsonRead {
  /** The object or list, with every key/value pair and element read in
   *  whole, and the string that was being read when the text ended. */
  value: Record<string, unknown> | unknown[];
  /** Whether the text held the whole value (it ended where the value
   *  did). */
  complete: boolean;
  /** Where the text ended: the path of the value that was being read,
   *  empty when it ended between values of the root. */
  cutPath: JsonPath;
  /** Whether the value at ``cutPath`` is a string cut part-way (kept in
   *  ``value``) rather than a key, number or literal (left out). */
  cutInString: boolean;
}

/** Texts longer than this are not read: the plugin's events are at most
 *  768 KiB, so a longer text is not one of its tool outputs. */
export const CUT_JSON_MAX_CHARS = 1_048_576;

/** Containers nested deeper than this are not read. */
export const CUT_JSON_MAX_DEPTH = 64;

class NotJson extends Error {}

type Slot =
  | { state: "done"; value: unknown }
  | { state: "partial"; value: unknown; path: JsonPath; inString: boolean }
  | { state: "none"; path: JsonPath };

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const HEX4 = /^[0-9a-fA-F]{0,4}$/;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function setField(obj: Record<string, unknown>, key: string, value: unknown): void {
  // A defined property, so a "__proto__" key stays a field.
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A text the reader cut through the middle of a character pair ends
 *  with half of it: drop it. */
function withoutLoneHighSurrogate(s: string): string {
  if (s.length === 0) return s;
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

class Reader {
  pos = 0;
  constructor(private readonly text: string) {}

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  private skipSpace(): void {
    while (!this.atEnd()) {
      const c = this.text.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.pos += 1;
    }
  }

  value(depth: number): Slot {
    if (depth > CUT_JSON_MAX_DEPTH) throw new NotJson();
    this.skipSpace();
    if (this.atEnd()) return { state: "none", path: [] };
    const c = this.text.charAt(this.pos);
    if (c === "{") return this.object(depth);
    if (c === "[") return this.list(depth);
    if (c === '"') {
      const s = this.string();
      return s.complete ? { state: "done", value: s.value } : { state: "partial", value: s.value, path: [], inString: true };
    }
    if (c === "t" || c === "f" || c === "n") return this.literal();
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    throw new NotJson();
  }

  private literal(): Slot {
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      const rest = this.text.slice(this.pos, this.pos + word.length);
      if (rest === word) {
        this.pos += word.length;
        return { state: "done", value };
      }
      if (this.pos + rest.length === this.text.length && word.startsWith(rest)) {
        this.pos = this.text.length;
        return { state: "none", path: [] };
      }
    }
    throw new NotJson();
  }

  private number(): Slot {
    const start = this.pos;
    while (!this.atEnd() && /[-+.eE0-9]/.test(this.text.charAt(this.pos))) this.pos += 1;
    // A number the text ends on may have lost digits: it is not kept.
    if (this.atEnd()) return { state: "none", path: [] };
    const token = this.text.slice(start, this.pos);
    if (!NUMBER.test(token)) throw new NotJson();
    return { state: "done", value: Number(token) };
  }

  /** A string from its opening quote: its value, and whether its closing
   *  quote was read. */
  string(): { value: string; complete: boolean } {
    this.pos += 1;
    let out = "";
    let runStart = this.pos;
    while (!this.atEnd()) {
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x22) {
        out += this.text.slice(runStart, this.pos);
        this.pos += 1;
        return { value: out, complete: true };
      }
      if (code < 0x20) throw new NotJson();
      if (code !== 0x5c) {
        this.pos += 1;
        continue;
      }
      out += this.text.slice(runStart, this.pos);
      const escape = this.text[this.pos + 1];
      if (escape === undefined) {
        // The text ends on the backslash.
        this.pos = this.text.length;
        return { value: withoutLoneHighSurrogate(out), complete: false };
      }
      if (escape === "u") {
        const hex = this.text.slice(this.pos + 2, this.pos + 6);
        if (!HEX4.test(hex)) throw new NotJson();
        if (hex.length < 4) {
          // The text ends inside the \u escape.
          this.pos = this.text.length;
          return { value: withoutLoneHighSurrogate(out), complete: false };
        }
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
      } else {
        const ch = SIMPLE_ESCAPES[escape];
        if (ch === undefined) throw new NotJson();
        out += ch;
        this.pos += 2;
      }
      runStart = this.pos;
    }
    out += this.text.slice(runStart, this.pos);
    return { value: withoutLoneHighSurrogate(out), complete: false };
  }

  private object(depth: number): Slot {
    this.pos += 1;
    const obj: Record<string, unknown> = {};
    const partial = (path: JsonPath = [], inString = false): Slot => ({ state: "partial", value: obj, path, inString });
    this.skipSpace();
    if (this.atEnd()) return partial();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return { state: "done", value: obj };
    }
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) return partial();
      if (this.text[this.pos] !== '"') throw new NotJson();
      const key = this.string();
      // A key the text ends in has no value: nothing of it is kept.
      if (!key.complete) return partial();
      this.skipSpace();
      if (this.atEnd()) return partial([key.value]);
      if (this.text[this.pos] !== ":") throw new NotJson();
      this.pos += 1;
      const slot = this.value(depth + 1);
      if (slot.state === "none") return partial([key.value, ...slot.path]);
      setField(obj, key.value, slot.value);
      if (slot.state === "partial") return partial([key.value, ...slot.path], slot.inString);
      this.skipSpace();
      if (this.atEnd()) return partial();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === "}") return { state: "done", value: obj };
      if (next !== ",") throw new NotJson();
    }
  }

  private list(depth: number): Slot {
    this.pos += 1;
    const items: unknown[] = [];
    const partial = (path: JsonPath = [], inString = false): Slot => ({ state: "partial", value: items, path, inString });
    this.skipSpace();
    if (this.atEnd()) return partial();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return { state: "done", value: items };
    }
    for (;;) {
      const index = items.length;
      const slot = this.value(depth + 1);
      if (slot.state === "none") return partial([index, ...slot.path]);
      items.push(slot.value);
      if (slot.state === "partial") return partial([index, ...slot.path], slot.inString);
      this.skipSpace();
      if (this.atEnd()) return partial();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === "]") return { state: "done", value: items };
      if (next !== ",") throw new NotJson();
    }
  }

  /** Whether only whitespace is left. */
  restIsSpace(): boolean {
    this.skipSpace();
    return this.atEnd();
  }
}

/**
 * ``text`` read as the head of a JSON object or list: every key/value
 * pair and element read in whole, and the string that was being read
 * where the text ends; a key, number or literal the text ends in is
 * left out. Null when ``text`` is not the head of a JSON object or list
 * (it starts with anything else, or has a character JSON does not allow
 * where it has one), when it is longer than CUT_JSON_MAX_CHARS, or when
 * it nests deeper than CUT_JSON_MAX_DEPTH. One pass over the text, no
 * backtracking.
 */
export function readCutJson(text: string): CutJsonRead | null {
  if (text.length > CUT_JSON_MAX_CHARS) return null;
  const reader = new Reader(text);
  try {
    const start = text.trimStart()[0];
    if (start !== "{" && start !== "[") return null;
    const slot = reader.value(0);
    if (slot.state === "none") return null;
    const value = slot.value as Record<string, unknown> | unknown[];
    if (slot.state === "done") {
      return reader.restIsSpace() ? { value, complete: true, cutPath: [], cutInString: false } : null;
    }
    return { value, complete: false, cutPath: slot.path, cutInString: slot.inString };
  } catch (err) {
    if (err instanceof NotJson) return null;
    throw err;
  }
}

/** A path as one would write it: ``file.content``, ``content[0].text``. */
export function formatJsonPath(path: JsonPath): string {
  let out = "";
  for (const step of path) {
    out += typeof step === "number" ? `[${step}]` : out ? `.${step}` : step;
  }
  return out;
}
