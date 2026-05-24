// Polish Batch 2 Fix 3 — EventTypePill is the canonical event-type
// pill shared verbatim by the run drawer's Timeline event rows, the
// /events table EventRow, and the agent drawer's Events tab. Before
// the fix the three surfaces diverged (pill vs dot+label); this
// component centralises them so all three render byte-identically.
//
// These tests assert the contract between EventTypePill and
// getBadge / eventBadgeConfig: the rendered label, the default and
// custom testid, and that the pill's colour is the event's chroma.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { EventTypePill } from "@/components/facets/EventTypePill";
import { eventBadgeConfig, getBadge } from "@/lib/events";

describe("EventTypePill", () => {
  it("renders the badge label for the given event type", () => {
    const { getByTestId } = render(<EventTypePill eventType="post_call" />);
    // eventBadgeConfig.post_call.label === "LLM CALL"
    expect(getByTestId("event-type-pill").textContent).toBe(
      eventBadgeConfig.post_call!.label,
    );
  });

  it("defaults the data-testid to 'event-type-pill'", () => {
    const { container } = render(<EventTypePill eventType="tool_call" />);
    expect(
      container.querySelector('[data-testid="event-type-pill"]'),
      "the default testid must be event-type-pill",
    ).not.toBeNull();
  });

  it("carries a data-event-type attribute for per-type addressing", () => {
    const { getByTestId } = render(<EventTypePill eventType="post_call" />);
    expect(
      getByTestId("event-type-pill").getAttribute("data-event-type"),
      "the pill must expose its event type so a spec can address one type",
    ).toBe("post_call");
  });

  it("honours a custom testId prop", () => {
    const { container } = render(
      <EventTypePill eventType="tool_call" testId="my-custom-badge" />,
    );
    expect(
      container.querySelector('[data-testid="my-custom-badge"]'),
    ).not.toBeNull();
    // The default testid is NOT also emitted when a custom one is set.
    expect(
      container.querySelector('[data-testid="event-type-pill"]'),
    ).toBeNull();
  });

  it("uses the event colour from getBadge for background, text, and border", () => {
    const { getByTestId } = render(<EventTypePill eventType="policy_block" />);
    const pill = getByTestId("event-type-pill") as HTMLElement;
    const expected = getBadge("policy_block").cssVar; // var(--event-block)
    // The pill text colour is the raw cssVar; background + border are
    // colour-mixes that embed the same cssVar.
    expect(pill.style.color).toBe(expected);
    expect(pill.style.background).toContain(expected);
    expect(pill.style.border).toContain(expected);
  });

  it("renders the pill as a <span> with the locked layout classes", () => {
    const { getByTestId } = render(<EventTypePill eventType="session_start" />);
    const pill = getByTestId("event-type-pill");
    expect(pill.tagName).toBe("SPAN");
    // The 18px-high, 88px-min-width capsule shape is the locked
    // layout the three consuming surfaces share.
    expect(pill.className).toContain("h-[18px]");
    expect(pill.className).toContain("min-w-[88px]");
  });

  it("falls back to the default badge for an unknown event type", () => {
    const { getByTestId } = render(
      <EventTypePill eventType="not_a_real_event_type" />,
    );
    // getBadge returns defaultBadge ("EVENT") for any type not in
    // eventBadgeConfig.
    expect(getByTestId("event-type-pill").textContent).toBe(
      getBadge("not_a_real_event_type").label,
    );
  });
});
