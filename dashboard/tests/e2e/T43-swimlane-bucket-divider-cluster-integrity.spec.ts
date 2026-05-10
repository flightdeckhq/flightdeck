import { test, expect } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// T43 — bucket dividers in the SwimLane never split a parent
// from its sub-agents.
//
// Two regressions surfaced together on PR #33:
//   1. Spurious dividers within parent-child clusters: a LIVE parent
//      with a RECENT-bucket sub-agent had a horizontal line inserted
//      between them by Timeline's bucket-transition loop.
//   2. Duplicate React keys when the same (prev → next) bucket
//      transition recurred — keys like `bucket-live-to-recent`
//      collided across multiple clusters, producing the "dividers
//      accumulate, only clear on full refresh" symptom.
//
// Both fixes live in Timeline.tsx's bucket-divider IIFE (skip
// dividers on `topology === "child"` rows; pin keys to the flavor
// they precede). This spec exercises the cluster-integrity contract
// against live fleet data (any seeded fixtures plus whatever
// playground/Claude-Code activity is in the dev DB) — the unit
// test in tests/unit/Timeline-bucket-divider.test.tsx covers the
// shaped scenarios (specific parent_session_id linkage); this E2E
// is the structural regression guard.
test.describe("T43 — Swimlane bucket dividers respect parent-child clusters", () => {
  test("no bucket-divider sits immediately before a child row", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Each bucket-divider is a 1px horizontal element rendered
    // directly into the swimlane stack. If the divider's next
    // sibling is a row with `data-topology="child"`, the divider
    // is splitting a cluster — exactly the regression this guards.
    const dividerCount = await page.evaluate(() => {
      const dividers = document.querySelectorAll(
        '[data-testid^="bucket-divider-"]',
      );
      let splitClusters = 0;
      for (const d of Array.from(dividers)) {
        // The next sibling that's an actual row container — skip
        // text nodes / comments. A child row carries
        // `data-topology="child"` on the SwimLane outer wrapper.
        let n: Element | null = d.nextElementSibling;
        while (n && !n.hasAttribute("data-flavor")) {
          n = n.nextElementSibling;
        }
        if (n) {
          const inner = n.querySelector('[data-topology="child"]');
          if (inner) splitClusters += 1;
        }
      }
      return { total: dividers.length, splitClusters };
    });

    expect(
      dividerCount.splitClusters,
      `expected zero bucket-dividers immediately before a child row; ` +
        `saw ${dividerCount.splitClusters} of ${dividerCount.total} total dividers ` +
        `splitting a parent-child cluster`,
    ).toBe(0);
  });

  test("bucket-divider count is bounded by total flavor rows in the swimlane stack", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);

    // Pre-fix duplicate-key behavior: two live→recent transitions in
    // the same render shared the key `bucket-live-to-recent` and
    // React would silently dedupe. Combined with the cluster-split
    // bug, the visual count of dividers was unstable across renders.
    // Post-fix every divider key is `bucket-divider-before-${flavor}`
    // — globally unique by the flavor it precedes — so the rendered
    // count equals the count of distinct bucket transitions in the
    // visible sequence.
    //
    // Invariant: with N flavor rows there can be at most N-1 dividers
    // between them. Children are skipped by design (the cluster-
    // integrity contract from Test 1) so the post-fix count is
    // always strictly less than rowCount. We count all rows via the
    // [data-flavor] attribute on VirtualizedSwimLane wrappers so
    // virtualized off-screen rows still participate (their wrapper
    // exists even when SwimLane itself is replaced by a spacer).
    const counts = await page.evaluate(() => {
      const flavorRows = document.querySelectorAll("[data-flavor]");
      const dividers = document.querySelectorAll(
        '[data-testid^="bucket-divider-"]',
      );
      return { flavorRows: flavorRows.length, dividers: dividers.length };
    });

    if (counts.flavorRows > 0) {
      expect(
        counts.dividers,
        `dividers (${counts.dividers}) should be at most flavorRows-1 ` +
          `(${counts.flavorRows - 1}); the pre-fix bug would let dividers ` +
          `accumulate beyond this bound across activity`,
      ).toBeLessThanOrEqual(Math.max(0, counts.flavorRows - 1));
    }
  });
});
