// The plugin's state directory: where it lives, how it stays bounded, and
// the per-session git probe cache.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  STATE_DIR_NAME,
  STATE_FILE_MAX_AGE_MS,
  STATE_PRUNE_INTERVAL_MS,
  clearGitCache,
  markEmittedTurn,
  markerKeyFor,
  pruneStateDir,
  readOrCreateSessionMarker,
  stateDir,
} from "../hooks/scripts/core/state.mjs";
import { sessionGitFields } from "../hooks/scripts/claude_code/context.mjs";
import { readSessionPolicyCache, writeSessionPolicyCache } from "../hooks/scripts/mcp_policy.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "scripts", "observe_cli.mjs");
const DAY_MS = 24 * 60 * 60 * 1000;

let root;
let savedPluginData;

before(() => {
  root = mkdtempSync(join(tmpdir(), "fd-state-"));
  savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
});

after(() => {
  if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  rmSync(root, { recursive: true, force: true });
});

function ageFile(path, ageMs, now = Date.now()) {
  const t = (now - ageMs) / 1000;
  utimesSync(path, t, t);
}

describe("stateDir", () => {
  it("is <CLAUDE_PLUGIN_DATA>/state when Claude Code provides a data directory", () => {
    assert.equal(stateDir({ CLAUDE_PLUGIN_DATA: "/data/fd" }), join("/data/fd", "state"));
  });

  it("falls back to $TMPDIR/flightdeck-plugin when it does not", () => {
    for (const env of [{}, { CLAUDE_PLUGIN_DATA: "" }, { CLAUDE_PLUGIN_DATA: "  " }]) {
      assert.equal(stateDir(env), join(tmpdir(), STATE_DIR_NAME));
    }
  });
});

describe("pruneStateDir", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(root, "prune-"));
  });

  it("deletes files unused for longer than the maximum age and keeps the rest", () => {
    const now = Date.now();
    const old = join(dir, "emitted-old.txt");
    const fresh = join(dir, "emitted-fresh.txt");
    const sub = join(dir, "subdir");
    writeFileSync(old, "");
    writeFileSync(fresh, "");
    mkdirSync(sub);
    ageFile(old, STATE_FILE_MAX_AGE_MS + DAY_MS, now);
    ageFile(fresh, STATE_FILE_MAX_AGE_MS - DAY_MS, now);
    ageFile(sub, STATE_FILE_MAX_AGE_MS + DAY_MS, now);

    assert.equal(pruneStateDir({ now, dir }), 1);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(sub), true, "directories are left alone");
  });

  it("runs at most once per interval", () => {
    const now = Date.now();
    assert.equal(pruneStateDir({ now, dir }), 0);
    const old = join(dir, "model-x.txt");
    writeFileSync(old, "m");
    ageFile(old, STATE_FILE_MAX_AGE_MS + DAY_MS, now);
    assert.equal(pruneStateDir({ now: now + STATE_PRUNE_INTERVAL_MS - 1000, dir }), -1);
    assert.equal(existsSync(old), true);
    assert.equal(pruneStateDir({ now: now + STATE_PRUNE_INTERVAL_MS + 1000, dir }), 1);
    assert.equal(existsSync(old), false);
  });

  it("a session marker read by a hook is not pruned, however old the session", () => {
    process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(root, "data-"));
    const key = markerKeyFor(randomUUID());
    const id = readOrCreateSessionMarker(key);
    const marker = join(stateDir(), `session-${key}.txt`);
    ageFile(marker, STATE_FILE_MAX_AGE_MS + DAY_MS);
    assert.equal(readOrCreateSessionMarker(key), id, "the same session id");
    pruneStateDir({ dir: stateDir() });
    assert.equal(existsSync(marker), true);
  });

  it("an MCP policy cache read by a hook is not pruned", () => {
    process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(root, "data-"));
    const sid = randomUUID();
    writeSessionPolicyCache(sid, { global: { mode: "blocklist" }, flavor: null });
    const cache = readdirSync(stateDir()).find((n) => n.includes(sid));
    assert.ok(cache, "policy cache written in the state directory");
    ageFile(join(stateDir(), cache), STATE_FILE_MAX_AGE_MS + DAY_MS);
    assert.ok(readSessionPolicyCache(sid));
    pruneStateDir({ dir: stateDir() });
    assert.equal(existsSync(join(stateDir(), cache)), true);
  });
});

describe("markEmittedTurn", () => {
  it("writes an empty marker once", () => {
    process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(root, "data-"));
    const id = `msg_${randomUUID()}`;
    assert.equal(markEmittedTurn(id), true);
    assert.equal(markEmittedTurn(id), false);
    assert.equal(statSync(join(stateDir(), `emitted-${id}.txt`)).size, 0);
  });
});

describe("sessionGitFields", () => {
  it("probes once per session and working directory", () => {
    process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(root, "data-"));
    let probes = 0;
    const probe = () => {
      probes += 1;
      return { git_branch: `b${probes}` };
    };
    const sid = randomUUID();
    assert.deepEqual(sessionGitFields(sid, "/repo/a", probe), { git_branch: "b1" });
    assert.deepEqual(sessionGitFields(sid, "/repo/a", probe), { git_branch: "b1" });
    assert.equal(probes, 1);
    assert.deepEqual(sessionGitFields(sid, "/repo/b", probe), { git_branch: "b2" }, "a new directory probes again");
    clearGitCache(markerKeyFor(sid));
    assert.deepEqual(sessionGitFields(sid, "/repo/b", probe), { git_branch: "b3" }, "a cleared cache probes again");
    assert.deepEqual(sessionGitFields(randomUUID(), "/repo/b", probe), { git_branch: "b4" }, "another session probes");
  });

  it("probes every time without a session id", () => {
    let probes = 0;
    const probe = () => ({ n: ++probes });
    sessionGitFields(null, "/repo", probe);
    sessionGitFields("", "/repo", probe);
    assert.equal(probes, 2);
  });
});

describe("a real SessionStart hook", () => {
  let server;
  let port;
  before(async () => {
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(req.method === "GET" ? "null" : '{"ok":true}');
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => server.close());

  it("keeps its state in the plugin data directory, caches git and prunes stale files", async () => {
    const data = mkdtempSync(join(root, "hook-data-"));
    const state = join(data, "state");
    mkdirSync(state, { recursive: true });
    const stale = join(state, "emitted-msg_stale.txt");
    writeFileSync(stale, "");
    ageFile(stale, STATE_FILE_MAX_AGE_MS + DAY_MS);
    const nativeSessionId = randomUUID();
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: data,
      TMPDIR: mkdtempSync(join(root, "hook-tmp-")),
      FLIGHTDECK_SERVER: `http://127.0.0.1:${port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_QUIET: "1",
      CLAUDE_SESSION_ID: "",
      ANTHROPIC_CLAUDE_SESSION_ID: "",
      FLIGHTDECK_BILLING_MODE: "metered",
    };
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: nativeSessionId,
      source: "startup",
      model: "claude-sonnet-4-6",
      cwd: root,
    });
    const code = await new Promise((resolve) => {
      const child = execFile(process.execPath, [SCRIPT], { env, cwd: root, timeout: 15000 }, (err) =>
        resolve(err ? (err.code ?? 1) : 0),
      );
      child.stdin.end(input);
    });
    assert.equal(code, 0);
    const names = readdirSync(state);
    const key = markerKeyFor(nativeSessionId);
    assert.ok(names.includes(`session-${key}.txt`), "session marker in the data directory");
    assert.ok(names.includes(`git-${key}.json`), "git probe cached for the session");
    assert.ok(names.includes("last-prune.txt"), "prune ran");
    assert.equal(existsSync(stale), false, "the stale marker was pruned");
    assert.equal(existsSync(join(env.TMPDIR, STATE_DIR_NAME)), false, "nothing written under $TMPDIR");
  });
});
