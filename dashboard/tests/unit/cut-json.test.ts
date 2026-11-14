import {
  CUT_JSON_MAX_CHARS,
  CUT_JSON_MAX_DEPTH,
  CUT_MARK,
  blockCutPointers,
  childPointer,
  describeCut,
  describeCuts,
  formatJsonPath,
  readCutJson,
  resolvePointer,
} from "@/lib/cut-json";

// The tolerant reader of a JSON text cut mid-way: what earlier plugin
// versions stored as a tool's output (the response's JSON text cut at
// 2000 characters, "…" appended; the mark is stripped before reading).

/** The text the old plugin stored for ``value``, cut after ``n`` characters, without its mark. */
const cutAt = (value: unknown, n: number) => JSON.stringify(value).slice(0, n);

describe("readCutJson", () => {
  it("reads a cut inside a string: the complete pairs, and the string up to the cut", () => {
    const read = readCutJson('{"interrupted":false,"stdout":"--- PASS: TestA\\n=== RUN   Test');
    expect(read).toEqual({
      value: { interrupted: false, stdout: "--- PASS: TestA\n=== RUN   Test" },
      complete: false,
      cutPath: ["stdout"],
      cutInString: true,
    });
  });

  it("decodes escapes in the kept text: line breaks, tabs, quotes, backslashes, \\u", () => {
    const read = readCutJson('{"stdout":"a\\tb \\"q\\" C:\\\\dir \\u00e9 \\ud83d\\udd27 end');
    expect(read?.value).toEqual({ stdout: 'a\tb "q" C:\\dir é 🔧 end' });
  });

  it("drops an escape the text ends inside", () => {
    for (const tail of ["\\", "\\u", "\\u0", "\\u00", "\\u00e"]) {
      const read = readCutJson(`{"stdout":"line one${tail}`);
      expect(read?.value, tail).toEqual({ stdout: "line one" });
      expect(read?.cutInString).toBe(true);
    }
  });

  it("drops half a character pair the cut left at the end of a string", () => {
    // The old cut counted UTF-16 units and could stop between the two.
    const raw = readCutJson('{"stdout":"tool 🔧'.slice(0, -1));
    expect(raw?.value).toEqual({ stdout: "tool " });
    const escaped = readCutJson('{"stdout":"tool \\ud83d');
    expect(escaped?.value).toEqual({ stdout: "tool " });
  });

  it("leaves out a key the text ends inside", () => {
    const read = readCutJson('{"stdout":"ok","std');
    expect(read).toEqual({ value: { stdout: "ok" }, complete: false, cutPath: [], cutInString: false });
  });

  it("leaves out a key whose value had not started", () => {
    for (const text of ['{"stdout":"ok","stderr"', '{"stdout":"ok","stderr":', '{"stdout":"ok","stderr": ']) {
      const read = readCutJson(text);
      expect(read?.value, text).toEqual({ stdout: "ok" });
      expect(read?.cutPath, text).toEqual(["stderr"]);
      expect(read?.cutInString, text).toBe(false);
    }
  });

  it("reads a cut right after a comma, or right after a value", () => {
    expect(readCutJson('{"stdout":"ok",')?.value).toEqual({ stdout: "ok" });
    const atEnd = readCutJson('{"stdout":"ok","interrupted":false');
    expect(atEnd).toEqual({
      value: { stdout: "ok", interrupted: false },
      complete: false,
      cutPath: [],
      cutInString: false,
    });
    // A string closed exactly where the text ends is whole.
    expect(readCutJson('{"stdout":"ok"')?.value).toEqual({ stdout: "ok" });
  });

  it("leaves out a number or a literal the text ends inside", () => {
    // 12 may be the head of 123; tr the head of true.
    expect(readCutJson('{"a":"x","exitCode":12')?.value).toEqual({ a: "x" });
    expect(readCutJson('{"a":"x","exitCode":12')?.cutPath).toEqual(["exitCode"]);
    expect(readCutJson('{"a":"x","isImage":tr')?.value).toEqual({ a: "x" });
    expect(readCutJson('{"a":"x","b":nul')?.value).toEqual({ a: "x" });
    // A number followed by anything is whole.
    expect(readCutJson('{"exitCode":12,"a":"x')?.value).toEqual({ exitCode: 12, a: "x" });
  });

  it("reads nested objects, keeping the path of the cut", () => {
    const response = {
      type: "text",
      file: { filePath: "/repo/app.ts", content: "line 1\nline 2\nline 3", numLines: 3 },
    };
    const text = cutAt(response, JSON.stringify(response).indexOf("line 3"));
    const read = readCutJson(text);
    expect(read?.value).toEqual({ type: "text", file: { filePath: "/repo/app.ts", content: "line 1\nline 2\n" } });
    expect(read?.cutPath).toEqual(["file", "content"]);
    expect(formatJsonPath(read!.cutPath)).toBe("file.content");
  });

  it("reads lists: whole elements, a partial last element, and a list as the root", () => {
    const blocks = [{ type: "text", text: "first" }, { type: "text", text: "second block" }];
    const text = cutAt(blocks, JSON.stringify(blocks).indexOf("block"));
    const read = readCutJson(text);
    expect(read?.value).toEqual([{ type: "text", text: "first" }, { type: "text", text: "second " }]);
    expect(read?.cutPath).toEqual([1, "text"]);
    expect(formatJsonPath(read!.cutPath)).toBe("[1].text");
    expect(readCutJson('{"filenames":["/a.ts","/b.ts","/c')?.value).toEqual({ filenames: ["/a.ts", "/b.ts", "/c"] });
    expect(readCutJson('{"filenames":["/a.ts",')?.value).toEqual({ filenames: ["/a.ts"] });
    expect(readCutJson('{"lines":[1,2,3')?.value).toEqual({ lines: [1, 2] });
  });

  it("reads every prefix of a real response without failing, and keeps what each prefix holds", () => {
    const response = {
      stdout: 'ok\t"done"\n',
      stderr: "warn ⚠ \u0001",
      interrupted: false,
      isImage: false,
      nested: { list: [1, "two", null, { deep: true }] },
    };
    const full = JSON.stringify(response);
    for (let n = 1; n < full.length; n++) {
      const read = readCutJson(full.slice(0, n));
      expect(read, `prefix ${n}: ${full.slice(0, n)}`).not.toBeNull();
      expect(read!.complete).toBe(false);
      // Every whole pair read is the response's own.
      for (const [key, value] of Object.entries(read!.value)) {
        if (key === read!.cutPath[0]) continue;
        expect(value, `prefix ${n}, ${key}`).toEqual((response as Record<string, unknown>)[key]);
      }
    }
    expect(readCutJson(full)).toEqual({ value: response, complete: true, cutPath: [], cutInString: false });
  });

  it("keeps a __proto__ key as a field", () => {
    const read = readCutJson('{"__proto__":{"x":1},"stdout":"a');
    expect(Object.prototype.hasOwnProperty.call(read!.value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(read!.value)).toBe(Object.prototype);
  });

  it("is null for text that is not the head of a JSON object or list", () => {
    for (const text of [
      "",
      "plain text output",
      '"a string"',
      "42",
      "{stdout: 'single quoted'",
      '{"a":1}}',
      '{"a" 1',
      '{"a":01,"b":1',
      '{"a":1,,',
      '{"a":"bad \\x escape',
      '{"a":"raw\nline"',
      '{"a":[1 2',
      '{"a":tx',
      '{"a":1} trailing',
      "<html><body>",
    ]) {
      expect(readCutJson(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("bounds its work: a text over the size limit or nested past the depth limit is not read", () => {
    expect(readCutJson(`{"a":"${"x".repeat(CUT_JSON_MAX_CHARS)}`)).toBeNull();
    // 64 levels are read, a 65th is not: as text cut inside the deepest
    // list, and as whole JSON with a value on the deepest level.
    expect(CUT_JSON_MAX_DEPTH).toBe(64);
    expect(readCutJson("[".repeat(64))).not.toBeNull();
    expect(readCutJson("[".repeat(65))).toBeNull();
    expect(readCutJson(`${"[".repeat(64)}1${"]".repeat(64)}`)?.complete).toBe(true);
    expect(readCutJson(`${"[".repeat(65)}1${"]".repeat(65)}`)).toBeNull();
    expect(readCutJson(`${'{"a":'.repeat(64)}"deep`)?.cutPath).toHaveLength(64);
    expect(readCutJson(`${'{"a":'.repeat(65)}"deep`)).toBeNull();
  });

  it("reads the old plugin's 2000-character cut of a long Bash result", () => {
    const stdout = Array.from({ length: 200 }, (_, i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`).join("\n");
    const stored = JSON.stringify({ stdout, stderr: "", interrupted: false, isImage: false }).slice(0, 2000) + CUT_MARK;
    const read = readCutJson(stored.slice(0, -1));
    expect(read?.cutPath).toEqual(["stdout"]);
    const kept = (read?.value as { stdout: string }).stdout;
    expect(stdout.startsWith(kept)).toBe(true);
    expect(kept.split("\n").length).toBeGreaterThan(50);
  });
});

describe("the cut list beside a block's value", () => {
  it("blockCutPointers reads a list of JSON Pointers on the block, and nothing else", () => {
    expect(blockCutPointers({ type: "tool_result", content: "x", truncated: ["/stdout", "/content/0/text"] })).toEqual([
      "/stdout",
      "/content/0/text",
    ]);
    expect(blockCutPointers({ type: "tool_result", content: "x…", truncated: [""] })).toEqual([""]);
    expect(blockCutPointers({ type: "tool_result", content: "x" })).toBeNull();
    expect(blockCutPointers({ truncated: true })).toBeNull();
    expect(blockCutPointers({ truncated: [] })).toBeNull();
    expect(blockCutPointers({ truncated: ["stdout"] })).toBeNull();
    expect(blockCutPointers({ truncated: ["/a", 1] })).toBeNull();
  });

  it("resolvePointer follows keys and indices, unescapes ~1 and ~0, and finds nothing for a wrong step", () => {
    const root = { file: { content: "c…" }, content: [{ text: "t…" }], "a/b~c": "x" };
    expect(resolvePointer(root, "")).toEqual({ value: root, path: [] });
    expect(resolvePointer(root, "/file/content")).toEqual({ value: "c…", path: ["file", "content"] });
    expect(resolvePointer(root, "/content/0/text")).toEqual({ value: "t…", path: ["content", 0, "text"] });
    expect(resolvePointer(root, "/a~1b~0c")).toEqual({ value: "x", path: ["a/b~c"] });
    expect(resolvePointer(root, "/content/1/text")).toBeNull();
    expect(resolvePointer(root, "/content/01")).toBeNull();
    expect(resolvePointer(root, "/missing")).toBeNull();
    expect(resolvePointer(root, "file")).toBeNull();
    expect(resolvePointer({}, "/__proto__")).toBeNull();
    expect(childPointer("", "a/b~c")).toBe("/a~1b~0c");
    expect(childPointer("/content", 0)).toBe("/content/0");
  });

  it("describeCut counts what a cut kept", () => {
    expect(describeCut("🔧🔧…")).toBe("cut at 2 characters");
    expect(describeCut(`${"a".repeat(200)}…`)).toBe("cut at 200 characters");
    expect(describeCut(`${"a".repeat(1915)}…`)).toBe("cut at 1,915 characters");
    expect(describeCut(["/a.ts", "/b.ts"])).toBe("cut after 2 entries");
    expect(describeCut(["/a.ts"])).toBe("cut after 1 entry");
    expect(describeCut("no mark")).toBe("cut");
    expect(CUT_MARK).toBe("\u2026");
  });

  it("describeCuts names each listed value by its path, and skips a pointer that names nothing", () => {
    const root = {
      stdout: `${"o".repeat(1803)}…`,
      filenames: ["/a.ts", "/b.ts"],
      content: [{ type: "text", text: `${"r".repeat(894)}…` }],
    };
    expect(describeCuts(root, ["/stdout", "/filenames", "/content/0/text", "/gone"])).toEqual([
      "stdout cut at 1,803 characters",
      "filenames cut after 2 entries",
      "content[0].text cut at 894 characters",
    ]);
    expect(describeCuts(`${"x".repeat(1999)}…`, [""])).toEqual(["the output cut at 1,999 characters"]);
  });
});
