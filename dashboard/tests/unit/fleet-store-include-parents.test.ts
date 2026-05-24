import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Fleet store's swimlane bootstrap (`load()`) must pass
// ``include_parents: true`` on its fetchSessions call so a sub-agent
// whose parent fell off the 100-row window still resolves topology
// via deriveRelationship. A one-line param being wrong would be
// invisible until live E2E; this spec is the fast-feedback gate.

vi.mock("@/lib/api", () => ({
	fetchFleet: vi.fn(async () => ({
		agents: [],
		total: 0,
		page: 1,
		per_page: 200,
		context_facets: {},
	})),
	fetchSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
	fetchCustomDirectives: vi.fn(async () => []),
}));

// Re-import after the mock is registered so the store sees the
// mocked module-level functions, not the real network-bound ones.
import { useFleetStore } from "@/store/fleet";
import { fetchSessions } from "@/lib/api";

describe("fleet store load() include_parents wiring", () => {
	beforeEach(() => {
		vi.mocked(fetchSessions).mockClear();
	});

	afterEach(() => {
		// The store is a module-level singleton; reset its state so
		// the next test's load() runs against a clean baseline.
		useFleetStore.setState({
			agents: [],
			flavors: [],
			loading: false,
			error: null,
			total: 0,
			page: 1,
		});
	});

	it("passes include_parents=true on the swimlane bootstrap fetch", async () => {
		await useFleetStore.getState().load();
		expect(fetchSessions).toHaveBeenCalledTimes(1);
		const firstCallArg = vi.mocked(fetchSessions).mock.calls[0]![0];
		expect(firstCallArg).toMatchObject({ include_parents: true });
	});

	it("composes include_parents with the limit + from window contract", async () => {
		await useFleetStore.getState().load();
		const firstCallArg = vi.mocked(fetchSessions).mock.calls[0]![0];
		// Sanity: the swimlane is still capped at 100 server-side
		// (the existing contract) and still passes a ``from`` window.
		expect(firstCallArg).toMatchObject({
			limit: 100,
			offset: 0,
			include_parents: true,
		});
		expect(typeof firstCallArg.from).toBe("string");
	});
});
