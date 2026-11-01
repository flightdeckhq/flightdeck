// The plugin reproduces contracts/identity_vectors.json, the identity
// derivation vectors generated from the Python sensor. The Go ingestion
// port (ingestion/internal/identity) asserts the same file, so the three
// implementations cannot drift apart unnoticed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NAMESPACE_FLIGHTDECK, deriveAgentId } from "../hooks/scripts/agent_id.mjs";
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

  it("deriveAgentId reproduces every vector", () => {
    assert.ok(vectors.agent_id.length > 0);
    for (const v of vectors.agent_id) {
      const { agent_id: want, ...input } = v;
      assert.equal(deriveAgentId(input), want, JSON.stringify(input));
    }
  });
});
