// Step 6.7 A1: FacetIcon renders a chroma dot for POLICY and
// MCP POLICY facet chips so operators can identify "this chip
// filters for warns" by colour alone, matching the timeline
// badge chroma. The dot's background is the cssVar from
// eventBadgeConfig — same source the timeline pills draw from.
//
// These tests assert the contract between FacetIcon and
// eventBadgeConfig directly (no mounting Investigate); a
// regression where FacetIcon is rebuilt and forgets the
// chroma case will surface here without re-running the full
// page tests.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { FacetIcon } from "@/components/facets/FacetIcon";
import { eventBadgeConfig } from "@/lib/events";

describe("FacetIcon — POLICY / MCP POLICY chroma dots (step 6.7 A1)", () => {
  it("renders a chroma dot for each token-budget POLICY chip", () => {
    for (const eventType of ["policy_warn", "policy_block", "policy_degrade"]) {
      const { container } = render(
        <FacetIcon groupKey="policy_event_type" value={eventType} />,
      );
      const dot = container.querySelector("span");
      expect(dot, `dot missing for ${eventType}`).toBeTruthy();
      const expected = eventBadgeConfig[eventType]?.cssVar;
      expect(expected, `eventBadgeConfig missing ${eventType}`).toBeTruthy();
      expect(
        (dot as HTMLElement).style.background,
        `dot bg mismatch for ${eventType}`,
      ).toBe(expected);
    }
  });

  it("renders a chroma dot for each MCP POLICY chip", () => {
    const mcpPolicyTypes = [
      "policy_mcp_warn",
      "policy_mcp_block",
      "mcp_server_name_changed",
      "mcp_policy_user_remembered",
    ];
    for (const eventType of mcpPolicyTypes) {
      const { container } = render(
        <FacetIcon groupKey="mcp_policy_event_type" value={eventType} />,
      );
      const dot = container.querySelector("span");
      expect(dot, `dot missing for ${eventType}`).toBeTruthy();
      const expected = eventBadgeConfig[eventType]?.cssVar;
      expect(expected, `eventBadgeConfig missing ${eventType}`).toBeTruthy();
      expect(
        (dot as HTMLElement).style.background,
        `dot bg mismatch for ${eventType}`,
      ).toBe(expected);
    }
  });

  it("policy_mcp_warn dot uses var(--event-warn) chroma", () => {
    // Lock the chroma map: warn = amber (--event-warn), block = red
    // (--event-block), name_changed / user_remembered = info-purple
    // (--event-result). Per ARCHITECTURE.md "Adjacent surfaces" and
    // step 6 of the MCP Protection Policy plan.
    const { container } = render(
      <FacetIcon groupKey="mcp_policy_event_type" value="policy_mcp_warn" />,
    );
    expect((container.querySelector("span") as HTMLElement).style.background).toBe(
      "var(--event-warn)",
    );
  });

  it("policy_mcp_block dot uses var(--event-block) chroma", () => {
    const { container } = render(
      <FacetIcon groupKey="mcp_policy_event_type" value="policy_mcp_block" />,
    );
    expect((container.querySelector("span") as HTMLElement).style.background).toBe(
      "var(--event-block)",
    );
  });

  it("FYI events use var(--event-result) (info-purple) chroma", () => {
    for (const eventType of ["mcp_server_name_changed", "mcp_policy_user_remembered"]) {
      const { container } = render(
        <FacetIcon groupKey="mcp_policy_event_type" value={eventType} />,
      );
      expect(
        (container.querySelector("span") as HTMLElement).style.background,
      ).toBe("var(--event-result)");
    }
  });

  it("returns null for an event type not in eventBadgeConfig (defensive)", () => {
    const { container } = render(
      <FacetIcon groupKey="mcp_policy_event_type" value="not_a_real_event_type" />,
    );
    expect(container.querySelector("span")).toBeNull();
  });

  it("does NOT render a chroma dot for unrelated facet keys", () => {
    // Sanity: the chroma path is gated on groupKey, not value
    // shape. A "flavor" or "model" key should still hit the
    // generic icon path (or null), not accidentally render a
    // chroma dot for a coincidentally-matching value.
    const { container } = render(
      <FacetIcon groupKey="flavor" value="policy_mcp_warn" />,
    );
    const span = container.querySelector("span");
    if (span) {
      // flavor renders a Bot icon, not a chroma dot — assert
      // background is unset (the chroma path always sets it).
      expect((span as HTMLElement).style.background).toBe("");
    }
  });
});
