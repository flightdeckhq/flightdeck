// D127: Node twin of sensor/tests/unit/test_mcp_identity.py. Both
// files load the same cross-language fixture vectors so a drift
// between the Python and Node implementations fails loudly in CI.
//
// Plus standalone tests for edge cases not in fixtures: empty
// inputs, Unicode in name, type errors. See DECISIONS.md D127.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalizeUrl,
  fingerprint,
  fingerprintShort,
} from "../hooks/scripts/mcp_identity.mjs";

// Locate the cross-language fixture file relative to this test
// file. `import.meta.url` is `.../plugin/tests/mcp_identity.test.mjs`;
// the fixture lives at `<repo>/tests/fixtures/mcp_identity_vectors.json`.
const VECTORS_URL = new URL(
  "../../tests/fixtures/mcp_identity_vectors.json",
  import.meta.url,
);
const VECTORS_DOC = JSON.parse(readFileSync(VECTORS_URL, "utf8"));
const VECTORS = VECTORS_DOC.vectors;

// Save / restore process.env so the env-var-resolution vectors run
// against the same overrides the Python suite uses.
const SAVED_ENV = {};

before(() => {
  for (const [key, val] of Object.entries(VECTORS_DOC.env_overrides)) {
    SAVED_ENV[key] = process.env[key];
    process.env[key] = val;
  }
  // Ensure the missing-var vector's variable really is missing so
  // the "stays literal" assertion is deterministic.
  SAVED_ENV.FLIGHTDECK_TEST_MISSING = process.env.FLIGHTDECK_TEST_MISSING;
  delete process.env.FLIGHTDECK_TEST_MISSING;
});

after(() => {
  for (const [key, val] of Object.entries(SAVED_ENV)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

describe("cross-language vectors", () => {
  for (const vec of VECTORS) {
    describe(vec.id, () => {
      it("canonicalizeUrl matches fixture", () => {
        assert.equal(canonicalizeUrl(vec.raw_url), vec.canonical_url);
      });

      it("fingerprint full matches fixture", () => {
        assert.equal(
          fingerprint(vec.canonical_url, vec.name),
          vec.fingerprint_full,
        );
      });

      it("fingerprint short matches fixture", () => {
        assert.equal(
          fingerprintShort(vec.canonical_url, vec.name),
          vec.fingerprint_short,
        );
      });
    });
  }
});

describe("standalone edge cases", () => {
  it("empty input is treated as stdio with empty body", () => {
    assert.equal(canonicalizeUrl(""), "stdio://");
  });

  it("whitespace-only input collapses to empty stdio body", () => {
    assert.equal(canonicalizeUrl("   \t  \n "), "stdio://");
  });

  it("explicit stdio:// prefix is not double-prefixed", () => {
    assert.equal(
      canonicalizeUrl("stdio://npx package"),
      "stdio://npx package",
    );
  });

  it("0x00 separator prevents collision between (a.com,bservice) and (a.combservice,'')", () => {
    const a = fingerprint("https://a.com", "bservice");
    const b = fingerprint("https://a.combservice", "");
    assert.notEqual(a, b);
  });

  it("Unicode name hashes deterministically", () => {
    const canon = "https://example.com";
    const one = fingerprint(canon, "ñame");
    const two = fingerprint(canon, "ñame");
    assert.equal(one, two);
    assert.equal(one.length, 64);
  });

  it("fingerprintShort is the 16-char prefix of fingerprint", () => {
    const canon = "https://example.com/api";
    const name = "test";
    assert.equal(
      fingerprintShort(canon, name),
      fingerprint(canon, name).slice(0, 16),
    );
  });

  it("canonicalizeUrl rejects non-string input", () => {
    assert.throws(() => canonicalizeUrl(null), TypeError);
    assert.throws(() => canonicalizeUrl(42), TypeError);
  });

  it("fingerprint rejects non-string canonicalUrl", () => {
    assert.throws(() => fingerprint(null, "name"), TypeError);
  });

  it("fingerprint rejects non-string name", () => {
    assert.throws(() => fingerprint("https://example.com", null), TypeError);
  });

  it("HTTP default port :80 strips on http:// (mirrors fixture's :443 case)", () => {
    assert.equal(
      canonicalizeUrl("http://example.com:80/api"),
      "http://example.com/api",
    );
  });

  it("$VAR (no braces) env-var resolves the same way as ${VAR}", () => {
    process.env.FLIGHTDECK_TEST_DOLLAR_FORM = "/x";
    try {
      assert.equal(
        canonicalizeUrl("cmd $FLIGHTDECK_TEST_DOLLAR_FORM/data"),
        "stdio://cmd /x/data",
      );
    } finally {
      delete process.env.FLIGHTDECK_TEST_DOLLAR_FORM;
    }
  });
});
