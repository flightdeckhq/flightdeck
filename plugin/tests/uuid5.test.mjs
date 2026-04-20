// Test vectors were regenerated from Python 3's `uuid` module (the
// widely-used canonical implementation) after the initial
// specification values did not match any conforming implementation.
// Cite Python's uuid module as the reference for the expected outputs:
//
//   python3 -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org'))"
//   python3 -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, 'http://python.org/'))"

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NAMESPACE_DNS,
  NAMESPACE_URL,
  uuid5,
} from "../hooks/scripts/uuid5.mjs";

describe("uuid5 (version 5, SHA-1 name-based UUID)", () => {
  it("Python-canonical vector: NAMESPACE_DNS + python.org", () => {
    assert.equal(
      uuid5(NAMESPACE_DNS, "python.org"),
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("Python-canonical vector: NAMESPACE_URL + http://python.org/", () => {
    assert.equal(
      uuid5(NAMESPACE_URL, "http://python.org/"),
      "4c565f0d-3f5a-5890-b41b-20cf47701c5e",
    );
  });

  it("version nibble is 5 (position 14)", () => {
    const u = uuid5(NAMESPACE_URL, "flightdeck-test");
    assert.equal(u[14], "5", `expected '5' at position 14, got ${JSON.stringify(u)}`);
  });

  it("variant nibble is 8, 9, a, or b", () => {
    const u = uuid5(NAMESPACE_URL, "flightdeck-test");
    assert.match(u[19], /[89ab]/);
  });

  it("output format is 36 chars with hyphens at 8, 13, 18, 23", () => {
    const u = uuid5(NAMESPACE_URL, "flightdeck-test");
    assert.equal(u.length, 36);
    assert.equal(u[8], "-");
    assert.equal(u[13], "-");
    assert.equal(u[18], "-");
    assert.equal(u[23], "-");
  });

  it("is deterministic: same inputs produce same output", () => {
    const key = "flightdeck://alice@laptop/https://github.com/foo/bar.git@main";
    assert.equal(uuid5(NAMESPACE_URL, key), uuid5(NAMESPACE_URL, key));
  });

  it("different names produce different outputs", () => {
    assert.notEqual(uuid5(NAMESPACE_URL, "a"), uuid5(NAMESPACE_URL, "b"));
  });

  it("different namespaces produce different outputs for the same name", () => {
    assert.notEqual(
      uuid5(NAMESPACE_DNS, "example.com"),
      uuid5(NAMESPACE_URL, "example.com"),
    );
  });

  it("accepts UTF-8 names with non-ASCII characters", () => {
    const u = uuid5(NAMESPACE_URL, "héllo-wörld");
    assert.equal(u.length, 36);
    assert.equal(u[14], "5");
    assert.match(u[19], /[89ab]/);
  });

  it("rejects malformed namespace strings", () => {
    assert.throws(() => uuid5("not-a-uuid", "name"), TypeError);
    assert.throws(() => uuid5("", "name"), TypeError);
    assert.throws(() => uuid5("6ba7b811-9dad-11d1-80b4", "name"), TypeError);
  });
});
