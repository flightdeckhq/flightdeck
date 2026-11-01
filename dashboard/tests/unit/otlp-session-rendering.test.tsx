import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelemetrySourcePill } from "@/components/facets/TelemetrySourcePill";
import {
  clientSourceLabel,
  isOtlpSession,
  isOtlpTelemetry,
} from "@/lib/agent-identity";
import { sessionSupportsDirectives } from "@/lib/directives";
import { getEventDetail, getSummaryRows } from "@/lib/events";
import { getClaudeCodeVersion, isClaudeCodeSession } from "@/lib/models";
import type { AgentEvent } from "@/lib/types";

// How a Claude Code session reported over OpenTelemetry renders: the
// shapes come from what ingestion's Claude Code dialect stores (the
// synthetic session_start's context; a prompt with no model; an
// api_request as a post_call with the agent-reported cost, a streaming
// block holding only TTFT and the outcome, and the request id and
// query source as provider metadata).

const OTLP_CONTEXT = {
  claude_code_session_id: "9abf767b-b5e5-4517-b714-b6da94fe4b65",
  claude_code_version: "2.1.316",
  os: "linux",
  arch: "amd64",
  terminal_type: "wsl-Ubuntu",
  telemetry: "otlp",
  supports_directives: false,
};

function event(fields: Partial<AgentEvent>): AgentEvent {
  return {
    id: "evt-1",
    session_id: "00000000-0000-0000-0000-000000000001",
    flavor: "claude-code",
    event_type: "post_call",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-11-01T10:00:00Z",
    ...fields,
  } as AgentEvent;
}

describe("OTLP source label", () => {
  it("recognises the otlp telemetry value only", () => {
    expect(isOtlpTelemetry("otlp")).toBe(true);
    expect(isOtlpTelemetry(undefined)).toBe(false);
    expect(isOtlpTelemetry("hook")).toBe(false);
    expect(isOtlpSession({ context: OTLP_CONTEXT })).toBe(true);
    expect(isOtlpSession({ context: { supports_directives: false } })).toBe(false);
    expect(isOtlpSession({})).toBe(false);
  });

  it("names Claude Code via OpenTelemetry apart from Claude Code via plugin", () => {
    expect(clientSourceLabel("claude_code", "otlp")).toBe(
      "Claude Code via OpenTelemetry",
    );
    expect(clientSourceLabel("claude_code", undefined)).toBe("Claude Code via plugin");
    expect(clientSourceLabel("flightdeck_sensor", null)).toBe("Sensor");
    expect(clientSourceLabel(null, "otlp")).toBe("via OpenTelemetry");
    expect(clientSourceLabel("not-a-client", null)).toBeNull();
  });

  it("the OTel pill renders for an OTLP source and says the session observes only", () => {
    render(
      <TelemetrySourcePill telemetry="otlp" clientType="claude_code" testId="pill" />,
    );
    const pill = screen.getByTestId("pill");
    expect(pill).toHaveTextContent("OTel");
    expect(pill.getAttribute("data-telemetry")).toBe("otlp");
    expect(pill.getAttribute("title")).toBe(
      "Claude Code via OpenTelemetry: observe only, no directives reach it",
    );
  });

  it("the OTel pill renders nothing for any other source", () => {
    const { container } = render(
      <>
        <TelemetrySourcePill telemetry={undefined} clientType="claude_code" />
        <TelemetrySourcePill telemetry={null} clientType="flightdeck_sensor" />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("OTLP session identity", () => {
  it("is a Claude Code session by client_type even under a custom flavor", () => {
    expect(
      isClaudeCodeSession({ client_type: "claude_code", flavor: "ci-runs", context: OTLP_CONTEXT }),
    ).toBe(true);
    expect(isClaudeCodeSession({ client_type: "flightdeck_sensor", flavor: "ci-runs" })).toBe(
      false,
    );
  });

  it("reads its Claude Code version from claude_code_version", () => {
    expect(getClaudeCodeVersion({ context: OTLP_CONTEXT })).toBe("2.1.316");
    // The plugin's frameworks entry still works.
    expect(getClaudeCodeVersion({ context: { frameworks: ["claude-code/2.0.1"] } })).toBe(
      "2.0.1",
    );
  });

  it("takes no directives", () => {
    expect(
      sessionSupportsDirectives({ client_type: "claude_code", flavor: "ci-runs", context: OTLP_CONTEXT }),
    ).toBe(false);
  });
});

describe("OTLP event shapes", () => {
  it("a prompt with no model shows no model, never 'unknown'", () => {
    const prompt = event({ event_type: "pre_call", model: null });
    expect(getEventDetail(prompt)).toBe("—");
    expect(getSummaryRows(prompt)).toEqual([["Model", "—"]]);
    const blank = event({ event_type: "pre_call", model: "" });
    expect(getEventDetail(blank)).toBe("—");
    expect(getSummaryRows(blank)).toEqual([["Model", "—"]]);
  });

  it("a prompt that names a model still leads with it", () => {
    const prompt = event({ event_type: "pre_call", model: "claude-sonnet-4-5" });
    expect(getEventDetail(prompt)).toBe("claude-sonnet-4-5");
    expect(getSummaryRows(prompt)).toEqual([["Model", "claude-sonnet-4-5"]]);
  });

  it("a post_call with TTFT, agent cost and request metadata renders every field it has", () => {
    const call = event({
      event_type: "post_call",
      model: "claude-haiku-4-5-20251001",
      model_requested: "claude-haiku-4-5-20251001",
      model_served: "claude-haiku-4-5-20251001",
      tokens_input: 74000,
      tokens_output: 107,
      tokens_total: 74107,
      latency_ms: 2300,
      billing_mode: "subscription",
      cost_reported: 0.0173255,
      cost_source: "agent",
      payload: {
        streaming: { ttft_ms: 935, final_outcome: "completed" },
        provider_metadata: { request_id: "req_011Cgc", query_source: "sdk" },
      },
    } as Partial<AgentEvent>);
    expect(getEventDetail(call)).toBe(
      "claude-haiku-4-5-20251001 · TTFT 935ms · 74,107 tok · 2300ms",
    );
    const rows = Object.fromEntries(getSummaryRows(call));
    expect(rows["TTFT"]).toBe("935ms");
    expect(rows["Stream outcome"]).toBe("completed");
    // Claude Code reports no chunk statistics: no rows for them.
    expect(rows["Chunks"]).toBeUndefined();
    expect(rows["Inter-chunk"]).toBeUndefined();
    expect(rows["Billing"]).toBe("Subscription");
    expect(rows["Reported cost"]).toMatch(/^\$0\.017.* · computed by the client$/);
    // model_requested / model_served equal model: no duplicate rows.
    expect(rows["Model requested"]).toBeUndefined();
  });

  it("a streaming block with a null TTFT renders the outcome alone", () => {
    const call = event({
      event_type: "post_call",
      model: "claude-haiku-4-5",
      payload: { streaming: { ttft_ms: null, final_outcome: "completed" } },
    } as Partial<AgentEvent>);
    expect(getEventDetail(call)).toBe("claude-haiku-4-5");
    const rows = Object.fromEntries(getSummaryRows(call));
    expect(rows["TTFT"]).toBeUndefined();
    expect(rows["Stream outcome"]).toBe("completed");
  });
});
