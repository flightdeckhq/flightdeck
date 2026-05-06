// D139 dispatcher flow tests for observe_cli.mjs.
//
// The helpers (mcp_policy.mjs, remembered_decisions.mjs) have
// independent test suites. This file tests the dispatchers that
// orchestrate the helpers across the three hook events:
//
//   * dispatchMcpPolicySessionStart — fetch + cache + emit
//     warn/block events per non-allow declared server.
//   * dispatchMcpPolicyPreToolUse — read cache + remembered file,
//     emit Claude Code hook decision (allow/deny/ask) on stdout.
//   * dispatchMcpPolicyPostToolUse — reactive de-facto-approval
//     write + mcp_policy_user_remembered event emission.
//
// Tests stay in-process via direct import + mocked dependencies
// (no real Claude Code binary, no real network) per the
// supervisor's commit-6 scope.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchMcpPolicyPreToolUse,
  dispatchMcpPolicyPostToolUse,
  dispatchMcpPolicySessionStart,
} from "../hooks/scripts/observe_cli.mjs";
import {
  canonicalizeUrl,
  fingerprintShort,
} from "../hooks/scripts/mcp_identity.mjs";
import {
  rememberedFilePath,
  writeRememberedDecision,
} from "../hooks/scripts/remembered_decisions.mjs";

// ----- Fixtures ---------------------------------------------------

let scratchHome;
let scratchTmp;
let scratchProject;
let savedHome;
let savedUserprofile;
let savedTmp;

before(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "fdhome-test-"));
  scratchTmp = mkdtempSync(join(tmpdir(), "fdtmp-test-"));
  scratchProject = mkdtempSync(join(tmpdir(), "fdproj-test-"));
  savedHome = process.env.HOME;
  savedUserprofile = process.env.USERPROFILE;
  savedTmp = process.env.TMPDIR;
  process.env.HOME = scratchHome;
  process.env.USERPROFILE = scratchHome;
  process.env.TMPDIR = scratchTmp;
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserprofile;
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  rmSync(scratchHome, { recursive: true, force: true });
  rmSync(scratchTmp, { recursive: true, force: true });
  rmSync(scratchProject, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe the scratch dirs between tests so writes don't leak.
  rmSync(join(scratchHome, ".claude"), { recursive: true, force: true });
  rmSync(join(scratchTmp, "flightdeck-plugin"), {
    recursive: true,
    force: true,
  });
  // Reset the project's .mcp.json each test — individual tests
  // write their own.
  for (const f of ["mcp.json", ".mcp.json"]) {
    try {
      rmSync(join(scratchProject, f), { force: true });
    } catch {
      // ignore
    }
  }
});

function writeProjectMcpJson(servers) {
  writeFileSync(
    join(scratchProject, ".mcp.json"),
    JSON.stringify({ mcpServers: servers }),
  );
}

// Capture POST bodies sent to a local fake ingestion server.
function startCaptureServer() {
  return new Promise((resolve) => {
    const captured = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        try {
          captured.push(JSON.parse(body));
        } catch {
          captured.push(body);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        bodies: () => captured,
      });
    });
  });
}

// Stub fetch — captures URL+method calls for the configured
// routes; falls through to the real fetch for everything else
// (so the capture HTTP server still sees ingestion POSTs).
function stubFetch(routes) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    for (const [match, response] of routes) {
      if (u.includes(match)) {
        calls.push({ url: u, method: opts?.method || "GET" });
        if (response instanceof Error) throw response;
        return response;
      }
    }
    // Fall through to the real fetch — needed for ingestion
    // POSTs that target the local capture HTTP server.
    return realFetch(url, opts);
  };
  return calls;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Capture process.stdout.write into a buffer for PreToolUse tests.
function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return {
    chunks,
    restore: () => {
      process.stdout.write = orig;
    },
    decisions: () => {
      // Decisions are JSON-per-line; return parsed array of all
      // captured decisions.
      const out = [];
      for (const c of chunks.join("").split("\n")) {
        const trimmed = c.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed));
        } catch {
          // ignore non-JSON lines
        }
      }
      return out;
    },
  };
}

function policyEntry({ url, name, kind = "allow", enforcement = null }) {
  const canonical = canonicalizeUrl(url);
  return {
    id: `entry-${name}`,
    server_url: canonical,
    server_name: name,
    fingerprint: fingerprintShort(canonical, name),
    entry_kind: kind,
    enforcement,
  };
}

function globalDoc({ mode = "blocklist", entries = [] } = {}) {
  return {
    id: "global-id",
    scope: "global",
    scope_value: null,
    mode,
    block_on_uncertainty: false,
    entries,
  };
}

function flavorDoc({ scopeValue = "production", entries = [] } = {}) {
  return {
    id: `flavor-${scopeValue}-id`,
    scope: "flavor",
    scope_value: scopeValue,
    mode: null,
    block_on_uncertainty: false,
    entries,
  };
}

function basePayloadFixture(sessionId) {
  return {
    session_id: sessionId,
    agent_id: "00000000-0000-4000-8000-000000000000",
    agent_type: "coding",
    client_type: "claude_code",
    agent_name: "test@host",
    user: "test",
    hostname: "host",
    flavor: "production",
    host: "host",
  };
}

// ----- SessionStart flows -----------------------------------------

describe("dispatchMcpPolicySessionStart", () => {
  let savedFetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  it("fetches global + flavor on session start and writes the marker", async () => {
    const sid = "sess-ss-fetch-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    const calls = stubFetch([
      ["/v1/mcp-policies/global", jsonResponse(200, globalDoc())],
      [
        "/v1/mcp-policies/production",
        jsonResponse(200, flavorDoc({ scopeValue: "production" })),
      ],
    ]);
    const capture = await startCaptureServer();
    process.env.AGENT_FLAVOR = "production";
    try {
      await dispatchMcpPolicySessionStart({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-test",
        },
        hookEvent: { cwd: scratchProject },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
      });
      // Two HTTP GETs: global + flavor.
      assert.equal(calls.length, 2);
      // Per-session marker written.
      const markerPath = join(
        scratchTmp, "flightdeck-plugin", `mcp-policy-${sid}.json`,
      );
      assert.equal(existsSync(markerPath), true);
      const cache = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(cache.global?.scope, "global");
    } finally {
      capture.server.close();
      delete process.env.AGENT_FLAVOR;
    }
  });

  it("emits policy_mcp_block events for declared servers in allowlist mode (no entries)", async () => {
    const sid = "sess-ss-block-1";
    writeProjectMcpJson({
      maps: { command: "npx", args: ["-y", "@scope/maps"] },
    });
    stubFetch([
      [
        "/v1/mcp-policies/global",
        jsonResponse(200, globalDoc({ mode: "allowlist" })),
      ],
      ["/v1/mcp-policies/production", jsonResponse(404, {})],
    ]);
    const capture = await startCaptureServer();
    process.env.AGENT_FLAVOR = "production";
    try {
      await dispatchMcpPolicySessionStart({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-test",
        },
        hookEvent: { cwd: scratchProject },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
      });
      const events = capture.bodies();
      // Per-server policy_mcp_block emitted (allowlist + no
      // entry → mode_default block, classification=ask, but
      // SessionStart emits for every non-allow classification).
      const blockOrWarn = events.filter(
        (e) =>
          e.event_type === "policy_mcp_block"
          || e.event_type === "policy_mcp_warn",
      );
      assert.equal(
        blockOrWarn.length,
        1,
        `expected 1 policy event, got ${blockOrWarn.length}: ${JSON.stringify(events)}`,
      );
      assert.equal(blockOrWarn[0].server_name, "maps");
      assert.equal(blockOrWarn[0].decision_path, "mode_default");
    } finally {
      capture.server.close();
      delete process.env.AGENT_FLAVOR;
    }
  });

  it("emits no events when the policy allows every declared server", async () => {
    const sid = "sess-ss-allow-1";
    writeProjectMcpJson({ maps: { command: "npx", args: ["-y", "x"] } });
    stubFetch([
      [
        "/v1/mcp-policies/global",
        jsonResponse(200, globalDoc({ mode: "allowlist" })),
      ],
      [
        "/v1/mcp-policies/production",
        jsonResponse(200, flavorDoc({
          entries: [policyEntry({
            url: "npx -y x", name: "maps",
          })],
        })),
      ],
    ]);
    const capture = await startCaptureServer();
    process.env.AGENT_FLAVOR = "production";
    try {
      await dispatchMcpPolicySessionStart({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-test",
        },
        hookEvent: { cwd: scratchProject },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
      });
      const policyEvents = capture.bodies().filter((e) =>
        e.event_type?.startsWith("policy_mcp_")
      );
      assert.equal(policyEvents.length, 0);
    } finally {
      capture.server.close();
      delete process.env.AGENT_FLAVOR;
    }
  });

  it("fail-open on fetch error: cache stays empty, no events emitted", async () => {
    const sid = "sess-ss-failopen-1";
    writeProjectMcpJson({ maps: { command: "npx", args: ["-y", "x"] } });
    stubFetch([
      ["/v1/mcp-policies/", new Error("ECONNREFUSED")],
    ]);
    const capture = await startCaptureServer();
    process.env.AGENT_FLAVOR = "production";
    try {
      await dispatchMcpPolicySessionStart({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-test",
        },
        hookEvent: { cwd: scratchProject },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
      });
      // Cache marker WAS written (with null/null) — fail-open
      // doesn't skip the cache write because subsequent
      // PreToolUse needs to find SOMETHING in the cache to
      // distinguish "preflight failed" from "no SessionStart
      // ran".
      const markerPath = join(
        scratchTmp, "flightdeck-plugin", `mcp-policy-${sid}.json`,
      );
      assert.equal(existsSync(markerPath), true);
      const cache = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(cache.global, null);
      assert.equal(cache.flavor, null);
      // No policy events emitted.
      const policyEvents = capture.bodies().filter((e) =>
        e.event_type?.startsWith("policy_mcp_")
      );
      assert.equal(policyEvents.length, 0);
    } finally {
      capture.server.close();
      delete process.env.AGENT_FLAVOR;
    }
  });

  it("skips entirely when .mcp.json declares zero servers", async () => {
    const sid = "sess-ss-empty-1";
    writeProjectMcpJson({});
    const calls = stubFetch([]);
    const capture = await startCaptureServer();
    try {
      await dispatchMcpPolicySessionStart({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-test",
        },
        hookEvent: { cwd: scratchProject },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
      });
      assert.equal(calls.length, 0, "no fetch calls when no MCP servers");
      assert.equal(capture.bodies().length, 0);
    } finally {
      capture.server.close();
    }
  });
});

// ----- PreToolUse flows -------------------------------------------

describe("dispatchMcpPolicyPreToolUse", () => {
  function seedPolicyCache(sessionId, policies) {
    const dir = join(scratchTmp, "flightdeck-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `mcp-policy-${sessionId}.json`),
      JSON.stringify({ version: 1, ...policies }),
    );
  }

  it("returns deny on stdout when policy blocks the server", () => {
    const sid = "sess-pre-block-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [
          policyEntry({
            url: "npx -y x", name: "x",
            kind: "deny", enforcement: "block",
          }),
        ],
      }),
    });
    const out = captureStdout();
    const savedEnvSid = process.env.CLAUDE_SESSION_ID;
    try {
      // getSessionId() short-circuits to env var when set, which
      // pins the session id deterministically without relying on
      // the marker-file derivation.
      process.env.CLAUDE_SESSION_ID = sid;
      const handled = dispatchMcpPolicyPreToolUse(
        { server: "http://127.0.0.1:9999", token: "tok-test" },
        {
          hook_event_name: "PreToolUse",
          session_id: sid,
          tool_name: "mcp__x__doit",
          cwd: scratchProject,
        },
      );
      assert.equal(handled, true);
      const decisions = out.decisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].decision, "deny");
      assert.match(decisions[0].reason, /MCP policy blocked/);
    } finally {
      out.restore();
      if (savedEnvSid === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnvSid;
    }
  });

  it("returns ask when unknown server in allowlist mode + no remembered decision", () => {
    const sid = "sess-pre-ask-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    });
    const out = captureStdout();
    const savedEnvSid = process.env.CLAUDE_SESSION_ID;
    try {
      // getSessionId() short-circuits to env var when set, which
      // pins the session id deterministically without relying on
      // the marker-file derivation.
      process.env.CLAUDE_SESSION_ID = sid;
      const handled = dispatchMcpPolicyPreToolUse(
        { server: "http://x", token: "tok-pre-ask" },
        {
          hook_event_name: "PreToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
      );
      assert.equal(handled, true);
      assert.equal(out.decisions()[0].decision, "ask");
    } finally {
      out.restore();
      if (savedEnvSid === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnvSid;
    }
  });

  it("returns allow when policy says allow", () => {
    const sid = "sess-pre-allow-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [policyEntry({ url: "npx -y x", name: "x" })],
      }),
    });
    const out = captureStdout();
    const savedEnvSid = process.env.CLAUDE_SESSION_ID;
    try {
      // getSessionId() short-circuits to env var when set, which
      // pins the session id deterministically without relying on
      // the marker-file derivation.
      process.env.CLAUDE_SESSION_ID = sid;
      const handled = dispatchMcpPolicyPreToolUse(
        { server: "http://x", token: "tok-pre-allow" },
        {
          hook_event_name: "PreToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
      );
      // Allow classification → no explicit decision written; let
      // Claude Code's default flow apply.
      assert.equal(handled, false);
      assert.equal(out.decisions().length, 0);
    } finally {
      out.restore();
      if (savedEnvSid === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnvSid;
    }
  });

  it("returns allow when remembered decision exists for unknown_allowlist server", () => {
    const sid = "sess-pre-remembered-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    });
    const fp = fingerprintShort(canonicalizeUrl("npx -y x"), "x");
    writeRememberedDecision("tok-pre-remembered", {
      fingerprint: fp,
      serverUrlCanonical: canonicalizeUrl("npx -y x"),
      serverName: "x",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    const out = captureStdout();
    const savedEnvSid = process.env.CLAUDE_SESSION_ID;
    try {
      // getSessionId() short-circuits to env var when set, which
      // pins the session id deterministically without relying on
      // the marker-file derivation.
      process.env.CLAUDE_SESSION_ID = sid;
      const handled = dispatchMcpPolicyPreToolUse(
        { server: "http://x", token: "tok-pre-remembered" },
        {
          hook_event_name: "PreToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
      );
      assert.equal(handled, true);
      assert.equal(out.decisions()[0].decision, "allow");
    } finally {
      out.restore();
      if (savedEnvSid === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnvSid;
    }
  });

  it("non-MCP tool name → no decision written, silent fallthrough", () => {
    const sid = "sess-pre-nonmcp-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    });
    const out = captureStdout();
    const savedEnvSid = process.env.CLAUDE_SESSION_ID;
    try {
      // getSessionId() short-circuits to env var when set, which
      // pins the session id deterministically without relying on
      // the marker-file derivation.
      process.env.CLAUDE_SESSION_ID = sid;
      const handled = dispatchMcpPolicyPreToolUse(
        { server: "http://x", token: "tok-pre-nonmcp" },
        {
          hook_event_name: "PreToolUse",
          session_id: sid,
          tool_name: "Bash",
          cwd: scratchProject,
        },
      );
      assert.equal(handled, false);
      assert.equal(out.decisions().length, 0);
    } finally {
      out.restore();
      if (savedEnvSid === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnvSid;
    }
  });

  it("missing per-session cache → fail-open, no decision written", () => {
    const sid = "sess-pre-nocache-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    // No seedPolicyCache call.
    const out = captureStdout();
    const savedEnvSid = process.env.CLAUDE_SESSION_ID;
    try {
      // getSessionId() short-circuits to env var when set, which
      // pins the session id deterministically without relying on
      // the marker-file derivation.
      process.env.CLAUDE_SESSION_ID = sid;
      const handled = dispatchMcpPolicyPreToolUse(
        { server: "http://x", token: "tok-pre-nocache" },
        {
          hook_event_name: "PreToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
      );
      assert.equal(handled, false);
    } finally {
      out.restore();
      if (savedEnvSid === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnvSid;
    }
  });
});

// ----- PostToolUse flows ------------------------------------------

describe("dispatchMcpPolicyPostToolUse", () => {
  function seedPolicyCache(sessionId, policies) {
    const dir = join(scratchTmp, "flightdeck-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `mcp-policy-${sessionId}.json`),
      JSON.stringify({ version: 1, ...policies }),
    );
  }

  it("writes remembered decision + emits event on first success of unknown_allowlist server", async () => {
    const sid = "sess-post-write-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    });
    const capture = await startCaptureServer();
    try {
      await dispatchMcpPolicyPostToolUse({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-post-write",
        },
        hookEvent: {
          hook_event_name: "PostToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
        toolName: "mcp__x__call",
      });
      // Remembered file written.
      const rememberedPath = rememberedFilePath("tok-post-write");
      assert.equal(existsSync(rememberedPath), true);
      const remembered = JSON.parse(readFileSync(rememberedPath, "utf8"));
      assert.equal(remembered.decisions.length, 1);
      assert.equal(remembered.decisions[0].server_name, "x");
      // Event emitted.
      const events = capture.bodies();
      const remEvents = events.filter(
        (e) => e.event_type === "mcp_policy_user_remembered",
      );
      assert.equal(remEvents.length, 1);
      assert.equal(remEvents[0].server_name, "x");
      assert.equal(remEvents[0].fingerprint, remembered.decisions[0].fingerprint);
      // Event payload required-fields check.
      assert.ok(remEvents[0].fingerprint, "fingerprint missing");
      assert.ok(remEvents[0].server_url_canonical, "server_url_canonical missing");
      assert.ok(remEvents[0].server_name, "server_name missing");
      assert.ok(remEvents[0].flavor, "flavor missing");
      assert.ok(remEvents[0].decided_at, "decided_at missing");
    } finally {
      capture.server.close();
    }
  });

  it("does NOT write when classification is allow (already permitted)", async () => {
    const sid = "sess-post-noop-allow-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [policyEntry({ url: "npx -y x", name: "x" })],
      }),
    });
    const capture = await startCaptureServer();
    try {
      await dispatchMcpPolicyPostToolUse({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-post-noop-allow",
        },
        hookEvent: {
          hook_event_name: "PostToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
        toolName: "mcp__x__call",
      });
      const rememberedPath = rememberedFilePath("tok-post-noop-allow");
      assert.equal(existsSync(rememberedPath), false);
      assert.equal(capture.bodies().length, 0);
    } finally {
      capture.server.close();
    }
  });

  it("does NOT write when classification is block (call would have failed)", async () => {
    const sid = "sess-post-noop-block-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [
          policyEntry({
            url: "npx -y x", name: "x",
            kind: "deny", enforcement: "block",
          }),
        ],
      }),
    });
    const capture = await startCaptureServer();
    try {
      await dispatchMcpPolicyPostToolUse({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-post-noop-block",
        },
        hookEvent: {
          hook_event_name: "PostToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
        toolName: "mcp__x__call",
      });
      const rememberedPath = rememberedFilePath("tok-post-noop-block");
      assert.equal(existsSync(rememberedPath), false);
      assert.equal(capture.bodies().length, 0);
    } finally {
      capture.server.close();
    }
  });

  it("idempotent: second PostToolUse for same fingerprint does not duplicate", async () => {
    const sid = "sess-post-idem-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    });
    const capture = await startCaptureServer();
    try {
      const args = {
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-post-idem",
        },
        hookEvent: {
          hook_event_name: "PostToolUse",
          session_id: sid,
          tool_name: "mcp__x__call",
          cwd: scratchProject,
        },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
        toolName: "mcp__x__call",
      };
      await dispatchMcpPolicyPostToolUse(args);
      await dispatchMcpPolicyPostToolUse(args);
      const remembered = JSON.parse(
        readFileSync(rememberedFilePath("tok-post-idem"), "utf8"),
      );
      assert.equal(remembered.decisions.length, 1);
      const remEvents = capture.bodies().filter(
        (e) => e.event_type === "mcp_policy_user_remembered",
      );
      // First call writes; second call sees lookupRemembered hit
      // and short-circuits before postEvent.
      assert.equal(remEvents.length, 1);
    } finally {
      capture.server.close();
    }
  });

  it("non-MCP tool name → no-op", async () => {
    const sid = "sess-post-nonmcp-1";
    writeProjectMcpJson({ x: { command: "npx", args: ["-y", "x"] } });
    seedPolicyCache(sid, {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    });
    const capture = await startCaptureServer();
    try {
      await dispatchMcpPolicyPostToolUse({
        cfg: {
          server: `http://127.0.0.1:${capture.port}`,
          token: "tok-post-nonmcp",
        },
        hookEvent: {
          hook_event_name: "PostToolUse",
          session_id: sid,
          tool_name: "Bash",
          cwd: scratchProject,
        },
        sessionId: sid,
        basePayload: basePayloadFixture(sid),
        toolName: "Bash",
      });
      assert.equal(existsSync(rememberedFilePath("tok-post-nonmcp")), false);
      assert.equal(capture.bodies().length, 0);
    } finally {
      capture.server.close();
    }
  });
});
