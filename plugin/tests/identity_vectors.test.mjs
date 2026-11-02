// The plugin reproduces contracts/identity_vectors.json, the identity
// derivation vectors generated from the Python sensor. The Go ingestion
// port (ingestion/internal/identity) asserts the same file, so the three
// implementations cannot drift apart unnoticed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NAMESPACE_FLIGHTDECK, deriveAgentId, trimRole } from "../hooks/scripts/agent_id.mjs";
import { uuid5 } from "../hooks/scripts/uuid5.mjs";

const vectors = JSON.parse(
  readFileSync(new URL("../../contracts/identity_vectors.json", import.meta.url), "utf8"),
);

describe("contracts/identity_vectors.json", () => {
  it("names the plugin's namespace", () => {
    assert.equal(vectors.namespace_flightdeck, NAMESPACE_FLIGHTDECK);
  });

  it("uuid5 reproduces every vector", () => {
    assert.ok(vectors.uuid5.length > 0);
    for (const v of vectors.uuid5) {
      assert.equal(uuid5(v.namespace, v.name), v.uuid, v.name);
    }
  });

  it("trimRole removes exactly what the sensor's str.strip() removes", () => {
    const want = new Set(vectors.role_trim_code_points);
    assert.ok(want.size > 0);
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const trimmed = trimRole(`a${String.fromCodePoint(cp)}`) === "a";
      assert.equal(trimmed, want.has(cp), `U+${cp.toString(16).padStart(4, "0")}`);
    }
  });

  it("deriveAgentId reproduces every vector", () => {
    assert.ok(vectors.agent_id.length > 0);
    for (const v of vectors.agent_id) {
      const { agent_id: want, ...input } = v;
      assert.equal(deriveAgentId(input), want, JSON.stringify(input));
    }
  });
});
