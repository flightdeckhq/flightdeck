// Polish Batch 2 Fix 1 — the /events facet sidebar gives every
// dimension a leading icon. FacetIcon is the resolver: it maps a
// (groupKey, value) pair to an icon node, returns null for
// dimensions that carry no icon treatment, and — when a `testId`
// prop is supplied — wraps the icon in a span carrying that
// testid so E2E specs can assert the sidebar's icon family
// rendered. Returns nothing (no empty testid node) when the
// dimension has no icon.
//
// The chroma-dot path (POLICY / MCP POLICY) is exercised
// separately by FacetIcon-policy-chroma.test.tsx; this file
// covers the lucide-glyph + provider-logo + no-icon branches
// and the testId-wrapper contract.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { FacetIcon } from "@/components/facets/FacetIcon";

describe("FacetIcon — icon resolution per dimension", () => {
  // Dimensions that MUST resolve to a non-null icon node. error_type
  // / mcp_server / close_reason / estimated_via are the lucide
  // glyphs Fix 1 newly added; model is the provider logo;
  // policy_event_type is the chroma dot.
  const ICON_BEARING: { groupKey: string; value: string }[] = [
    { groupKey: "error_type", value: "rate_limit" },
    { groupKey: "mcp_server", value: "fixture-stdio-server" },
    { groupKey: "close_reason", value: "token_limit" },
    { groupKey: "estimated_via", value: "tiktoken" },
    { groupKey: "model", value: "claude-sonnet-4-5" },
    { groupKey: "policy_event_type", value: "policy_warn" },
  ];

  for (const { groupKey, value } of ICON_BEARING) {
    it(`renders an icon for the ${groupKey} dimension`, () => {
      const { container } = render(
        <FacetIcon groupKey={groupKey} value={value} />,
      );
      // An icon node renders SOME element — a lucide <svg>, the
      // provider-logo <img>/<svg>, or the chroma-dot <span>.
      expect(
        container.firstChild,
        `${groupKey} must resolve to a non-null icon node`,
      ).not.toBeNull();
    });
  }

  // Dimensions Fix 1 leaves icon-free: the AGENT facet (agent_id)
  // renders identity pills not a FacetIcon glyph, EVENT TYPE
  // (event_type) renders the EventTypePill family, and TERMINAL is
  // a boolean toggle facet.
  const ICON_FREE = ["agent_id", "event_type", "terminal"];

  for (const groupKey of ICON_FREE) {
    it(`renders nothing for the ${groupKey} dimension`, () => {
      const { container } = render(
        <FacetIcon groupKey={groupKey} value="anything" />,
      );
      expect(
        container.firstChild,
        `${groupKey} must render no icon`,
      ).toBeNull();
    });
  }

  it("renders nothing for an unknown dimension key", () => {
    const { container } = render(
      <FacetIcon groupKey="not_a_real_dimension" value="x" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("FacetIcon — testId wrapper contract", () => {
  it("wraps the icon in a span carrying the testId when an icon resolves", () => {
    const { container } = render(
      <FacetIcon
        groupKey="error_type"
        value="rate_limit"
        testId="events-facet-icon-error_type-rate_limit"
      />,
    );
    const wrapper = container.querySelector(
      '[data-testid="events-facet-icon-error_type-rate_limit"]',
    );
    expect(wrapper, "the testid wrapper span must exist").not.toBeNull();
    // The wrapper actually contains the icon node, not an empty span.
    expect((wrapper as HTMLElement).childElementCount).toBeGreaterThan(0);
  });

  it("renders no testId node when the dimension has no icon", () => {
    const { container } = render(
      <FacetIcon
        groupKey="terminal"
        value="true"
        testId="events-facet-icon-terminal-true"
      />,
    );
    // No icon → no wrapper, even though a testId was supplied. The
    // sidebar must not emit an empty testid'd span (it would be a
    // zero-size hit target and a misleading E2E anchor).
    expect(
      container.querySelector('[data-testid="events-facet-icon-terminal-true"]'),
      "no testid wrapper must render for an icon-free dimension",
    ).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders the bare icon (no wrapper span) when no testId is supplied", () => {
    const { container } = render(
      <FacetIcon groupKey="error_type" value="timeout" />,
    );
    // An icon renders, but it is NOT wrapped in the testid span.
    expect(container.firstChild).not.toBeNull();
    expect(
      container.querySelector("[data-testid]"),
      "no testid attribute must appear when testId is omitted",
    ).toBeNull();
  });
});
