/**
 * T144 — Switching the Fleet range keeps the circles the page already
 * holds; the wider window loads newest first, page by page.
 *
 * Fixture: e2e-test-coding-agent, whose run gets a fresh event on every
 * keep-alive cycle. At 5m the spec records the run's newest circle and
 * from then on takes that event out of every `GET /v1/events` window
 * page. It then widens to 15m, with that window's `limit` rewritten to
 * 50 so even a quiet stack's 15 minutes take several pages and the load
 * has to page with the keyset cursor, and switches back to 5m. Each of
 * those loads brings the run a list without the recorded event. Merged
 * by id, the cache keeps it and its circle stays; a load that replaced
 * the run's list (as the page used to whenever its page was longer)
 * drops it.
 *
 * Everything is observed through the page: requests and the rendered
 * circles (`data-event-id`), nothing from the dev-only cache handle, so
 * the spec runs against a production build too.
 */
import { test, expect, type Route } from "@playwright/test";
import { CODING_AGENT, bringSwimlaneRowIntoView, waitForFleetReady } from "./_fixtures";

/** Events per page the 15m load is forced to. */
const FORCED_PAGE_SIZE = 50;

/** A request whose window starts this far back belongs to the 15m
 *  load, not a 5m one. */
const WIDE_WINDOW_MS = 10 * 60_000;

test.describe("T144 — A range switch keeps the cached circles", () => {
	test("the newest circle survives a wider window's pages and the switch back", async ({ page }) => {
		let hiddenEventId: string | null = null;
		const widePages: { order: string | null; beforeId: string | null; hasMore: boolean }[] = [];
		let narrowPagesAfterHiding = 0;

		await page.route("**/v1/events?*", async (route: Route) => {
			const url = new URL(route.request().url());
			if (hiddenEventId === null || url.searchParams.has("session_id")) {
				await route.continue();
				return;
			}
			const from = Date.parse(url.searchParams.get("from") ?? "");
			const wide = Date.now() - from > WIDE_WINDOW_MS;
			if (wide) url.searchParams.set("limit", String(FORCED_PAGE_SIZE));
			const response = await route.fetch({ url: url.toString() });
			const body = await response.json();
			if (Array.isArray(body?.events)) {
				body.events = body.events.filter((e: { id?: string }) => e.id !== hiddenEventId);
			}
			await route.fulfill({ response, json: body });
			if (wide) {
				widePages.push({
					order: url.searchParams.get("order"),
					beforeId: url.searchParams.get("before_id"),
					hasMore: body?.has_more === true,
				});
			} else {
				narrowPagesAfterHiding += 1;
			}
		});

		await page.goto("/");
		await waitForFleetReady(page);
		await page.getByRole("button", { name: "5m", exact: true }).click();
		const row = await bringSwimlaneRowIntoView(page, CODING_AGENT.name);
		await expect(row).toBeVisible({ timeout: 10_000 });

		// The run's newest circle at 5m: the rightmost one.
		const circles = row.locator('[data-testid^="session-circle-"][data-event-id]');
		await expect.poll(async () => circles.count(), { timeout: 15_000 }).toBeGreaterThan(0);
		const newest = await circles.evaluateAll((els) => {
			let best: { id: string; x: number } | null = null;
			for (const el of els) {
				const x = el.getBoundingClientRect().left;
				const id = el.getAttribute("data-event-id");
				if (id && (best === null || x > best.x)) best = { id, x };
			}
			return best?.id ?? null;
		});
		expect(newest).not.toBeNull();
		hiddenEventId = newest;
		const kept = row.locator(`[data-event-id="${newest}"]`);

		// Widen: the window loads newest first, its later pages continue
		// from the previous page's oldest event, and the load runs until
		// a page says there is no more.
		await page.getByRole("button", { name: "15m", exact: true }).click();
		await expect
			.poll(() => widePages.some((p) => !p.hasMore), { timeout: 30_000 })
			.toBe(true);
		expect(widePages.filter((p) => p.beforeId !== null).length).toBeGreaterThan(0);
		expect(widePages.every((p) => p.order === "desc")).toBe(true);
		await expect(kept).toHaveCount(1);

		// Back to 5m: that load lacks the event too, and the circle stays.
		await page.getByRole("button", { name: "5m", exact: true }).click();
		await expect.poll(() => narrowPagesAfterHiding, { timeout: 15_000 }).toBeGreaterThan(0);
		await expect(kept).toHaveCount(1);
	});
});
