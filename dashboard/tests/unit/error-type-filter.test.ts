import { describe, it, expect } from "vitest";
import {
  parseUrlState,
  buildUrlParams,
  computeFacets,
  buildActiveFilters,
  CLEAR_ALL_FILTERS_PATCH,
} from "@/pages/Investigate";
import type { SessionListItem } from "@/lib/types";

// Phase 4 polish S-UI-3 part 2: ERROR TYPE filter contract pinned at
// the URL-state, facet-aggregation, active-filter-chip, and
// CLEAR_ALL_FILTERS layers. Runs without rendering the Investigate
// page (handleFacetClick is exercised via its inputs/outputs through
// computeFacets + URL state).

function makeSession(overrides: Partial<SessionListItem>): SessionListItem {
  return {
    session_id: overrides.session_id ?? "00000000-0000-0000-0000-000000000001",
    flavor: overrides.flavor ?? "test-flavor",
    agent_type: overrides.agent_type ?? "production",
    host: null,
    model: null,
    state: "active",
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_s: 0,
    tokens_used: 0,
    token_limit: null,
    context: {},
    error_types: overrides.error_types ?? [],
    ...overrides,
  };
}

describe("parseUrlState / buildUrlParams -- error_type round-trip", () => {
  it("reads ?error_type=rate_limit&error_type=authentication into errorTypes[]", () => {
    const sp = new URLSearchParams("error_type=rate_limit&error_type=authentication");
    const state = parseUrlState(sp);
    expect(state.errorTypes).toEqual(["rate_limit", "authentication"]);
  });

  it("buildUrlParams emits one error_type=... entry per value, preserving order", () => {
    const sp = new URLSearchParams("error_type=foo&error_type=bar");
    const state = parseUrlState(sp);
    const params = buildUrlParams(state);
    const round = params.getAll("error_type");
    expect(round).toEqual(["foo", "bar"]);
  });

  it("absent ?error_type yields an empty errorTypes[]", () => {
    const state = parseUrlState(new URLSearchParams(""));
    expect(state.errorTypes).toEqual([]);
  });
});

describe("CLEAR_ALL_FILTERS_PATCH -- error_type filters reset by Clear filters", () => {
  it("includes errorTypes:[] so a clear-all wipes the error_type filter", () => {
    expect(CLEAR_ALL_FILTERS_PATCH.errorTypes).toEqual([]);
  });
});

describe("computeFacets -- ERROR TYPE group aggregation", () => {
  it("emits an error_type group when at least one session has error_types[]", () => {
    const facets = computeFacets([
      makeSession({ error_types: ["rate_limit"] }),
      makeSession({ session_id: "id-2", error_types: ["authentication", "rate_limit"] }),
      makeSession({ session_id: "id-3", error_types: [] }),
    ]);
    const errGroup = facets.find((g) => g.key === "error_type");
    expect(errGroup).toBeDefined();
    expect(errGroup!.label).toBe("ERROR TYPE");
    // rate_limit appears in 2 sessions, authentication in 1.
    const counts = Object.fromEntries(
      errGroup!.values.map((v) => [v.value, v.count]),
    );
    expect(counts).toEqual({ rate_limit: 2, authentication: 1 });
  });

  it("hides the ERROR TYPE group when no session in the result has any error_types", () => {
    const facets = computeFacets([
      makeSession({ error_types: [] }),
      makeSession({ session_id: "id-2", error_types: undefined }),
    ]);
    expect(facets.find((g) => g.key === "error_type")).toBeUndefined();
  });

  it("uses sticky-source override when sources.error_type is provided", () => {
    // With an active error_type filter, the main result set is
    // narrowed to sessions matching the filter -- but the facet
    // sidebar should still list every distinct error_type value,
    // so the parallel ``sources.error_type`` fetch (with the filter
    // stripped) feeds the facet count instead of the main list.
    const facets = computeFacets(
      [makeSession({ error_types: ["rate_limit"] })], // main, filtered
      {
        error_type: [
          makeSession({ error_types: ["rate_limit"] }),
          makeSession({ session_id: "id-2", error_types: ["authentication"] }),
          makeSession({ session_id: "id-3", error_types: ["timeout"] }),
        ],
      },
    );
    const errGroup = facets.find((g) => g.key === "error_type");
    expect(errGroup!.values.map((v) => v.value).sort()).toEqual([
      "authentication",
      "rate_limit",
      "timeout",
    ]);
  });
});

describe("buildActiveFilters -- error_type chips", () => {
  it("emits one chip per active error_type value", () => {
    const sp = new URLSearchParams("error_type=rate_limit&error_type=timeout");
    const state = parseUrlState(sp);
    const updates: Array<Partial<typeof state>> = [];
    const pills = buildActiveFilters(state, [], [], (patch) => {
      updates.push(patch);
    });
    const labels = pills.map((p) => p.label);
    expect(labels).toContain("error_type:rate_limit");
    expect(labels).toContain("error_type:timeout");
  });

  it("chip onRemove drops the value and resets page", () => {
    const sp = new URLSearchParams("error_type=rate_limit&error_type=timeout");
    const state = parseUrlState(sp);
    const captured: Array<Partial<typeof state>> = [];
    const pills = buildActiveFilters(state, [], [], (patch) => {
      captured.push(patch);
    });
    const rateLimit = pills.find((p) => p.label === "error_type:rate_limit");
    rateLimit!.onRemove();
    expect(captured).toHaveLength(1);
    expect(captured[0].errorTypes).toEqual(["timeout"]);
    expect(captured[0].page).toBe(1);
  });
});
