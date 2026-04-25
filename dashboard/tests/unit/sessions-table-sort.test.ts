/**
 * Phase 4.5 S-TBL-1..4 — session table sort behaviour.
 *
 * Covers the URL state round-trip for the new sortable columns, the
 * relative-time formatter that drives the Last Seen column, and the
 * sort direction toggle pattern. Pairs with the Go integration test
 * (tests/integration/test_sessions_table_sort.py) and the T18/T19
 * E2E specs.
 */

import { describe, it, expect } from "vitest";

import { formatRelativeTime } from "@/lib/time";
import {
  parseUrlState,
  buildUrlParams,
  CLEAR_ALL_FILTERS_PATCH,
} from "@/pages/Investigate";

describe("parseUrlState — S-TBL-4 sort round-trip", () => {
  it("parses ?sort=last_seen_at&order=desc round-trip", () => {
    const sp = new URLSearchParams("sort=last_seen_at&order=desc");
    const s = parseUrlState(sp);
    expect(s.sort).toBe("last_seen_at");
    expect(s.order).toBe("desc");
  });

  it("parses ?sort=state&order=asc round-trip", () => {
    const sp = new URLSearchParams("sort=state&order=asc");
    const s = parseUrlState(sp);
    expect(s.sort).toBe("state");
    expect(s.order).toBe("asc");
  });

  it("buildUrlParams emits sort=last_seen_at when set", () => {
    const s = parseUrlState(new URLSearchParams());
    s.sort = "last_seen_at";
    s.order = "desc";
    const p = buildUrlParams(s);
    expect(p.get("sort")).toBe("last_seen_at");
    // ``desc`` is the default; buildUrlParams omits when default.
    expect(p.get("order")).toBeNull();
  });

  it("buildUrlParams emits sort=state&order=asc when set", () => {
    const s = parseUrlState(new URLSearchParams());
    s.sort = "state";
    s.order = "asc";
    const p = buildUrlParams(s);
    expect(p.get("sort")).toBe("state");
    expect(p.get("order")).toBe("asc");
  });

  it("default sort started_at omits the param", () => {
    const s = parseUrlState(new URLSearchParams());
    const p = buildUrlParams(s);
    expect(p.get("sort")).toBeNull();
    expect(p.get("order")).toBeNull();
  });

  it("CLEAR_ALL_FILTERS_PATCH does not reset sort/order", () => {
    // Sort/order are deliberately not in the clear-all patch — the
    // user clearing filters keeps their column ordering preference.
    expect("sort" in CLEAR_ALL_FILTERS_PATCH).toBe(false);
    expect("order" in CLEAR_ALL_FILTERS_PATCH).toBe(false);
  });
});

describe("formatRelativeTime — S-TBL-1 column display", () => {
  it("renders seconds for sub-minute deltas", () => {
    const recent = new Date(Date.now() - 12_000).toISOString();
    expect(formatRelativeTime(recent)).toMatch(/^\d{1,2}s ago$/);
  });

  it("renders minutes for sub-hour deltas", () => {
    const m5 = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(m5)).toBe("5m ago");
  });

  it("renders hours for sub-day deltas", () => {
    const h2 = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(h2)).toBe("2h ago");
  });

  it("renders days for >= 24h deltas", () => {
    const d3 = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(d3)).toBe("3d ago");
  });
});
