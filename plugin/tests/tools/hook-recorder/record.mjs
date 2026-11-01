// Hook recorder for the plugin's contract fixtures: appends each hook's
// stdin payload, with the Claude Code variables the plugin reads, as one
// JSON line to $FD_HOOK_RECORD. Prints nothing, so it never changes what
// the session does. See record-scenarios.mjs.
//
// Only the variables below are kept: anything else Claude Code exports
// to a hook (credentials among them) never reaches a fixture.
import { appendFileSync, readFileSync } from "node:fs";

const RECORDED_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_ENV_FILE",
];

const out = process.env.FD_HOOK_RECORD;
if (out) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = null;
  }
  const env = {};
  for (const key of RECORDED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  appendFileSync(out, JSON.stringify({ env, input }) + "\n");
}
