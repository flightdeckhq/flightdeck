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
  // Dimensions that MUST resolve to a non-null icon node. The
  // first six are pre-existing — lucide category glyphs (Fix 1)
  // plus the model provider logo and the policy_event_type
  // chroma dot. The remaining entries cover the 8 runtime-
  // context dims D160 added on the /events sidebar (OSIcon
  // resolves ``os`` separately so it has its own entry); a
  // regression that drops one of them from ``pickFacetIcon``
  // surfaces here as an icon-less assertion failure. ``terminal``,
  // ``matched_entry_id``, and ``originating_call_context`` were
  // icon-less until the small-C polish gave them neutral
  // category glyphs (Power / Fingerprint / Waypoints).
  const ICON_BEARING: { groupKey: string; value: string }[] = [
    { groupKey: "error_type", value: "rate_limit" },
    { groupKey: "mcp_server", value: "fixture-stdio-server" },
    { groupKey: "close_reason", value: "token_limit" },
    { groupKey: "estimated_via", value: "tiktoken" },
    { groupKey: "model", value: "claude-sonnet-4-5" },
    { groupKey: "policy_event_type", value: "policy_warn" },
    { groupKey: "os", value: "Linux" },
    { groupKey: "arch", value: "x86_64" },
    { groupKey: "hostname", value: "dev-box" },
    { groupKey: "user", value: "omria" },
    { groupKey: "git_branch", value: "main" },
    { groupKey: "git_repo", value: "flightdeck" },
    { groupKey: "orchestration", value: "docker-compose" },
    { groupKey: "python_version", value: "3.12.4" },
    { groupKey: "process_name", value: "sensor" },
    { groupKey: "matched_entry_id", value: "entry-1" },
    { groupKey: "originating_call_context", value: "sub_agent" },
    { groupKey: "terminal", value: "true" },
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

  // Dimensions left icon-free by FacetIcon: the AGENT facet
  // (agent_id) renders identity pills not a FacetIcon glyph,
  // and EVENT TYPE (event_type) renders the EventTypePill family
  // inline at the call site (the row replaces the FacetIcon with
  // the colored pill — neither one returns from this helper).
  const ICON_FREE = ["agent_id", "event_type"];

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

  it("renders the Container fallback for an unknown orchestration value", () => {
    // Known platforms (kubernetes / docker / docker-compose /
    // aws-ecs / cloud-run) delegate to OrchestrationIcon. Any
    // value outside that set must still render a glyph — the
    // generic Container lucide icon — so the chip never reads
    // as bare text.
    const { container } = render(
      <FacetIcon groupKey="orchestration" value="nomad" />,
    );
    expect(container.firstChild).not.toBeNull();
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
    // ``event_type`` is icon-free at the FacetIcon layer — the
    // EventTypePill replaces it inline at the call site, so the
    // helper returns null. A wrapper span with the testid would
    // be a zero-size hit target and misleading E2E anchor.
    const { container } = render(
      <FacetIcon
        groupKey="event_type"
        value="post_call"
        testId="events-facet-icon-event_type-post_call"
      />,
    );
    expect(
      container.querySelector(
        '[data-testid="events-facet-icon-event_type-post_call"]',
      ),
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
