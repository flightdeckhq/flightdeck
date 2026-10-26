import { describe, it, expect } from "vitest";
import { getSummaryRows } from "@/lib/events";
import type { AgentEvent } from "@/lib/types";

const base: AgentEvent = {
  id: "e1",
  session_id: "s1",
  flavor: "f",
  event_type: "post_call",
  model: "claude-sonnet-4-5-20250929",
  tokens_input: 2400,
  tokens_output: 900,
  tokens_total: 3300,
  latency_ms: 5200,
  tool_name: null,
  has_content: false,
  framework: null,
  client_type: "flightdeck_sensor",
  agent_type: "production",
  occurred_at: "2026-10-26T00:00:00Z",
};

const BASE_ROWS = ["Model", "Tokens input", "Tokens output", "Total tokens", "Latency"];

const labels = (event: AgentEvent) => getSummaryRows(event).map(([k]) => k);
const row = (event: AgentEvent, label: string) =>
  getSummaryRows(event).find(([k]) => k === label)?.[1];

describe("getSummaryRows — per-call detail on post_call", () => {
  it("renders every per-call field the client reported, in order", () => {
    const event: AgentEvent = {
      ...base,
      tokens_cache_read: 1800,
      tokens_cache_creation: 600,
      tokens_reasoning: 300,
      model_requested: "anthropic/claude-sonnet-4-5",
      model_served: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      billing_mode: "metered",
      platform: "anthropic",
      cost_reported: 0.0412,
      cost_source: "agent",
      payload: {
        tokens_cache_creation_1h: 400,
        stop_reason: "end_turn",
        service_tier: "standard",
        speed: "fast",
        inference_geo: "us",
        inference_scope: "global",
        server_tool_use: { web_search_requests: 2, code_execution_requests: 1 },
      },
    };
    expect(getSummaryRows(event).slice(BASE_ROWS.length)).toEqual([
      ["Cache read", "1,800"],
      ["Cache write", "600 · 400 for 1h"],
      ["Reasoning tokens", "300"],
      ["Stop reason", "end_turn"],
      ["Server tools", "2 web searches · 1 code execution"],
      ["Model requested", "anthropic/claude-sonnet-4-5"],
      ["Billing", "Metered"],
      ["Platform", "anthropic"],
      ["Service tier", "standard"],
      ["Speed", "fast"],
      ["Inference geo", "us"],
      ["Inference scope", "global"],
      ["Reported cost", "$0.041 · computed by the client"],
    ]);
  });

  it("keeps the base rows alone for a call that reports none of the fields", () => {
    expect(labels(base)).toEqual(BASE_ROWS);
    expect(
      labels({
        ...base,
        tokens_cache_read: 0,
        tokens_cache_creation: 0,
        tokens_reasoning: 0,
        model_requested: base.model,
        model_served: base.model,
        cost_reported: null,
        payload: { server_tool_use: { web_search_requests: 0 } },
      }),
    ).toEqual(BASE_ROWS);
  });

  it("shows a cache write without a 1h split, and a served id canonicalising changed", () => {
    // A Bedrock response names the cloud-prefixed id; the worker
    // stores its canonical form in `model`.
    const event: AgentEvent = {
      ...base,
      model: "claude-sonnet-4-5-20250929",
      tokens_cache_creation: 600,
      model_requested: "claude-sonnet-4-5-20250929",
      model_served: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    };
    expect(row(event, "Cache write")).toBe("600");
    expect(row(event, "Model served")).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(row(event, "Model requested")).toBeUndefined();
  });

  it("gives an embeddings call the serving, billing and cost rows", () => {
    const event: AgentEvent = {
      ...base,
      event_type: "embeddings",
      model: "text-embedding-3-small",
      tokens_output: null,
      tokens_total: null,
      tokens_cache_read: 0,
      billing_mode: "metered",
      platform: "openai",
      cost_reported: 0.0002,
      cost_source: "provider",
      payload: { stop_reason: "ignored on embeddings" },
    };
    expect(labels(event)).toEqual([
      "Model",
      "Tokens input",
      "Latency",
      "Billing",
      "Platform",
      "Reported cost",
    ]);
    expect(row(event, "Reported cost")).toBe("<$0.001 · reported by the provider");
  });

  it("labels the billing mode and cost source, and keeps a zero reported cost", () => {
    expect(row({ ...base, billing_mode: "subscription" }, "Billing")).toBe("Subscription");
    expect(row({ ...base, billing_mode: "local" }, "Billing")).toBe("Local");
    expect(
      row({ ...base, cost_reported: 0, cost_source: "provider" }, "Reported cost"),
    ).toBe("$0.00 · reported by the provider");
    expect(row({ ...base, payload: { server_tool_use: { web_fetch_requests: 1 } } }, "Server tools")).toBe(
      "1 web fetch",
    );
  });
});
