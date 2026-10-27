import { test, expect } from "@playwright/test";
import { CLIENT_TYPE_VALUES } from "../../src/lib/agent-identity";

// T122 — the /agents CLIENT facet lists only the client types some
// agent carries. The client type registry reserves values for
// integrations that do not send events yet (Codex CLI, Cursor, the
// OTLP receiver, ...); those must not appear as empty filter options.
// The seeded fleet has Claude Code and sensor agents only, so the
// facet shows exactly those two, in registry order.
//
// Theme-agnostic per Rule 40c.3: assertions read test ids.

test.describe("T122 — /agents client facet lists present client types", () => {
  test("the CLIENT facet offers the seeded client types and no reserved ones", async ({
    page,
  }) => {
    await page.goto("/agents");
    const group = page.getByTestId("agent-filter-client-type-group");
    await expect(group).toBeVisible();
    // The facet derives from the roster; wait for the seeded agents.
    await expect(group.getByTestId("agent-filter-client-type-flightdeck_sensor")).toBeVisible();
    await expect(group.getByTestId("agent-filter-client-type-claude_code")).toBeVisible();

    const reserved = CLIENT_TYPE_VALUES.filter(
      (c) => c !== "claude_code" && c !== "flightdeck_sensor",
    );
    for (const c of reserved) {
      await expect(group.getByTestId(`agent-filter-client-type-${c}`)).toHaveCount(0);
    }

    const entries = group.locator('[data-testid^="agent-filter-client-type-"]');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toHaveAttribute("data-testid", "agent-filter-client-type-claude_code");
    await expect(entries.nth(1)).toHaveAttribute(
      "data-testid",
      "agent-filter-client-type-flightdeck_sensor",
    );
  });
});
