/**
 * T191 — On the Policies page the active tab has its own background on
 * its tab list, and a tab focused from the keyboard draws its focus
 * ring, the ring's offset gap in the tab list's colour.
 *
 * Structural and theme-agnostic: the assertions compare computed values
 * with each other (the active tab's background against the list's, the
 * ring's offset colour against the list's background) and never name a
 * colour, so both theme projects run it unchanged.
 */
import { test, expect, type Locator } from "@playwright/test";

/** ``el``'s computed ``prop`` once its transitions (the tab's
 *  transition-all) have finished, so a value is read settled, not
 *  mid-way. */
function settled(el: Locator, prop: "backgroundColor" | "boxShadow"): Promise<string> {
	return el.evaluate(async (node, p) => {
		await Promise.all(node.getAnimations().map((a) => a.finished));
		return getComputedStyle(node)[p];
	}, prop);
}

/** A CSS colour as the browser computes it, for comparing two values. */
function computedColour(el: Locator, value: string): Promise<string> {
	return el.evaluate((node, v) => {
		const probe = document.createElement("span");
		probe.style.color = v;
		node.appendChild(probe);
		const out = getComputedStyle(probe).color;
		probe.remove();
		return out;
	}, value);
}

test.describe("T191 — The Policies tabs: the active tab has its own background on the list, a focused tab draws its ring", () => {
	test("the active tab stands out on its tab list, and keyboard focus draws a ring on the list's colour", async ({ page }) => {
		await page.goto("/policies");
		const active = page.getByTestId("policies-tab-token-budget");
		await expect(active).toHaveAttribute("data-state", "active");
		const list = active.locator("xpath=..");
		await expect(list).toHaveAttribute("role", "tablist");

		// Its own background on the list: opaque, and not the list's.
		const listBackground = await list.evaluate((el) => getComputedStyle(el).backgroundColor);
		const activeBackground = await settled(active, "backgroundColor");
		expect(activeBackground).not.toBe(listBackground);
		expect(await active.evaluate((el) => {
			const probe = document.createElement("canvas").getContext("2d")!;
			probe.fillStyle = getComputedStyle(el).backgroundColor;
			probe.fillRect(0, 0, 1, 1);
			return probe.getImageData(0, 0, 1, 1).data[3];
		})).toBe(255);

		// Focus from the keyboard: step out and back in with Tab, so the
		// browser treats the focus as keyboard focus (:focus-visible).
		await active.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		await expect(active).toBeFocused();
		await expect.poll(() => active.evaluate((el) => el.matches(":focus-visible"))).toBe(true);

		// The ring draws (an undefined offset colour would leave box-shadow
		// at none), and its offset gap is the tab list's background.
		expect(await settled(active, "boxShadow")).not.toBe("none");
		const offset = await active.evaluate((el) => getComputedStyle(el).getPropertyValue("--tw-ring-offset-color").trim());
		expect(offset).not.toBe("");
		expect(await computedColour(list, offset)).toBe(listBackground);
	});
});
