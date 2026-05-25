/**
 * T26 — Theme matrix canary.
 *
 * Asserts that the per-project ``storageState`` configured in
 * playwright.config.ts actually flips the <html> class. The Phase 5
 * push surfaced a long-running drift where the seeded localStorage
 * VALUE ("neon-dark" / "clean-light") didn't match what
 * dashboard/src/hooks/useTheme.ts accepts ("dark" / "light"), AND
 * the seeded localStorage KEY ("flightdeck:theme" with a colon)
 * didn't match the constant in dashboard/src/lib/constants.ts
 * ("flightdeck-theme" with a hyphen). With both wrong, useTheme
 * silently fell to its "dark" default and the clean-light project
 * ran a second copy of the dark-theme suite — defeating Rule 40c.3
 * for an unknown number of phases.
 *
 * This canary fails LOUDLY when either the key or the value drifts
 * out of agreement with useTheme. Without it, the regression
 * recurs invisibly: every spec passes "in both themes" while
 * actually exercising one. Keeping it short on purpose — one
 * assertion per project, theme-agnostic structural mount signal,
 * no fixtures.
 */
import { test, expect } from "@playwright/test";
import { THEME_STORAGE_KEY } from "../../src/lib/constants";

test("html element carries the theme class matching the project storageState", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  // Wait for React to mount Nav (the host of useTheme). Without this,
  // we'd race the mount and read the SSR-static <html class="dark">
  // baked into index.html. The "Fleet" anchor lives in the top nav
  // and renders on every route, so it's a reliable mount signal.
  await page.waitForSelector('nav a:has-text("Fleet")', { timeout: 5000 });
  // useTheme's useEffect fires after React commit and mutates the
  // <html> classList to match the persisted theme. Web-first wait on
  // the actual state change (the class being one of {dark, light})
  // rather than a fixed 100ms sleep — surfaces the real failure
  // condition ("class never flipped") instead of papering a race
  // with an arbitrary delay.
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.className),
      { timeout: 3000 },
    )
    .toMatch(/(^|\s)(dark|light)(\s|$)/);
  const cls = await page.evaluate(() => document.documentElement.className);
  // Read the localStorage entry under the same key the dashboard
  // uses (``THEME_STORAGE_KEY`` from ``src/lib/constants.ts``). The
  // canary imports the canonical constant — a hardcoded literal here
  // would silently desync from the seeded key, hiding the drift this
  // test exists to catch.
  const ls = await page.evaluate(
    (key) => localStorage.getItem(key),
    THEME_STORAGE_KEY,
  );
  if (testInfo.project.name === "neon-dark") {
    expect(cls, "neon-dark project must mount with html.class=dark").toMatch(
      /(^|\s)dark(\s|$)/,
    );
    expect(cls).not.toMatch(/(^|\s)light(\s|$)/);
    expect(
      ls,
      `neon-dark project must seed localStorage[${THEME_STORAGE_KEY}]=dark`,
    ).toBe("dark");
  } else if (testInfo.project.name === "clean-light") {
    expect(cls, "clean-light project must mount with html.class=light").toMatch(
      /(^|\s)light(\s|$)/,
    );
    expect(cls).not.toMatch(/(^|\s)dark(\s|$)/);
    expect(
      ls,
      `clean-light project must seed localStorage[${THEME_STORAGE_KEY}]=light`,
    ).toBe("light");
  } else {
    test.skip(true, `not a base theme project: ${testInfo.project.name}`);
  }
});
