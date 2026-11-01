// Live contract suite: the plugin loaded into a real `claude -p` run,
// posting to a local capture server that applies the ingestion
// validator's rules to every event. The replay tests pin the plugin to
// recorded payloads; this one catches what a recording cannot: a Claude
// Code release that stops firing a hook, or fires it differently.
//
// It makes real model calls on whatever login the CLI picks, so it runs
// only when asked:
//
//   FLIGHTDECK_LIVE_CLAUDE=1 node --test tests/live_claude.test.mjs
//
// User settings are not loaded (`--setting-sources project`), so no
// other plugin runs beside this one. Unset ANTHROPIC_API_KEY to run on
// a Claude login.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertIngestionContract, pollUntil, startCaptureServer } from "./contract_harness.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.env.FLIGHTDECK_LIVE_CLAUDE === "1";
// One short scenario; this bounds a stuck run.
const RUN_TIMEOUT_MS = 240_000;
// The SessionEnd worker posts after the CLI exits; it gives up an
// unflushed backlog after 20 s, so 30 s is past any honest delivery.
const SESSION_END_DEADLINE_MS = 30_000;

/** Run ``claude`` without blocking the event loop: the capture server
 * answering the plugin's POSTs lives in this process. */
function runClaude(args, options) {
  return new Promise((resolve) => {
    // stdout is not read, so it is not piped: a full pipe would stall
    // the run. detached puts claude and its hook processes in one group,
    // so the timeout kills them all.
    const child = spawn("claude", args, { ...options, stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, RUN_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stderr: String(err) });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

describe("the plugin in a real claude -p run", { skip: LIVE ? false : "set FLIGHTDECK_LIVE_CLAUDE=1 to run" }, () => {
  let capture;
  let workdir;
  before(async () => {
    capture = await startCaptureServer();
    workdir = mkdtempSync(join(tmpdir(), "fd-live-"));
  });
  after(() => {
    capture?.server.closeAllConnections?.();
    capture?.server.close();
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it("reports the session, its model calls and its tool call, each event valid for ingestion", async () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("FLIGHTDECK_") || key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
    }
    Object.assign(env, {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
      FLIGHTDECK_QUIET: "1",
    });
    const run = await runClaude(
      [
        "-p",
        "Run `echo flightdeck-live` with the Bash tool, then reply with one word.",
        "--model",
        "claude-haiku-4-5",
        "--plugin-dir",
        PLUGIN,
        "--setting-sources",
        "project",
        "--allowedTools",
        "Bash(echo:*)",
      ],
      { cwd: workdir, env },
    );
    assert.equal(run.status, 0, `claude exited ${run.status}: ${run.stderr}`);
    const events = await pollUntil(
      () => {
        const bodies = capture.bodies();
        return bodies.some((b) => b.event_type === "session_end") ? bodies : null;
      },
      "session_end from the detached worker",
      SESSION_END_DEADLINE_MS,
    );
    for (const body of events) assertIngestionContract(body);
    const types = events.map((b) => b.event_type);
    assert.equal(types.filter((t) => t === "session_start").length, 1);
    assert.equal(types.at(-1), "session_end");
    assert.equal(new Set(events.map((b) => b.session_id)).size, 1, "one Flightdeck session");
    const calls = events.filter((b) => b.event_type === "post_call");
    assert.ok(calls.length >= 1, "at least one model call");
    for (const call of calls) {
      assert.ok(call.tokens_input > 0 && call.tokens_output > 0, `post_call ${call.id} carries tokens`);
      assert.match(call.model, /^claude-haiku-4-5/);
    }
    const [bash] = events.filter((b) => b.event_type === "tool_call");
    assert.equal(bash?.tool_name, "Bash");
    assert.equal(events[0].context.entrypoint, "sdk-cli");
  });
});
