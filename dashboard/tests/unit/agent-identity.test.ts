import { describe, it, expect } from "vitest";
import {
  ClientType,
  clientIncursMeteredCost,
} from "@/lib/agent-identity";

describe("clientIncursMeteredCost", () => {
  it("returns true for the Flightdeck sensor client", () => {
    // The sensor instruments application code that calls metered LLM
    // APIs (Anthropic / OpenAI / etc.) directly; per-call cost is
    // attributable from the pricing table, so cost UI is meaningful.
    expect(clientIncursMeteredCost(ClientType.FlightdeckSensor)).toBe(true);
  });

  it("returns false for the Claude Code client", () => {
    // Claude Code bills on an Anthropic subscription independently
    // of per-call usage; Flightdeck has no per-call cost to attribute.
    expect(clientIncursMeteredCost(ClientType.ClaudeCode)).toBe(false);
  });

  it("returns false for null / undefined", () => {
    // Defensive default: unknown client_type renders as subscription-
    // style (cost suppressed) rather than silently surfacing a
    // meaningless number.
    expect(clientIncursMeteredCost(null)).toBe(false);
    expect(clientIncursMeteredCost(undefined)).toBe(false);
  });

  it("returns false for any future client_type by default", () => {
    // Cast through ``unknown`` to simulate a hypothetical future
    // ClientType the predicate has not yet been updated to
    // recognise. The contract is "subscription-style unless
    // explicitly opted in", so the predicate must answer false.
    const futureClient = "codex" as unknown as ClientType;
    expect(clientIncursMeteredCost(futureClient)).toBe(false);
  });
});
