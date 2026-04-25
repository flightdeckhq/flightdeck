/**
 * Policy enforcement event rendering tests.
 *
 * Covers the three policy event types — policy_warn, policy_degrade,
 * policy_block — across the lib/events helpers (detail string,
 * summary rows) and the new <PolicyEventDetails /> component.
 *
 * Pairs with the sensor unit suite (test_policy_events.py) and the
 * T17 E2E spec.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { eventBadgeConfig, getEventDetail, getSummaryRows } from "@/lib/events";
import type { AgentEvent, EventPayloadFields } from "@/lib/types";
import { PolicyEventDetails } from "@/components/session/PolicyEventDetails";

function makeEvent(
  event_type: AgentEvent["event_type"],
  payload?: EventPayloadFields,
): AgentEvent {
  return {
    id: "ev-1",
    session_id: "sess-1",
    flavor: "test",
    event_type,
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-04-25T10:00:00Z",
    payload,
  };
}

describe("eventBadgeConfig — policy event labels and CSS vars", () => {
  it("policy_warn / policy_block / policy_degrade are registered", () => {
    expect(eventBadgeConfig.policy_warn.label).toBe("WARN");
    expect(eventBadgeConfig.policy_block.label).toBe("BLOCK");
    expect(eventBadgeConfig.policy_degrade.label).toBe("DEGRADE");

    expect(eventBadgeConfig.policy_warn.cssVar).toContain("--event-warn");
    expect(eventBadgeConfig.policy_block.cssVar).toContain("--event-block");
    expect(eventBadgeConfig.policy_degrade.cssVar).toContain("--event-degrade");
  });
});

describe("getEventDetail — policy event detail strings", () => {
  it("policy_warn renders threshold + token math when payload populated", () => {
    const ev = makeEvent("policy_warn", {
      source: "server",
      threshold_pct: 80,
      tokens_used: 8000,
      token_limit: 10000,
    });
    expect(getEventDetail(ev)).toBe(
      "warn at 80% · 8,000 of 10,000 tokens",
    );
  });

  it("policy_warn falls back to short copy when payload missing", () => {
    expect(getEventDetail(makeEvent("policy_warn"))).toBe("warned at threshold");
  });

  it("policy_block surfaces tokens used vs limit", () => {
    const ev = makeEvent("policy_block", {
      source: "server",
      threshold_pct: 100,
      tokens_used: 10100,
      token_limit: 10000,
      intended_model: "claude-sonnet-4-6",
    });
    expect(getEventDetail(ev)).toBe(
      "blocked at 10,100 of 10,000 tokens",
    );
  });

  it("policy_degrade renders from→to when both models populated", () => {
    const ev = makeEvent("policy_degrade", {
      source: "server",
      from_model: "claude-sonnet-4-6",
      to_model: "claude-haiku-4-5",
    });
    expect(getEventDetail(ev)).toBe(
      "degraded from claude-sonnet-4-6 to claude-haiku-4-5",
    );
  });
});

describe("getSummaryRows — policy event expanded grid", () => {
  it("policy_warn lays out source / threshold / tokens", () => {
    const ev = makeEvent("policy_warn", {
      source: "local",
      threshold_pct: 80,
      tokens_used: 80,
      token_limit: 100,
    });
    const rows = getSummaryRows(ev);
    expect(rows).toContainEqual(["Source", "local"]);
    expect(rows).toContainEqual(["Threshold", "80%"]);
    expect(rows).toContainEqual(["Tokens used", "80"]);
    expect(rows).toContainEqual(["Token limit", "100"]);
  });

  it("policy_degrade adds From model / To model rows", () => {
    const ev = makeEvent("policy_degrade", {
      source: "server",
      threshold_pct: 50,
      tokens_used: 600,
      token_limit: 1000,
      from_model: "claude-sonnet-4-6",
      to_model: "claude-haiku-4-5",
    });
    const rows = getSummaryRows(ev);
    expect(rows).toContainEqual(["From model", "claude-sonnet-4-6"]);
    expect(rows).toContainEqual(["To model", "claude-haiku-4-5"]);
  });

  it("policy_block adds Intended model row", () => {
    const ev = makeEvent("policy_block", {
      source: "server",
      threshold_pct: 100,
      tokens_used: 100,
      token_limit: 100,
      intended_model: "claude-opus-4-7",
    });
    const rows = getSummaryRows(ev);
    expect(rows).toContainEqual(["Intended model", "claude-opus-4-7"]);
    // Block events don't carry from_model / to_model.
    const labels = rows.map((r) => r[0]);
    expect(labels).not.toContain("From model");
    expect(labels).not.toContain("To model");
  });
});

describe("<PolicyEventDetails />", () => {
  it("renders the toggle button with the per-event-id testid", () => {
    const ev = makeEvent("policy_warn", {
      source: "server",
      threshold_pct: 80,
      tokens_used: 80,
      token_limit: 100,
    });
    render(<PolicyEventDetails event={ev} />);
    expect(screen.getByTestId("policy-event-details-ev-1")).toBeTruthy();
    expect(screen.getByTestId("policy-event-details-toggle-ev-1")).toBeTruthy();
  });

  it("expands on click and renders the per-field testids", () => {
    const ev = makeEvent("policy_block", {
      source: "server",
      threshold_pct: 100,
      tokens_used: 100,
      token_limit: 100,
      intended_model: "claude-sonnet-4-6",
    });
    render(<PolicyEventDetails event={ev} />);
    fireEvent.click(screen.getByTestId("policy-event-details-toggle-ev-1"));
    expect(screen.getByTestId("policy-event-detail-source-ev-1")).toBeTruthy();
    expect(screen.getByTestId("policy-event-detail-pct-used-ev-1")).toBeTruthy();
    expect(screen.getByTestId("policy-event-detail-summary-ev-1")).toBeTruthy();
  });

  it("renders the local-source label distinctly from server-source", () => {
    const localEv = makeEvent("policy_warn", {
      source: "local",
      threshold_pct: 80,
      tokens_used: 80,
      token_limit: 100,
    });
    const { unmount } = render(<PolicyEventDetails event={localEv} />);
    fireEvent.click(screen.getByTestId("policy-event-details-toggle-ev-1"));
    expect(
      screen.getByTestId("policy-event-detail-source-ev-1").textContent,
    ).toMatch(/init\(\) limit \(local\)/);
    unmount();

    const serverEv = makeEvent("policy_warn", {
      source: "server",
      threshold_pct: 50,
      tokens_used: 60,
      token_limit: 100,
    });
    render(<PolicyEventDetails event={serverEv} />);
    fireEvent.click(screen.getByTestId("policy-event-details-toggle-ev-1"));
    expect(
      screen.getByTestId("policy-event-detail-source-ev-1").textContent,
    ).toMatch(/server policy/);
  });

  it("returns null when event has no payload", () => {
    const ev = makeEvent("policy_warn");
    const { container } = render(<PolicyEventDetails event={ev} />);
    expect(container.innerHTML).toBe("");
  });
});
