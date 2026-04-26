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

import { formatSessionTimestamp } from "@/lib/time";
import {
  parseUrlState,
  buildUrlParams,
  CLEAR_ALL_FILTERS_PATCH,
} from "@/pages/Investigate";

// Same shape Investigate.tsx and formatSessionTimestamp use for the
// >= 60-min absolute branch. Duplicated here so the assertion is
// independent of the implementation -- a copy-paste drift would
// surface as a test failure.
const ABSOLUTE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};
const absoluteOf = (iso: string) =>
  new Date(iso).toLocaleString(undefined, ABSOLUTE_FORMAT);

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

describe("formatSessionTimestamp — S-TBL-1 column display", () => {
  it("renders 'just now' for sub-minute deltas", () => {
    const recent = new Date(Date.now() - 12_000).toISOString();
    expect(formatSessionTimestamp(recent)).toBe("just now");
  });

  it("renders minutes ago for 1-59m deltas", () => {
    const m5 = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatSessionTimestamp(m5)).toBe("5m ago");
  });

  it("renders 59m ago at the upper edge of the relative window", () => {
    const m59 = new Date(Date.now() - 59 * 60_000).toISOString();
    expect(formatSessionTimestamp(m59)).toBe("59m ago");
  });

  it("flips to absolute format at exactly 60 minutes", () => {
    const m60 = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(formatSessionTimestamp(m60)).toBe(absoluteOf(m60));
  });

  it("renders absolute format at 61 minutes", () => {
    const m61 = new Date(Date.now() - 61 * 60_000).toISOString();
    expect(formatSessionTimestamp(m61)).toBe(absoluteOf(m61));
  });

  it("renders absolute format for 3h deltas", () => {
    const h3 = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const out = formatSessionTimestamp(h3);
    expect(out).toBe(absoluteOf(h3));
    expect(out).not.toMatch(/ago$/);
  });

  it("renders absolute format for 1d deltas", () => {
    const d1 = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const out = formatSessionTimestamp(d1);
    expect(out).toBe(absoluteOf(d1));
    expect(out).not.toMatch(/ago$/);
  });

  it("renders absolute format for 8d deltas", () => {
    const d8 = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const out = formatSessionTimestamp(d8);
    expect(out).toBe(absoluteOf(d8));
    expect(out).not.toMatch(/ago$/);
  });
});
