import { test } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// T34 — Sub-agent time flow connectors. Design § 4.3 calls for
// Bezier connector lines from the parent's spawn event to the
// child's first event when both swimlane rows are simultaneously
// visible, plus a hover-brighten interaction. The connector
// rendering surface is NOT yet implemented in the v0.4.x dashboard
// — step 7.fix landed the relationship pill (4.1) and the depth-2
// drawer (4.2) but left 4.3's SVG overlay as a follow-up.
//
// This spec is recorded as a placeholder so the suite contract
// matches the design doc § 11.8 enumeration. Skipping with a
// pointer to the design doc keeps the gap surfaced rather than
// silently absent. The feature lands in a follow-up PR; the spec
// flips from .skip to active in the same commit that adds the
// connector overlay.
test.describe("T34 — Sub-agent time flow connectors", () => {
  test.skip(
    "connector lines + hover-brighten — deferred until SubAgentConnector ships (design § 4.3)",
    async ({ page }) => {
      await page.goto("/");
      await waitForFleetReady(page);
      // No-op: the spec runner reports as skipped; the design doc
      // § 4.3 / § 11.8 enumeration is the audit trail. When the
      // connector overlay lands, replace this body with the
      // assertion against ``[data-testid^="sub-agent-connector-"]``.
    },
  );
});
