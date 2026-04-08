#!/usr/bin/env node
// Flightdeck Claude Code hook -- reports tool calls and session lifecycle.
// Reads hook event from stdin, POSTs to Flightdeck ingestion API.
// Uses only Node.js built-in modules. Never blocks Claude Code.

import { createHash } from "node:crypto";
import { hostname } from "node:os";

const TIMEOUT_MS = 2000;

const EVENT_MAP = {
  PreToolUse: "pre_call",
  PostToolUse: "tool_call",
  Stop: "session_end",
};

function getSessionId() {
  const env = process.env.CLAUDE_SESSION_ID;
  if (env) return env;
  const seed = `${process.pid}-${hostname()}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

async function main() {
  const server = process.env.FLIGHTDECK_SERVER;
  const token = process.env.FLIGHTDECK_TOKEN;
  if (!server || !token) {
    process.stderr.write("flightdeck: FLIGHTDECK_SERVER and FLIGHTDECK_TOKEN must be set\n");
    process.exit(0);
  }

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookEvent;
  try {
    hookEvent = JSON.parse(input);
  } catch {
    process.stderr.write("flightdeck: failed to parse hook event from stdin\n");
    process.exit(0);
  }

  const hookName = hookEvent.hook_event_name || hookEvent.event || "";
  const eventType = EVENT_MAP[hookName];
  if (!eventType) {
    process.exit(0); // Unknown hook event, silently ignore
  }

  const payload = {
    session_id: getSessionId(),
    flavor: "claude-code",
    agent_type: "developer",
    event_type: eventType,
    host: hostname(),
    framework: "claude-code",
    model: null,
    tokens_input: 0,
    tokens_output: 0,
    tokens_total: 0,
    tokens_used_session: 0,
    token_limit_session: null,
    latency_ms: null,
    tool_name: hookEvent.tool_name || hookEvent.tool || null,
    tool_input: null,
    tool_result: null,
    has_content: false,
    content: null,
    timestamp: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    await fetch(`${server}/ingest/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    process.stderr.write(`flightdeck: POST failed: ${err.message}\n`);
  }

  process.exit(0);
}

main();
