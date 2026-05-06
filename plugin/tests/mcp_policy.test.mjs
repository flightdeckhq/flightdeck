// D139: tests for plugin/hooks/scripts/mcp_policy.mjs.
//
// Covers fetchPolicies (HTTP path with mocked fetch), evaluateServer
// (D135 algorithm against synthesized policy docs), classifyServer
// (PreToolUse decision-mapping), and the per-session policy cache
// I/O round-trip.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyServer,
  clearSessionPolicyCache,
  evaluateServer,
  fetchPolicies,
  readSessionPolicyCache,
  writeSessionPolicyCache,
} from "../hooks/scripts/mcp_policy.mjs";
import {
  canonicalizeUrl,
  fingerprintShort,
} from "../hooks/scripts/mcp_identity.mjs";

// ----- Fixtures ----------------------------------------------------

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

// ----- evaluateServer (D135 algorithm) -----------------------------

describe("evaluateServer — D135 resolution", () => {
  it("flavor allow entry returns allow / flavor_entry", () => {
    const policies = {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc({
        entries: [policyEntry({ url: "https://x.example.com", name: "x" })],
      }),
    };
    const d = evaluateServer(policies, "https://x.example.com", "x");
    assert.equal(d.decision, "allow");
    assert.equal(d.decisionPath, "flavor_entry");
  });

  it("flavor deny entry returns block by default", () => {
    const policies = {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [
          policyEntry({
            url: "https://x.example.com",
            name: "x",
            kind: "deny",
          }),
        ],
      }),
    };
    const d = evaluateServer(policies, "https://x.example.com", "x");
    assert.equal(d.decision, "block");
    assert.equal(d.decisionPath, "flavor_entry");
  });

  it("flavor deny + warn enforcement returns warn", () => {
    const policies = {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [
          policyEntry({
            url: "https://x.example.com",
            name: "x",
            kind: "deny",
            enforcement: "warn",
          }),
        ],
      }),
    };
    const d = evaluateServer(policies, "https://x.example.com", "x");
    assert.equal(d.decision, "warn");
  });

  it("global entry catches when flavor has no opinion", () => {
    const policies = {
      global: globalDoc({
        entries: [
          policyEntry({
            url: "https://g.example.com",
            name: "g",
            kind: "deny",
            enforcement: "block",
          }),
        ],
      }),
      flavor: flavorDoc(),
    };
    const d = evaluateServer(policies, "https://g.example.com", "g");
    assert.equal(d.decisionPath, "global_entry");
    assert.equal(d.decision, "block");
  });

  it("flavor overrides global for same URL+name", () => {
    const url = "https://shared.example.com";
    const name = "shared";
    const policies = {
      global: globalDoc({
        entries: [
          policyEntry({ url, name, kind: "deny", enforcement: "block" }),
        ],
      }),
      flavor: flavorDoc({
        entries: [policyEntry({ url, name, kind: "allow" })],
      }),
    };
    const d = evaluateServer(policies, url, name);
    assert.equal(d.decision, "allow");
    assert.equal(d.decisionPath, "flavor_entry");
  });

  it("mode_default allowlist blocks unmatched", () => {
    const policies = {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    };
    const d = evaluateServer(policies, "https://unknown.example.com", "u");
    assert.equal(d.decision, "block");
    assert.equal(d.decisionPath, "mode_default");
  });

  it("mode_default blocklist allows unmatched", () => {
    const policies = {
      global: globalDoc({ mode: "blocklist" }),
      flavor: flavorDoc(),
    };
    const d = evaluateServer(policies, "https://unknown.example.com", "u");
    assert.equal(d.decision, "allow");
    assert.equal(d.decisionPath, "mode_default");
  });

  it("empty policies object falls open to allow", () => {
    const policies = { global: null, flavor: null };
    const d = evaluateServer(policies, "https://x.example.com", "x");
    assert.equal(d.decision, "allow");
    assert.equal(d.scope, "fail_open");
  });

  it("canonicalizes the input URL before fingerprint lookup", () => {
    // Policy stored with one form; agent passes a different cosmetic
    // variant that canonicalizes to the same value.
    const policies = {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc({
        entries: [
          policyEntry({
            url: "https://Maps.Example.COM:443/SSE",
            name: "maps",
          }),
        ],
      }),
    };
    const d = evaluateServer(
      policies, "HTTPS://maps.example.com:443/SSE", "maps",
    );
    assert.equal(d.decision, "allow");
  });
});

// ----- classifyServer (PreToolUse decision mapping) ---------------

describe("classifyServer — PreToolUse mapping", () => {
  it("allow entry → classification 'allow'", () => {
    const policies = {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [policyEntry({ url: "https://a", name: "a" })],
      }),
    };
    assert.equal(classifyServer(policies, "https://a", "a").classification, "allow");
  });

  it("block decision → classification 'block'", () => {
    const policies = {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [
          policyEntry({
            url: "https://b", name: "b", kind: "deny", enforcement: "block",
          }),
        ],
      }),
    };
    assert.equal(classifyServer(policies, "https://b", "b").classification, "block");
  });

  it("warn decision → classification 'warn'", () => {
    const policies = {
      global: globalDoc(),
      flavor: flavorDoc({
        entries: [
          policyEntry({
            url: "https://w", name: "w", kind: "deny", enforcement: "warn",
          }),
        ],
      }),
    };
    assert.equal(classifyServer(policies, "https://w", "w").classification, "warn");
  });

  it("unknown server in allowlist mode → classification 'ask'", () => {
    const policies = {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    };
    const c = classifyServer(policies, "https://unknown", "u");
    assert.equal(c.classification, "ask");
    assert.equal(c.decision.decisionPath, "mode_default");
  });

  it("unknown server in blocklist mode → classification 'allow'", () => {
    const policies = {
      global: globalDoc({ mode: "blocklist" }),
      flavor: flavorDoc(),
    };
    assert.equal(
      classifyServer(policies, "https://unknown", "u").classification,
      "allow",
    );
  });
});

// ----- fetchPolicies (HTTP, mocked fetch) -------------------------

describe("fetchPolicies — HTTP path", () => {
  let savedFetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  function mockFetch(handler) {
    globalThis.fetch = async (url, opts) => handler(String(url), opts);
  }

  it("fetches global + flavor in parallel, returns both", async () => {
    const calls = [];
    mockFetch(async (url) => {
      calls.push(url);
      const isGlobal = url.endsWith("/global");
      const body = isGlobal
        ? globalDoc({ mode: "allowlist" })
        : flavorDoc({ scopeValue: "prod" });
      return {
        ok: true,
        status: 200,
        json: async () => body,
      };
    });
    const result = await fetchPolicies(
      "http://localhost:4000/api", "tok", "prod",
    );
    assert.equal(calls.length, 2);
    assert.equal(result.global?.scope, "global");
    assert.equal(result.flavor?.scope_value, "prod");
  });

  it("404 on flavor returns null flavor with global populated", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/global")) {
        return {
          ok: true, status: 200,
          json: async () => globalDoc({ mode: "blocklist" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const result = await fetchPolicies(
      "http://localhost:4000/api", "tok", "missing",
    );
    assert.notEqual(result.global, null);
    assert.equal(result.flavor, null);
  });

  it("network error on both returns fail-open empty", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await fetchPolicies(
      "http://localhost:4000/api", "tok", "any",
    );
    assert.equal(result.global, null);
    assert.equal(result.flavor, null);
  });

  it("null flavor skips the flavor fetch entirely", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return {
        ok: true, status: 200,
        json: async () => globalDoc(),
      };
    });
    await fetchPolicies("http://localhost:4000/api", "tok", null);
    assert.equal(calls, 1, "flavor=null should skip the second GET");
  });

  it("non-200 status (e.g. 500) is treated as fail-open", async () => {
    mockFetch(async () => ({
      ok: false, status: 500, json: async () => ({}),
    }));
    const result = await fetchPolicies("http://x", "tok", "f");
    assert.equal(result.global, null);
    assert.equal(result.flavor, null);
  });
});

// ----- Per-session policy cache I/O ------------------------------

describe("per-session policy cache I/O", () => {
  let scratchDir;
  let savedTmp;

  before(() => {
    // Force the cache into a scratch dir so concurrent test runs
    // don't collide with developer state under /tmp.
    scratchDir = mkdtempSync(join(tmpdir(), "fdmcp-test-"));
    savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = scratchDir;
  });

  after(() => {
    if (savedTmp === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = savedTmp;
    }
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("write then read round-trips", () => {
    const sid = "sess-cache-1";
    const policies = {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc(),
    };
    writeSessionPolicyCache(sid, policies);
    const read = readSessionPolicyCache(sid);
    assert.equal(read?.global?.mode, "allowlist");
    assert.equal(read?.flavor?.scope_value, "production");
    clearSessionPolicyCache(sid);
  });

  it("read missing file returns null", () => {
    assert.equal(readSessionPolicyCache("sess-cache-missing"), null);
  });

  it("read corrupted JSON returns null (no crash)", () => {
    const sid = "sess-cache-corrupt";
    // Compute the path the cache writer would use, then write
    // garbage instead of valid JSON.
    const fakePath = join(
      tmpdir(), "flightdeck-plugin", `mcp-policy-${sid}.json`,
    );
    try {
      writeFileSync(fakePath, "{not json", "utf8");
    } catch {
      // mkdirSync chain handles missing parent in writeSessionPolicyCache;
      // we use that helper to ensure the dir exists.
      writeSessionPolicyCache("dummy", { global: null, flavor: null });
      writeFileSync(fakePath, "{not json", "utf8");
    }
    const read = readSessionPolicyCache(sid);
    assert.equal(read, null);
    clearSessionPolicyCache(sid);
  });

  it("clear removes the file", () => {
    const sid = "sess-cache-clear";
    writeSessionPolicyCache(sid, { global: globalDoc(), flavor: null });
    clearSessionPolicyCache(sid);
    assert.equal(readSessionPolicyCache(sid), null);
  });

  it("two sessions get distinct cache files", () => {
    const a = "sess-cache-a";
    const b = "sess-cache-b";
    writeSessionPolicyCache(a, {
      global: globalDoc({ mode: "allowlist" }), flavor: null,
    });
    writeSessionPolicyCache(b, {
      global: globalDoc({ mode: "blocklist" }), flavor: null,
    });
    assert.equal(readSessionPolicyCache(a)?.global?.mode, "allowlist");
    assert.equal(readSessionPolicyCache(b)?.global?.mode, "blocklist");
    clearSessionPolicyCache(a);
    clearSessionPolicyCache(b);
  });
});

// ----- D135 ordering invariants ----------------------------------

describe("D135 ordering invariants", () => {
  it("flavor entry takes precedence over global mode default", () => {
    // Global allowlist mode would normally block any unlisted server.
    // The flavor's explicit allow entry wins step 1.
    const policies = {
      global: globalDoc({ mode: "allowlist" }),
      flavor: flavorDoc({
        entries: [policyEntry({ url: "https://allowed", name: "a" })],
      }),
    };
    assert.equal(
      evaluateServer(policies, "https://allowed", "a").decision,
      "allow",
    );
    assert.equal(
      evaluateServer(policies, "https://other", "o").decision,
      "block",
    );
  });

  it("global entry takes precedence over global mode default", () => {
    // Global blocklist mode would normally allow unlisted servers.
    // The global's explicit deny entry wins step 2.
    const policies = {
      global: globalDoc({
        mode: "blocklist",
        entries: [
          policyEntry({
            url: "https://denied", name: "d",
            kind: "deny", enforcement: "block",
          }),
        ],
      }),
      flavor: flavorDoc(),
    };
    assert.equal(
      evaluateServer(policies, "https://denied", "d").decision,
      "block",
    );
    assert.equal(
      evaluateServer(policies, "https://other", "o").decision,
      "allow",
    );
  });
});
