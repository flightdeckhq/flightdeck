import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return { ...actual, fetchBulkEvents: vi.fn() };
});

import { fetchBulkEvents, type BulkEventsParams } from "@/lib/api";
import {
  eventInstantISO,
  findSessionEvent,
  parseEventInstant,
} from "@/hooks/findSessionEvent";
import { eventsCache, fullHistoryLoaded } from "@/hooks/useSessionEvents";
import { EVENT_LOOKUP_MAX_PAGES } from "@/lib/constants";
import type { AgentEvent } from "@/lib/types";

const fetchMock = fetchBulkEvents as unknown as Mock;
const RUN = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-11-04T09:00:00Z");

/** A run of ``n`` events, one a second, oldest first. */
function run(n: number): AgentEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    session_id: RUN,
    flavor: "f",
    event_type: "post_call",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: new Date(T0 + i * 1000).toISOString(),
  }));
}

/** Serve ``GET /v1/events`` over ``events`` as the API does: from/to
 *  inclusive, (occurred_at, id) order, the keyset cursor, a limit. */
function serve(events: AgentEvent[]) {
  fetchMock.mockImplementation(async (p: BulkEventsParams) => {
    const from = Date.parse(p.from);
    const to = p.to ? Date.parse(p.to) : Infinity;
    let rows = events.filter((e) => {
      const t = Date.parse(e.occurred_at);
      return t >= from && t <= to;
    });
    if (p.before) {
      const b = Date.parse(p.before);
      rows = rows.filter((e) => {
        const t = Date.parse(e.occurred_at);
        return t < b || (t === b && p.before_id !== undefined && e.id < p.before_id);
      });
    }
    if (p.order === "desc") rows = [...rows].reverse();
    const limit = p.limit ?? 100;
    return { events: rows.slice(0, limit), total: rows.length, limit, offset: 0, has_more: rows.length > limit };
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  eventsCache.clear();
  fullHistoryLoaded.clear();
});

describe("findSessionEvent", () => {
  it("finds an event newer than the run's oldest 2,000 (the old lookup's blind spot)", async () => {
    const events = run(5000);
    serve(events);
    const target = events[4500]!;
    const found = await findSessionEvent({ sessionId: RUN, eventId: target.id });
    expect(found?.id).toBe(target.id);
    // The newest page holds it: one request, newest first.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toMatchObject({ order: "desc", session_id: RUN });
  });

  it("finds an event older than the run's newest 2,000, reading back with the keyset cursor", async () => {
    const events = run(5000);
    serve(events);
    const target = events[100]!;
    const found = await findSessionEvent({ sessionId: RUN, eventId: target.id });
    expect(found?.id).toBe(target.id);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const second = fetchMock.mock.calls[1]![0] as BulkEventsParams;
    expect(second.before_id).toBe(events[3000]!.id);
    // The pages reach back from the newest without a gap: merged whole,
    // in order, and the run is known whole once its start is read.
    expect(eventsCache.get(RUN)).toHaveLength(5000);
    expect(eventsCache.get(RUN)![0]!.id).toBe(events[0]!.id);
    expect(fullHistoryLoaded.has(RUN)).toBe(true);
  });

  it("with the event's timestamp, asks for that instant once and leaves the cache alone", async () => {
    const events = run(5000);
    serve(events);
    const target = events[100]!;
    const found = await findSessionEvent({ sessionId: RUN, eventId: target.id, at: target.occurred_at });
    expect(found?.id).toBe(target.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toMatchObject({
      from: target.occurred_at,
      to: new Date(Date.parse(target.occurred_at) + 1).toISOString(),
    });
    expect(eventsCache.has(RUN)).toBe(false);
  });

  it("reads the search API's Postgres-form timestamp, to the microsecond", async () => {
    const events = run(5000);
    serve(events);
    const target = events[100]!;
    // "2026-11-04T09:01:40.000Z" as the search API writes it.
    const pgForm = target.occurred_at.replace("T", " ").replace(".000Z", ".000417+00");
    const found = await findSessionEvent({ sessionId: RUN, eventId: target.id, at: pgForm });
    expect(found?.id).toBe(target.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toMatchObject({ from: target.occurred_at });
  });

  it("falls back to reading the run when the instant request fails", async () => {
    const events = run(3000);
    serve(events);
    const serveRun = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("400 from must be ISO 8601");
    });
    fetchMock.mockImplementation(serveRun);
    const target = events[2950]!;
    const found = await findSessionEvent({ sessionId: RUN, eventId: target.id, at: target.occurred_at });
    expect(found?.id).toBe(target.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to reading the run when the timestamp misses", async () => {
    const events = run(3000);
    serve(events);
    const target = events[2900]!;
    const found = await findSessionEvent({
      sessionId: RUN,
      eventId: target.id,
      at: "2026-11-04T08:00:00Z",
    });
    expect(found?.id).toBe(target.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves to null for an event the run does not hold, after reading it to its start", async () => {
    serve(run(3000));
    const found = await findSessionEvent({
      sessionId: RUN,
      eventId: "99999999-9999-4999-8999-999999999999",
    });
    expect(found).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after EVENT_LOOKUP_MAX_PAGES pages", async () => {
    let page = 0;
    fetchMock.mockImplementation(async () => {
      page += 1;
      const e = run(1)[0]!;
      return {
        events: [{ ...e, id: `00000000-0000-4000-9000-${String(page).padStart(12, "0")}` }],
        total: 1_000_000,
        limit: 2000,
        offset: 0,
        has_more: true,
      };
    });
    const found = await findSessionEvent({
      sessionId: RUN,
      eventId: "99999999-9999-4999-8999-999999999999",
    });
    expect(found).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(EVENT_LOOKUP_MAX_PAGES);
  });
});

describe("parseEventInstant", () => {
  it("reads Postgres's text form as ISO 8601", () => {
    expect(parseEventInstant("2026-11-04 19:02:50.756123+00")).toBe(
      Date.parse("2026-11-04T19:02:50.756Z"),
    );
    expect(parseEventInstant("2026-11-04 21:02:50.756+02")).toBe(
      Date.parse("2026-11-04T19:02:50.756Z"),
    );
    expect(parseEventInstant("2026-11-05 00:32:50.756+05:30")).toBe(
      Date.parse("2026-11-04T19:02:50.756Z"),
    );
    expect(parseEventInstant("2026-11-04 14:02:50-05")).toBe(
      Date.parse("2026-11-04T19:02:50Z"),
    );
  });

  it("rewrites the text form itself, not relying on an engine extension", () => {
    expect(eventInstantISO("2026-11-04 19:02:50.756123+00")).toBe(
      "2026-11-04T19:02:50.756+00:00",
    );
    expect(eventInstantISO("2026-11-04 19:02:50.7+00")).toBe("2026-11-04T19:02:50.7+00:00");
    expect(eventInstantISO("2026-11-05 00:32:50+05:30")).toBe("2026-11-05T00:32:50+05:30");
    expect(eventInstantISO("2026-11-04 14:02:50-05")).toBe("2026-11-04T14:02:50-05:00");
    expect(eventInstantISO("2026-11-04")).toBe("2026-11-04");
  });

  it("passes an ISO timestamp through unchanged", () => {
    for (const iso of ["2026-11-04T19:02:50.756Z", "2026-11-04T21:02:50.756+02:00"]) {
      expect(parseEventInstant(iso)).toBe(Date.parse(iso));
    }
  });

  it("is NaN for text that is not a timestamp", () => {
    expect(parseEventInstant("not a time")).toBeNaN();
    expect(parseEventInstant("")).toBeNaN();
  });
});
