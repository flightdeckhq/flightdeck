// Billing mode, platform and usage-detail fields of the Claude Code
// plugin (hooks/scripts/billing.mjs and the post_call fields built from
// them in observe_cli.mjs).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  detectEndpoint,
  readAuthStatus,
  usageDetailFields,
} from "../hooks/scripts/billing.mjs";

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
    ["no CLI, API key set", { ANTHROPIC_API_KEY: "sk" }, null, "metered", "anthropic"],
    ["no CLI, auth token set", { ANTHROPIC_AUTH_TOKEN: "t" }, null, "metered", "anthropic"],
    ["no CLI, nothing set", {}, null, "subscription", "anthropic"],
    ["override wins", { FLIGHTDECK_BILLING_MODE: " Metered " }, CLAUDE_AI, "metered", "anthropic"],
    ["override to local", { FLIGHTDECK_BILLING_MODE: "local" }, API_KEY, "local", "anthropic"],
    ["an invalid override is ignored", { FLIGHTDECK_BILLING_MODE: "free" }, CLAUDE_AI, "subscription", "anthropic"],
    ["a gateway base URL reports its host", { ANTHROPIC_BASE_URL: "https://gw.example.com/v1" }, API_KEY, "metered", "gw.example.com"],
    ["an Anthropic base URL stays anthropic", { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, API_KEY, "metered", "anthropic"],
    ["a look-alike host stays bare", { ANTHROPIC_BASE_URL: "https://evilanthropic.com" }, API_KEY, "metered", "evilanthropic.com"],
    ["a malformed base URL is invalid-host", { ANTHROPIC_BASE_URL: "::not a url" }, API_KEY, "metered", "invalid-host"],
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

  it("asks the CLI for its status with a timeout and no stdin", () => {
    let seen;
    readAuthStatus((cmd, args, opts) => {
      seen = { cmd, args, opts };
      return "{}";
    });
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
    const first = observe.resolveSessionEndpoint(sid, {}, probe);
    const second = observe.resolveSessionEndpoint(sid, {}, probe);
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
    const got = observe.resolveSessionEndpoint(
      "22222222-2222-4333-8444-555555555555",
      { FLIGHTDECK_BILLING_MODE: "metered", CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global" },
      probe,
    );
    assert.equal(calls, 0);
    assert.deepEqual(got, { billingMode: "metered", platform: "vertex", inferenceScope: "global" });
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
