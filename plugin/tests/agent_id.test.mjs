// D115: Node twin of sensor/tests/unit/test_agent_id.py. Both files
// assert the same locked fixture vector so a drift between the
// Python and Node implementations fails loudly in CI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NAMESPACE_FLIGHTDECK,
  deriveAgentId,
} from "../hooks/scripts/agent_id.mjs";
import { NAMESPACE_DNS, uuid5 } from "../hooks/scripts/uuid5.mjs";

describe("NAMESPACE_FLIGHTDECK", () => {
  it("is the frozen literal", () => {
    assert.equal(NAMESPACE_FLIGHTDECK, "ee22ab58-26fc-54ef-91b4-b5c0a97f9b61");
  });

  it("is regenerable from uuid5(NAMESPACE_DNS, 'flightdeck.dev')", () => {
    assert.equal(
      uuid5(NAMESPACE_DNS, "flightdeck.dev"),
      NAMESPACE_FLIGHTDECK,
    );
  });
});

describe("deriveAgentId", () => {
  it("fixture vector matches the Python twin", () => {
    const aid = deriveAgentId({
      agent_type: "coding",
      user: "omria",
      hostname: "Omri-PC",
      client_type: "claude_code",
      agent_name: "omria@Omri-PC",
    });
    assert.equal(aid, "ee76931b-06fa-5da6-a019-5a8237efd496");
  });

  it("same inputs produce same uuid", () => {
    const a = deriveAgentId({
      agent_type: "production",
      user: "alice",
      hostname: "worker-1",
      client_type: "flightdeck_sensor",
      agent_name: "ci-runner",
    });
    const b = deriveAgentId({
      agent_type: "production",
      user: "alice",
      hostname: "worker-1",
      client_type: "flightdeck_sensor",
      agent_name: "ci-runner",
    });
    assert.equal(a, b);
  });

  const base = {
    agent_type: "production",
    user: "alice",
    hostname: "worker-1",
    client_type: "flightdeck_sensor",
    agent_name: "ci-runner",
  };
  for (const field of Object.keys(base)) {
    it(`different ${field} produces different uuid`, () => {
      const a = deriveAgentId(base);
      const b = deriveAgentId({ ...base, [field]: `${base[field]}-alt` });
      assert.notEqual(a, b, `${field} permutation collided`);
    });
  }
});
