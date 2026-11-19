import { describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StreamingPill } from "@/components/session/EventRow";
import { attachBadge, defaultBadge, eventBadgeConfig, type BadgeConfig } from "@/lib/events";
import type { AgentEvent } from "@/lib/types";
import {
  BADGE_ROW_SURFACES,
  TEXT_SAFE_FLOOR,
  THEMES,
  labelRatio,
  readThemeTokens,
} from "./support/theme-contrast";

// Every event-type badge's label (getBadge's textVar), and the streaming
// badge's (STREAM, ABORTED), reads at 4.6:1 or better (TEXT_SAFE_FLOOR)
// over its badge's tint (15% of the type's hue) in both themes, on every
// row surface a badge sits on: --surface, --bg-elevated, --bg, a hovered
// row, a focused row, the Neighbors anchor, a linked Live feed row and
// an active Events facet, each composite taken exactly and as a browser
// draws it, rounded to 8 bits after each layer. The hue stays the
// badge's tint and border.

const TOKENS = readThemeTokens();
/** The tint every event-type badge draws under its label. */
const BADGE_TINT_PCT = 15;
const tint = (hue: string) => `color-mix(in srgb, ${hue} ${BADGE_TINT_PCT}%, transparent)`;

const BADGES: Array<[string, BadgeConfig]> = [
  ...Object.entries(eventBadgeConfig),
  ["the default badge (an event type with none of its own)", defaultBadge],
  ["the attach badge (a run re-attached)", attachBadge],
];

describe("every event-type badge's label reads at the floor over its tint, on every row surface, in both themes", () => {
  for (const [name, badge] of BADGES) {
    for (const theme of THEMES) {
      it(`${theme}: ${name} (${badge.label})`, () => {
        // The label takes a shade of its own, never the hue it is tinted with.
        expect(badge.textVar).toMatch(/^var\(--[a-z0-9-]+-badge-text\)$/);
        const failures: string[] = [];
        for (const row of BADGE_ROW_SURFACES) {
          const ratio = labelRatio(TOKENS[theme], badge.textVar, tint(badge.cssVar), row);
          if (ratio < TEXT_SAFE_FLOOR) failures.push(`${row.name}: ${ratio.toFixed(3)}:1`);
        }
        expect(failures).toEqual([]);
      });
    }
  }
});

describe("the streaming badge's label reads at the floor over its tint, on every row surface, in both themes", () => {
  /** A streamed post_call whose stream completed or was aborted. */
  const streamed = (outcome: "completed" | "aborted") =>
    ({
      id: `ev-stream-${outcome}`,
      session_id: "s",
      event_type: "post_call",
      payload: { streaming: { final_outcome: outcome, ttft_ms: 120, chunk_count: 12 } },
    }) as unknown as AgentEvent;

  for (const [outcome, label] of [["completed", "STREAM"], ["aborted", "ABORTED"]] as const) {
    it(`${label}: its label in a badge text token over its hue's tint`, () => {
      render(<StreamingPill event={streamed(outcome)} />);
      const pill = screen.getByText(label);
      expect(pill.style.color).toMatch(/^var\(--[a-z0-9-]+-badge-text\)$/);
      const failures: string[] = [];
      for (const theme of THEMES) {
        for (const row of BADGE_ROW_SURFACES) {
          const ratio = labelRatio(TOKENS[theme], pill.style.color, pill.style.background, row);
          if (ratio < TEXT_SAFE_FLOOR) failures.push(`${theme}, ${row.name}: ${ratio.toFixed(3)}:1`);
        }
      }
      expect(failures).toEqual([]);
      cleanup();
    });
  }
});

describe("the badge text tokens", () => {
  const names = (theme: (typeof THEMES)[number]) => [...TOKENS[theme].keys()].filter((k) => k.endsWith("-badge-text")).sort();

  it("both themes define the same set, and every badge's label is one of them", () => {
    expect(names("dark")).toEqual(names("light"));
    for (const [, badge] of BADGES) expect(names("dark")).toContain(/^var\((--[a-z0-9-]+)\)$/.exec(badge.textVar)?.[1]);
  });

  it("each is used: by an event-type badge or by an MCP policy decision pill", () => {
    expect(names("dark").length).toBeGreaterThan(0);
    const used = new Set(BADGES.map(([, b]) => /^var\((--[a-z0-9-]+)\)$/.exec(b.textVar)?.[1]));
    // The decision pills (MCPPolicyEntryTable.test.tsx checks them).
    for (const pill of ["--success-badge-text", "--warning-badge-text", "--danger-badge-text", "--accent-badge-text"]) used.add(pill);
    expect(names("dark").filter((n) => !used.has(n))).toEqual([]);
  });
});
