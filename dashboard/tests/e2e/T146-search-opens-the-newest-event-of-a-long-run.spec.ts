/**
 * T146 — The search palette opens an event anywhere in a long run.
 *
 * Fixture: a run of e2e-test-long-run with 2,050 tool calls and, newest
 * of all, one tool call named e2e-long-run-needle (LONG_RUN_FIXTURE).
 * globalSetup seeds it through the ingestion API, once per stack, and
 * waits until the worker has stored the run, before any spec starts.
 * Two suite runs started together on a fresh stack each seed one, so a
 * stack can hold two such runs, and the spec accepts either needle.
 * The palette finds the needle and opens it; the event drawer shows
 * it. The lookup this replaced read only the run's oldest 2,000
 * events, so the needle opened as "Event not found".
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { LONG_RUN_FIXTURE } from "./_fixtures";
import { API_URL } from "./_stack";

const NEEDLE = LONG_RUN_FIXTURE.needle;
const CALLS = LONG_RUN_FIXTURE.calls;
const API = API_URL;
const AUTH = { Authorization: "Bearer tok_dev" };

interface NeedleHit {
	event_id: string;
	session_id: string;
}

/** Every stored needle's search hit, newest first. */
async function needleHits(request: APIRequestContext): Promise<NeedleHit[]> {
	const resp = await request.get(`${API}/v1/search?q=${NEEDLE}`, { headers: AUTH });
	if (!resp.ok()) return [];
	const body = (await resp.json()) as { events?: (NeedleHit & { tool_name: string })[] };
	return (body.events ?? []).filter((e) => e.tool_name === NEEDLE);
}

/** The newest needle's search hit, or null while none is stored. */
async function needleHit(request: APIRequestContext): Promise<NeedleHit | null> {
	return (await needleHits(request))[0] ?? null;
}

/** How many events the run holds. */
async function runEventCount(request: APIRequestContext, sessionId: string): Promise<number> {
	const resp = await request.get(
		`${API}/v1/events?from=1970-01-01T00:00:00Z&session_id=${sessionId}&limit=1`,
		{ headers: AUTH },
	);
	if (!resp.ok()) return 0;
	return ((await resp.json()) as { total: number }).total;
}

test.describe("T146 — The search palette opens an event anywhere in a long run", () => {
	test("the run's newest event, past its oldest 2,000, opens in the event drawer", async ({ page, request }) => {
		// globalSetup has stored the run; this reads the needle's hit and
		// holds the spec to the fixture it needs. The needle is posted
		// last, so once it is searchable and the run holds every call,
		// the run is fully stored.
		let hit: NeedleHit | null = null;
		await expect
			.poll(
				async () => {
					hit = await needleHit(request);
					return hit ? runEventCount(request, hit.session_id) : 0;
				},
				{ timeout: 20_000 },
			)
			.toBeGreaterThan(CALLS);
		const target = hit as unknown as NeedleHit;

		await page.goto("/");
		await page.getByTestId("nav-search-trigger").click();
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("textbox", { name: "Search" }).fill(NEEDLE);
		const option = dialog.getByRole("option").filter({ hasText: NEEDLE }).first();
		await expect(option).toBeVisible({ timeout: 10_000 });
		await option.click();

		// A stack can hold two long runs (see the header), so the palette
		// may open the other run's needle. Each needle is the newest
		// event of a run past its oldest 2,000, so either proves the
		// lookup; the opened one must be a needle.
		await expect(page).toHaveURL(/[?&]event=[0-9a-f-]{36}/);
		const opened = new URL(page.url()).searchParams.get("event");
		const needles = (await needleHits(request)).map((h) => h.event_id);
		expect(needles).toContain(opened);
		expect(needles).toContain(target.event_id);
		// The opened needle's run must itself be past its oldest 2,000
		// and fully stored, or the old lookup could pass by luck.
		const openedHit = (await needleHits(request)).find((h) => h.event_id === opened);
		// An unfiltered count would be every stored event, so the hit
		// and its session id must be real before the run is counted.
		expect(openedHit?.session_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await runEventCount(request, openedHit!.session_id)).toBeGreaterThan(CALLS);
		const drawer = page.getByTestId("event-detail-drawer");
		await expect(drawer).toBeVisible({ timeout: 10_000 });
		await expect(drawer).toContainText(NEEDLE);
		await expect(page.getByRole("dialog", { name: "Event not found" })).toHaveCount(0);
	});
});
