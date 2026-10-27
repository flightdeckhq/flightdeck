import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLIENT_TYPE_COLOR,
  CLIENT_TYPE_LABEL,
  CLIENT_TYPE_META,
  CLIENT_TYPE_VALUES,
  isClientType,
} from "@/lib/agent-identity";

// contracts/client_types.json is the one source of the client type
// registry; this copy must match it field for field and in order.
interface RegistryEntry {
  id: string;
  label: string;
  agent_type: string;
  supports_directives: boolean;
  billing_mode: string;
  strips_tool_error_text: boolean;
}
const registry = (
  JSON.parse(
    readFileSync(resolve(__dirname, "../../../contracts/client_types.json"), "utf8"),
  ) as { client_types: RegistryEntry[] }
).client_types;

describe("client type registry", () => {
  it("lists the same client types as contracts/client_types.json, in order", () => {
    expect(CLIENT_TYPE_VALUES).toEqual(registry.map((e) => e.id));
  });

  it("matches every entry's label and defaults", () => {
    for (const e of registry) {
      expect(isClientType(e.id), e.id).toBe(true);
      if (!isClientType(e.id)) continue;
      expect(CLIENT_TYPE_META[e.id], e.id).toEqual({
        label: e.label,
        agentType: e.agent_type,
        supportsDirectives: e.supports_directives,
        billingMode: e.billing_mode,
        stripsToolErrorText: e.strips_tool_error_text,
      });
    }
  });

  it("derives every label from the registry and gives every type a pill colour", () => {
    for (const c of CLIENT_TYPE_VALUES) {
      expect(CLIENT_TYPE_LABEL[c]).toBe(CLIENT_TYPE_META[c].label);
      expect(CLIENT_TYPE_COLOR[c].fg).toMatch(/^var\(--/);
    }
  });

  it("rejects a value outside the registry", () => {
    expect(isClientType("windsurf")).toBe(false);
    expect(isClientType(null)).toBe(false);
  });
});
