import { test, expect } from "@playwright/test";
import { CLIENT_TYPE_VALUES } from "../../src/lib/agent-identity";

// T122 — the /agents CLIENT facet lists only the client types some
// agent carries. The client type registry reserves values for
// integrations that do not send events yet (Codex CLI, Cursor, ...);
// those must not appear as empty filter options. The seeded fleet has
// Claude Code, sensor and OpenTelemetry GenAI framework agents
// (genai_seed.py), so the facet shows exactly those three, in
// registry order.
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
    await expect(group.getByTestId("agent-filter-client-type-otlp")).toBeVisible();

    const present = ["claude_code", "flightdeck_sensor", "otlp"];
    const reserved = CLIENT_TYPE_VALUES.filter((c) => !present.includes(c));
    for (const c of reserved) {
      await expect(group.getByTestId(`agent-filter-client-type-${c}`)).toHaveCount(0);
    }

    const entries = group.locator('[data-testid^="agent-filter-client-type-"]');
    await expect(entries).toHaveCount(present.length);
    for (const [i, c] of present.entries()) {
      await expect(entries.nth(i)).toHaveAttribute("data-testid", `agent-filter-client-type-${c}`);
    }
  });
});
