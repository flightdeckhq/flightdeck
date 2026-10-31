// Billing mode, platform and usage-detail fields of the Claude Code
// plugin (hooks/scripts/billing.mjs and the post_call fields built from
// them in observe_cli.mjs).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  authStatusEnv,
  claudeConfigPath,
  detectEndpoint,
  envApiKeyInUse,
  readAuthStatus,
  usageDetailFields,
} from "../hooks/scripts/billing.mjs";

// A Claude Code config directory with one approved and one rejected
// ANTHROPIC_API_KEY, recorded by their last 20 characters as Claude Code
// records them, so no test reads the developer's own ~/.claude.json.
const APPROVED_KEY = "sk-ant-api03-approved-0123456789abcdefghij";
const REJECTED_KEY = "sk-ant-api03-rejected-9876543210zyxwvutsrq";
const configDir = mkdtempSync(join(tmpdir(), "fd-claude-config-"));
writeFileSync(
  join(configDir, ".claude.json"),
  JSON.stringify({ customApiKeyResponses: { approved: [APPROVED_KEY.slice(-20)], rejected: [REJECTED_KEY.slice(-20)] } }),
);
after(() => rmSync(configDir, { recursive: true, force: true }));
const interactive = (key) => ({ ANTHROPIC_API_KEY: key, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: configDir });

const API_KEY = { authMethod: "api_key", apiProvider: "firstParty" };
const CLAUDE_AI = { authMethod: "claude.ai", apiProvider: "firstParty" };

describe("detectEndpoint", () => {
  const cases = [
    ["claude.ai login is a subscription", {}, CLAUDE_AI, "subscription", "anthropic"],
    ["oauth token is a subscription", {}, { authMethod: "oauth_token" }, "subscription", "anthropic"],
    ["API key login is metered", {}, API_KEY, "metered", "anthropic"],
    ["API key helper is metered", {}, { authMethod: "api_key_helper" }, "metered", "anthropic"],
    ["Bedrock env is metered", { CLAUDE_CODE_USE_BEDROCK: "1" }, CLAUDE_AI, "metered", "bedrock"],
    ["Vertex env is metered", { CLAUDE_CODE_USE_VERTEX: "true" }, null, "metered", "vertex"],
    ["Foundry env is metered", { CLAUDE_CODE_USE_FOUNDRY: "1" }, null, "metered", "foundry"],
    ["a falsy cloud flag is ignored", { CLAUDE_CODE_USE_BEDROCK: "0" }, CLAUDE_AI, "subscription", "anthropic"],
    ["the CLI's cloud provider counts", {}, { authMethod: "third_party", apiProvider: "bedrock" }, "metered", "bedrock"],
    ["no CLI, a print-mode run's API key", { ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, null, "metered", "anthropic"],
    ["no CLI, an approved key in an interactive session", interactive(APPROVED_KEY), null, "metered", "anthropic"],
    ["no CLI, a rejected key in an interactive session", interactive(REJECTED_KEY), null, "subscription", "anthropic"],
    ["no CLI, auth token set", { ANTHROPIC_AUTH_TOKEN: "t" }, null, "metered", "anthropic"],
    ["no CLI, nothing set", {}, null, "subscription", "anthropic"],
    ["override wins", { FLIGHTDECK_BILLING_MODE: " Metered " }, CLAUDE_AI, "metered", "anthropic"],
    ["override to local", { FLIGHTDECK_BILLING_MODE: "local" }, API_KEY, "local", "anthropic"],
    ["an invalid override is ignored", { FLIGHTDECK_BILLING_MODE: "free" }, CLAUDE_AI, "subscription", "anthropic"],
    ["a gateway base URL reports its host", { ANTHROPIC_BASE_URL: "https://gw.example.com/v1" }, API_KEY, "metered", "gw.example.com"],
    ["an Anthropic base URL stays anthropic", { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, API_KEY, "metered", "anthropic"],
    ["a look-alike host stays bare", { ANTHROPIC_BASE_URL: "https://evilanthropic.com" }, API_KEY, "metered", "evilanthropic.com"],
    ["a malformed base URL is invalid-host", { ANTHROPIC_BASE_URL: "::not a url" }, API_KEY, "metered", "invalid-host"],
    ["an IPv6 loopback proxy is localhost", { ANTHROPIC_BASE_URL: "http://[::1]:8080" }, API_KEY, "metered", "localhost"],
    ["a 127.x proxy is localhost", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" }, API_KEY, "metered", "localhost"],
    ["a host merely starting with 127. is a gateway", { ANTHROPIC_BASE_URL: "https://127.example.com" }, API_KEY, "metered", "127.example.com"],
    ["a trailing-dot Anthropic host stays anthropic", { ANTHROPIC_BASE_URL: "https://api.anthropic.com./v1" }, API_KEY, "metered", "anthropic"],
    ["a third-party credential is metered", {}, { authMethod: "third_party", apiProvider: "firstParty" }, "metered", "anthropic"],
  ];
  for (const [name, env, status, billing, platform] of cases) {
    it(name, () => {
      const got = detectEndpoint(env, status);
      assert.equal(got.billingMode, billing);
      assert.equal(got.platform, platform);
    });
  }

  it("reports the Vertex AI scope from CLOUD_ML_REGION", () => {
    const vertex = { CLAUDE_CODE_USE_VERTEX: "1" };
    assert.equal(detectEndpoint({ ...vertex, CLOUD_ML_REGION: "global" }, null).inferenceScope, "global");
    assert.equal(detectEndpoint({ ...vertex, CLOUD_ML_REGION: "us-east5" }, null).inferenceScope, "regional");
    assert.equal(detectEndpoint(vertex, null).inferenceScope, null);
    assert.equal(detectEndpoint({ CLOUD_ML_REGION: "us-east5" }, null).inferenceScope, null);
  });
});

describe("envApiKeyInUse", () => {
  it("follows Claude Code: a non-interactive or bare run uses any key, an interactive session only an approved one", () => {
    assert.equal(envApiKeyInUse({}), false);
    assert.equal(envApiKeyInUse({ ANTHROPIC_API_KEY: "  " }), false);
    assert.equal(envApiKeyInUse({ ANTHROPIC_API_KEY: REJECTED_KEY, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), true);
    assert.equal(envApiKeyInUse({ ANTHROPIC_API_KEY: REJECTED_KEY, CLAUDE_CODE_ENTRYPOINT: "sdk-py" }), true);
    assert.equal(envApiKeyInUse({ ...interactive(REJECTED_KEY), CLAUDE_CODE_SIMPLE: "1" }), true);
    assert.equal(envApiKeyInUse(interactive(APPROVED_KEY)), true);
    assert.equal(envApiKeyInUse(interactive(` ${APPROVED_KEY}\n`)), true);
    assert.equal(envApiKeyInUse(interactive(REJECTED_KEY)), false);
    assert.equal(envApiKeyInUse({ ...interactive(APPROVED_KEY), CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }), true);
    assert.equal(envApiKeyInUse({ ...interactive(REJECTED_KEY), CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }), false);
  });

  it("treats a missing or unreadable config as no approval", () => {
    const missing = mkdtempSync(join(tmpdir(), "fd-claude-none-"));
    assert.equal(envApiKeyInUse({ ANTHROPIC_API_KEY: APPROVED_KEY, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: missing }), false);
    writeFileSync(join(missing, ".claude.json"), "{not json");
    assert.equal(envApiKeyInUse({ ANTHROPIC_API_KEY: APPROVED_KEY, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: missing }), false);
    rmSync(missing, { recursive: true, force: true });
  });

  it("finds the config under CLAUDE_CONFIG_DIR, else the home directory", () => {
    assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" }), join("/cfg", ".claude.json"));
    assert.ok(claudeConfigPath({}).endsWith(".claude.json"));
  });

  it("runs `claude auth status` without a key the session does not use", () => {
    assert.equal(authStatusEnv(interactive(REJECTED_KEY)).ANTHROPIC_API_KEY, undefined);
    assert.equal(authStatusEnv(interactive(REJECTED_KEY)).CLAUDE_CODE_ENTRYPOINT, "cli");
    assert.equal(authStatusEnv(interactive(APPROVED_KEY)).ANTHROPIC_API_KEY, APPROVED_KEY);
    const env = { PATH: "/bin" };
    assert.equal(authStatusEnv(env), env);
  });
});

describe("readAuthStatus", () => {
  it("reads authMethod and apiProvider from the CLI's JSON", () => {
    const run = () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    assert.deepEqual(readAuthStatus(run), { authMethod: "claude.ai", apiProvider: "firstParty" });
  });

  it("is null when the CLI fails, is missing or prints something else", () => {
    assert.equal(readAuthStatus(() => { throw new Error("ENOENT"); }), null);
    assert.equal(readAuthStatus(() => "not json"), null);
    assert.equal(readAuthStatus(() => JSON.stringify({ loggedIn: false })), null);
  });

  it("asks the CLI for its status with a timeout, no stdin, and no unused API key", () => {
    let seen;
    readAuthStatus((cmd, args, opts) => {
      seen = { cmd, args, opts };
      return "{}";
    }, interactive(REJECTED_KEY));
    assert.equal(seen.opts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(seen.opts.env.CLAUDE_CONFIG_DIR, configDir);
    assert.equal(seen.cmd, "claude");
    assert.deepEqual(seen.args, ["auth", "status"]);
    assert.ok(seen.opts.timeout > 0);
    assert.equal(seen.opts.stdio[0], "ignore");
  });
});

describe("usageDetailFields", () => {
  // A real Claude Code transcript usage object.
  const usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 1032,
    cache_read_input_tokens: 611996,
    output_tokens: 322,
    output_tokens_details: { thinking_tokens: 40 },
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 1032, ephemeral_5m_input_tokens: 0 },
    inference_geo: "global",
    speed: "fast",
  };

  it("maps every reported detail", () => {
    assert.deepEqual(usageDetailFields(usage), {
      tokens_reasoning: 40,
      tokens_cache_creation_1h: 1032,
      service_tier: "standard",
      speed: "fast",
      inference_geo: "global",
      server_tool_use: { web_search_requests: 2 },
    });
  });

  it("drops a share larger than its total", () => {
    const got = usageDetailFields({
      output_tokens: 5,
      output_tokens_details: { thinking_tokens: 9 },
      cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_1h_input_tokens: 11 },
    });
    assert.deepEqual(got, {});
  });

  it("leaves out a string the ingestion API would reject", () => {
    const got = usageDetailFields({ service_tier: "x".repeat(257), speed: "é".repeat(129), inference_geo: "us" });
    assert.deepEqual(got, { inference_geo: "us" });
  });

  it("is empty for a usage object that reports no details", () => {
    assert.deepEqual(usageDetailFields({ input_tokens: 1, output_tokens: 1 }), {});
    assert.deepEqual(usageDetailFields(), {});
  });
});

describe("resolveSessionEndpoint and turnTokenCostFields", () => {
  let observe;
  let dir;
  let savedTmp;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "fd-billing-"));
    savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    observe = await import("../hooks/scripts/observe_cli.mjs");
  });
  after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the CLI once per session and caches the result", () => {
    let calls = 0;
    const probe = () => {
      calls += 1;
      return CLAUDE_AI;
    };
    const sid = "11111111-2222-4333-8444-555555555555";
    const first = observe.resolveSessionEndpoint(sid, { env: {}, probe });
    const second = observe.resolveSessionEndpoint(sid, { env: {}, probe });
    assert.equal(calls, 1);
    assert.deepEqual(first, second);
    assert.equal(first.billingMode, "subscription");
  });

  it("does not run the CLI when FLIGHTDECK_BILLING_MODE settles it", () => {
    let calls = 0;
    const probe = () => {
      calls += 1;
      return API_KEY;
    };
    const got = observe.resolveSessionEndpoint("22222222-2222-4333-8444-555555555555", {
      env: { FLIGHTDECK_BILLING_MODE: "metered", CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global" },
      probe,
    });
    assert.equal(calls, 0);
    assert.deepEqual(got, { billingMode: "metered", platform: "vertex", inferenceScope: "global" });
  });

  it("retries a failed CLI once on a later hook, then keeps the fallback", () => {
    let calls = 0;
    const failing = () => {
      calls += 1;
      return null;
    };
    const sid = "33333333-2222-4333-8444-555555555555";
    const env = { ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
    observe.resolveSessionEndpoint(sid, { env, probe: failing });
    observe.resolveSessionEndpoint(sid, { env, probe: failing });
    const third = observe.resolveSessionEndpoint(sid, { env, probe: failing });
    assert.equal(calls, 2);
    assert.equal(third.billingMode, "metered");
  });

  it("a later hook's successful retry replaces the fallback", () => {
    const sid = "44444444-2222-4333-8444-555555555555";
    observe.resolveSessionEndpoint(sid, { env: {}, probe: () => null });
    const retried = observe.resolveSessionEndpoint(sid, { env: {}, probe: () => API_KEY });
    assert.equal(retried.billingMode, "metered");
    let calls = 0;
    observe.resolveSessionEndpoint(sid, { env: {}, probe: () => { calls += 1; return CLAUDE_AI; } });
    assert.equal(calls, 0, "a probe that succeeded is final");
  });

  it("SessionStart decides afresh, so a new login is picked up", () => {
    const sid = "55555555-2222-4333-8444-555555555555";
    observe.resolveSessionEndpoint(sid, { env: {}, probe: () => API_KEY });
    const refreshed = observe.resolveSessionEndpoint(sid, { env: {}, probe: () => CLAUDE_AI, refresh: true });
    assert.equal(refreshed.billingMode, "subscription");
    assert.equal(observe.resolveSessionEndpoint(sid, { env: {}, probe: () => API_KEY }).billingMode, "subscription");
  });

  it("a refresh whose probe fails keeps the earlier probe's decision", () => {
    const sid = "66666666-2222-4333-8444-555555555555";
    observe.resolveSessionEndpoint(sid, { env: {}, probe: () => API_KEY });
    const kept = observe.resolveSessionEndpoint(sid, { env: {}, probe: () => null, refresh: true });
    assert.equal(kept.billingMode, "metered");
  });

  it("leaves out an oversized model id or stop reason", () => {
    const fields = observe.turnTokenCostFields({ usage: {}, stopReason: "s".repeat(300) }, "m".repeat(300), {
      billingMode: "metered",
      platform: "anthropic",
      inferenceScope: null,
    });
    assert.equal(fields.model_requested, undefined);
    assert.equal(fields.stop_reason, undefined);
  });

  it("builds the post_call fields of a turn", () => {
    const turn = {
      usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: 4 } },
      stopReason: "tool_use",
    };
    const fields = observe.turnTokenCostFields(turn, "claude-opus-5-5", {
      billingMode: "metered",
      platform: "vertex",
      inferenceScope: "regional",
    });
    assert.deepEqual(fields, {
      provider: "anthropic",
      billing_mode: "metered",
      provider_metadata: { platform: "vertex" },
      tokens_reasoning: 4,
      model_requested: "claude-opus-5-5",
      model_served: "claude-opus-5-5",
      inference_scope: "regional",
      stop_reason: "tool_use",
    });
  });
});

describe("readTurns stop reason", () => {
  it("takes the last stop reason a message's records report", async () => {
    const { readTurns } = await import("../hooks/scripts/observe_cli.mjs");
    const dir = mkdtempSync(join(tmpdir(), "fd-turns-"));
    const path = join(dir, "t.jsonl");
    const rec = (stopReason) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-25T07:00:00.000Z",
        message: { id: "msg_1", model: "claude-opus-5-5", stop_reason: stopReason, content: [] },
      });
    writeFileSync(path, [rec(null), rec("tool_use"), rec(null)].join("\n") + "\n");
    const [turn] = readTurns(path);
    assert.equal(turn.stopReason, "tool_use");
    rmSync(dir, { recursive: true, force: true });
  });
});
