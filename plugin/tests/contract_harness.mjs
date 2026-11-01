// Shared harness for the plugin's hook-contract tests: a mirror of the
// ingestion validator, the hook-process environment a replayed
// recording runs in, capture servers and a polling helper. Each test
// file that imports it runs in its own process (node --test), so the
// temp root below is per file.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

import { CI_PROVIDER_ENV } from "../hooks/scripts/observe_cli.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "scripts", "observe_cli.mjs");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Go's time.RFC3339 layout: date, T, time, optional fraction, then Z or
// a numeric offset. Date.parse alone is looser (it takes a date without
// a zone and other ISO forms the validator rejects).
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// POST /v1/events reads at most this many body bytes; a larger payload
// is truncated and rejected as invalid JSON.
const MAX_REQUEST_BODY_BYTES = 1 << 20;

// Every hook subprocess in this file gets its own temp root. The plugin
// keeps its session / started / emitted markers in its state directory
// (hookEnv points CLAUDE_PLUGIN_DATA under the temp root), and node runs
// test files concurrently:
// observe_cli.test.mjs wipes the shared directory in several of its
// tests, which would delete this file's markers mid-run and turn a
// deterministic replay into a flaky one.
export const privateTmp = mkdtempSync(join(tmpdir(), "fd-contract-"));
export const markerDir = join(privateTmp, "plugin-data", "state");
after(() => rmSync(privateTmp, { recursive: true, force: true }));

// Mirror of the ingestion validator (ingestion/internal/handlers/
// events.go). Kept in the same order as the Go code so a reviewer can
// diff the two. Throws on the first rule the payload breaks.
export function assertIngestionContract(p) {
  assert.ok(p && typeof p === "object", "payload must be an object");
  assert.ok(
    Buffer.byteLength(JSON.stringify(p), "utf8") <= MAX_REQUEST_BODY_BYTES,
    "payload exceeds the 1 MiB request body cap",
  );
  assert.ok(
    typeof p.session_id === "string" && p.session_id !== "",
    "session_id is required",
  );
  assert.ok(
    typeof p.event_type === "string" && p.event_type !== "",
    "event_type is required",
  );
  assert.match(p.session_id, UUID_RE, "session_id must be a canonical UUID");
  if (typeof p.timestamp === "string" && p.timestamp !== "") {
    assert.match(p.timestamp, RFC3339_RE, `timestamp must be RFC 3339 (got ${p.timestamp})`);
    const ts = Date.parse(p.timestamp);
    const now = Date.now();
    const maxPast = 48 * 60 * 60 * 1000;
    const maxFuture = 5 * 60 * 1000;
    assert.ok(
      ts >= now - maxPast && ts <= now + maxFuture,
      "timestamp outside the clock-skew window",
    );
  }
  for (const key of ["tokens_input", "tokens_output", "tokens_total"]) {
    if (p[key] != null) {
      assert.ok(
        typeof p[key] === "number" && p[key] >= 0,
        `${key} must be >= 0`,
      );
    }
  }
  assert.ok(typeof p.agent_id === "string" && p.agent_id !== "", "agent_id is required");
  assert.match(p.agent_id, UUID_RE, "agent_id must be a canonical UUID");
  assert.ok(
    ["coding", "production"].includes(p.agent_type),
    `agent_type must be coding|production (got ${p.agent_type})`,
  );
  assert.ok(
    ["claude_code", "flightdeck_sensor"].includes(p.client_type),
    `client_type must be claude_code|flightdeck_sensor (got ${p.client_type})`,
  );
  if (p.parent_session_id != null) {
    assert.equal(typeof p.parent_session_id, "string", "parent_session_id must be a string");
    if (p.parent_session_id !== "") {
      assert.match(p.parent_session_id, UUID_RE, "parent_session_id must be a canonical UUID");
    }
  }
  if (p.agent_role != null) {
    assert.equal(typeof p.agent_role, "string", "agent_role must be a string");
    assert.ok(p.agent_role.length <= 256, "agent_role exceeds 256 characters");
  }
  // The Claude Code plugin's optional fields: ingestion type-checks them
  // on tool_call / mcp_tool_call (tool_use_id, mcp_server) and
  // session_end (end_reason), in UTF-8 bytes; null counts as absent.
  if (p.event_type === "tool_call" || p.event_type === "mcp_tool_call") {
    if (p.tool_use_id != null) {
      assert.equal(typeof p.tool_use_id, "string", "tool_use_id must be a string");
      assert.ok(Buffer.byteLength(p.tool_use_id, "utf8") <= 256, "tool_use_id exceeds 256 bytes");
    }
    if (p.mcp_server != null) {
      assert.ok(
        typeof p.mcp_server === "object" && !Array.isArray(p.mcp_server),
        "mcp_server must be an object",
      );
      assert.ok(
        typeof p.mcp_server.name === "string" && p.mcp_server.name !== "",
        "mcp_server.name must be a non-empty string",
      );
      assert.ok(Buffer.byteLength(p.mcp_server.name, "utf8") <= 256, "mcp_server.name exceeds 256 bytes");
      if (p.mcp_server.source != null) {
        assert.equal(typeof p.mcp_server.source, "string", "mcp_server.source must be a string or null");
        assert.ok(Buffer.byteLength(p.mcp_server.source, "utf8") <= 256, "mcp_server.source exceeds 256 bytes");
      }
    }
  }
  if (p.event_type === "session_end" && p.end_reason != null) {
    assert.equal(typeof p.end_reason, "string", "end_reason must be a string");
    assert.ok(Buffer.byteLength(p.end_reason, "utf8") <= 64, "end_reason exceeds 64 bytes");
  }
  const assertDecisionBlock = (block, label) => {
    assert.ok(block && typeof block === "object", `${label} must be an object`);
    for (const field of ["policy_id", "scope", "decision", "reason"]) {
      assert.ok(
        typeof block[field] === "string" && block[field] !== "",
        `${label}.${field} is required`,
      );
    }
  };
  switch (p.event_type) {
    case "policy_warn":
    case "policy_degrade":
    case "policy_block":
      assertDecisionBlock(p.policy_decision, "policy_decision");
      break;
    case "policy_mcp_warn":
    case "policy_mcp_block":
      for (const field of [
        "server_url",
        "server_name",
        "fingerprint",
        "policy_id",
        "decision_path",
      ]) {
        assert.ok(
          typeof p[field] === "string" && p[field] !== "",
          `${field} is required for ${p.event_type}`,
        );
      }
      assert.ok(
        ["flavor_entry", "global_entry", "mode_default"].includes(p.decision_path),
        "decision_path enum",
      );
      assertDecisionBlock(p.policy_decision, "policy_decision");
      break;
    case "mcp_policy_user_remembered":
      for (const field of [
        "fingerprint",
        "server_url_canonical",
        "server_name",
        "flavor",
        "decided_at",
      ]) {
        assert.ok(
          typeof p[field] === "string" && p[field] !== "",
          `${field} is required for mcp_policy_user_remembered`,
        );
      }
      if ("permission_mode" in p) {
        assert.ok(
          typeof p.permission_mode === "string" && Buffer.byteLength(p.permission_mode, "utf8") <= 64,
          "permission_mode is a string of at most 64 bytes when present (ingestion counts bytes)",
        );
      }
      break;
    case "session_start":
      assert.equal(
        typeof p.sensor_version,
        "string",
        "sensor_version is required for session_start",
      );
      break;
    case "session_end":
      if ("close_reason" in p) {
        assert.ok(
          [
            "normal_exit",
            "directive_shutdown",
            "policy_block",
            "orphan_timeout",
            "sigkill_detected",
            "unknown",
          ].includes(p.close_reason),
          `close_reason enum (got ${p.close_reason})`,
        );
      }
      break;
    case "session_signal":
      assert.match(p.signal ?? "", /^[a-z][a-z0-9_]{0,63}$/, "signal is a lowercase identifier");
      if (p.signal_data != null) {
        assert.ok(typeof p.signal_data === "object" && !Array.isArray(p.signal_data), "signal_data must be an object");
        assert.ok(Object.keys(p.signal_data).length <= 32, "signal_data exceeds 32 keys");
        for (const [key, value] of Object.entries(p.signal_data)) {
          assert.ok(
            value === null || ["boolean", "number", "string"].includes(typeof value),
            `signal_data.${key} must be a scalar`,
          );
          if (typeof value === "string") {
            assert.ok(Buffer.byteLength(value, "utf8") <= 256, `signal_data.${key} exceeds 256 bytes`);
          }
        }
      }
      break;
    case "llm_error":
      if ("terminal" in p) assert.equal(typeof p.terminal, "boolean", "terminal must be a boolean on llm_error");
      if ("retry_attempt" in p) {
        assert.ok(Number.isInteger(p.retry_attempt) && p.retry_attempt >= 1, "retry_attempt must be a positive integer");
      }
      break;
    case "pre_call":
    case "post_call":
    case "embeddings":
      if ("estimated_via" in p) {
        assert.ok(
          ["tiktoken", "heuristic", "none"].includes(p.estimated_via),
          "estimated_via enum",
        );
      }
      if (p.event_type !== "pre_call" && "provider_metadata" in p) {
        assert.ok(
          p.provider_metadata && typeof p.provider_metadata === "object",
          "provider_metadata must be an object",
        );
      }
      break;
    default:
      break;
  }
  assertTokenCostContract(p);
}

// Mirror of ingestion/internal/handlers/token_cost.go: the token, model
// and cost fields, validated on every event type when present.
export function assertTokenCostContract(p) {
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  for (const key of ["tokens_reasoning", "tokens_cache_creation_1h"]) {
    if (p[key] != null) assert.ok(isCount(p[key]), `${key} must be a non-negative integer`);
  }
  if (typeof p.tokens_reasoning === "number" && typeof p.tokens_output === "number") {
    assert.ok(p.tokens_reasoning <= p.tokens_output, "tokens_reasoning must not exceed tokens_output");
  }
  if (typeof p.tokens_cache_creation_1h === "number" && typeof p.tokens_cache_creation === "number") {
    assert.ok(
      p.tokens_cache_creation_1h <= p.tokens_cache_creation,
      "tokens_cache_creation_1h must not exceed tokens_cache_creation",
    );
  }
  assert.equal(p.cost_reported != null, p.cost_source != null, "cost_reported and cost_source together");
  const enums = {
    billing_mode: ["metered", "subscription", "local"],
    provider: ["anthropic", "openai", "google", "xai", "mistral", "meta", "deepseek", "other"],
    cost_source: ["provider", "agent"],
    inference_scope: ["global", "regional"],
  };
  for (const [key, values] of Object.entries(enums)) {
    if (p[key] != null) assert.ok(values.includes(p[key]), `${key} has an unsupported value: ${p[key]}`);
  }
  for (const key of ["model_requested", "model_served", "service_tier", "speed", "inference_geo", "stop_reason"]) {
    if (p[key] != null) {
      assert.equal(typeof p[key], "string", `${key} must be a string`);
      assert.ok(Buffer.byteLength(p[key], "utf8") <= 256, `${key} exceeds 256 bytes`);
    }
  }
  if (p.server_tool_use != null) {
    for (const [name, v] of Object.entries(p.server_tool_use)) {
      assert.ok(isCount(v), `server_tool_use.${name} must be a non-negative integer`);
    }
  }
  const platform = p.provider_metadata?.platform;
  if (platform != null) {
    assert.equal(typeof platform, "string", "provider_metadata.platform must be a string");
    assert.ok(platform.length <= 253, "provider_metadata.platform exceeds 253 characters");
  }
}

export function runScript(stdinData, env, extraArgs = []) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      process.execPath,
      [SCRIPT, ...extraArgs],
      { env, timeout: 20000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code ?? 1 : 0,
          stdout,
          stderr,
          wallMs: Date.now() - started,
        });
      },
    );
    if (stdinData != null) child.stdin.write(stdinData);
    child.stdin.end();
  });
}

// A hook process environment: the recorded CLAUDE_CODE_* variables from
// the fixture on top of a scrubbed copy of ours, so the signals the
// plugin reads come from the recording and not from the shell running
// the tests (which may itself be a Claude Code session, or a CI runner
// whose GITHUB_ACTIONS / CI variables would otherwise mark every
// replayed session as a CI run).
const SCRUBBED_ENV_KEYS = new Set(["CI", ...CI_PROVIDER_ENV.map(([key]) => key)]);
export function hookEnv(recordEnv, overrides) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("CLAUDE") || k.startsWith("FLIGHTDECK") || SCRUBBED_ENV_KEYS.has(k)) {
      continue;
    }
    base[k] = v;
  }
  return {
    ...base,
    ...recordEnv,
    FLIGHTDECK_QUIET: "1",
    TMPDIR: privateTmp,
    TEMP: privateTmp,
    TMP: privateTmp,
    // The plugin reads ~/.claude.json for MCP fingerprints; the
    // replay must not see the test machine's real one.
    HOME: privateTmp,
    USERPROFILE: privateTmp,
    ...overrides,
    // State goes where Claude Code puts it, a plugin data directory, but
    // under this test's temp root: the recording's CLAUDE_PLUGIN_DATA
    // names the recording machine's path.
    CLAUDE_PLUGIN_DATA:
      overrides?.CLAUDE_PLUGIN_DATA ?? join(overrides?.TMPDIR ?? privateTmp, "plugin-data"),
  };
}

// Only the ingestion endpoint is recorded; any other request (a policy
// fetch under /api, a typo in the path) is answered 404 and ignored, so
// a body landing on the wrong route cannot satisfy an assertion.
export function isIngestPost(req) {
  return req.method === "POST" && req.url === "/ingest/v1/events";
}

export function startCaptureServer() {
  return new Promise((resolve) => {
    const captured = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!isIngestPost(req)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        try {
          captured.push(JSON.parse(body));
        } catch {
          captured.push(body);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok","attached":false}');
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, bodies: () => captured });
    });
  });
}

// A server that parks every request until release() is called. Lets a
// test prove a hook returned without waiting on the network: the hook
// exits while the requests are still parked.
export function startGatedServer() {
  return new Promise((resolve) => {
    const captured = [];
    const parked = [];
    let released = false;
    const answer = (body, res) => {
      try {
        captured.push(JSON.parse(body));
      } catch {
        captured.push(body);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","attached":false}');
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!isIngestPost(req)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        if (released) answer(body, res);
        else parked.push(() => answer(body, res));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        bodies: () => captured,
        parkedCount: () => parked.length,
        release: () => {
          released = true;
          while (parked.length > 0) parked.shift()();
        },
      });
    });
  });
}

// Polling helper: re-evaluates the predicate until it returns a truthy
// value. The deadline is a safety bound against a hung worker, not a
// wait -- the loop returns the moment the condition holds.
export async function pollUntil(predicate, label, deadlineMs = 15000) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`pollUntil(${label}): condition not met within ${deadlineMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
