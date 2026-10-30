import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SurroundingEventsList } from "../SurroundingEventsList";
import type { AgentEvent } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  fetchBulkEvents: vi.fn(),
}));

import { fetchBulkEvents } from "@/lib/api";

function makeEvent(id: string, occurred_at: string, event_type = "post_call"): AgentEvent {
  return {
    id,
    session_id: "ses-1",
    flavor: "test",
    event_type: event_type as AgentEvent["event_type"],
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    framework: null,
    client_type: null,
    agent_type: null,
    occurred_at,
  };
}

describe("SurroundingEventsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders ±N events around the anchor in occurred_at order", async () => {
    const anchor = makeEvent("anchor", "2026-05-09T07:00:05Z");
    const all = [
      makeEvent("e1", "2026-05-09T07:00:01Z"),
      makeEvent("e2", "2026-05-09T07:00:02Z"),
      makeEvent("e3", "2026-05-09T07:00:03Z"),
      makeEvent("e4", "2026-05-09T07:00:04Z"),
      anchor,
      makeEvent("e6", "2026-05-09T07:00:06Z"),
      makeEvent("e7", "2026-05-09T07:00:07Z"),
    ];
    vi.mocked(fetchBulkEvents).mockResolvedValue({
      events: all,
      total: all.length,
      limit: 100,
      offset: 0,
      has_more: false,
    });

    render(<SurroundingEventsList event={anchor} onSelect={() => {}} window={2} />);
    await waitFor(() => {
      expect(screen.queryByTestId("surrounding-loading")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument();
    // ±2 around the anchor = 5 entries (e3, e4, anchor, e6, e7).
    const rows = screen.getAllByTestId(/surrounding-(row|anchor)/);
    expect(rows.length).toBe(5);
  });

  it("calls onSelect when a non-anchor row is clicked", async () => {
    const anchor = makeEvent("anchor", "2026-05-09T07:00:05Z");
    const sibling = makeEvent("sibling", "2026-05-09T07:00:04Z");
    vi.mocked(fetchBulkEvents).mockResolvedValue({
      events: [sibling, anchor],
      total: 2,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    const onSelect = vi.fn();
    render(<SurroundingEventsList event={anchor} onSelect={onSelect} />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/surrounding-(row|anchor)/).length).toBe(2);
    });
    const rows = screen.getAllByTestId("surrounding-row");
    const firstRow = rows[0];
    if (!firstRow) throw new Error("expected at least one surrounding-row");
    fireEvent.click(firstRow);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sibling" }),
    );
  });

  function page(events: AgentEvent[]) {
    return { events, total: events.length, limit: 100, offset: 0, has_more: false };
  }

  it("fetches the events up to the anchor newest first and from it oldest first", async () => {
    const anchor = makeEvent("anchor", "2026-05-09T07:00:05.123456Z");
    vi.mocked(fetchBulkEvents).mockResolvedValue(page([anchor]));
    render(<SurroundingEventsList event={anchor} onSelect={() => {}} window={2} />);
    await waitFor(() => expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument());
    expect(vi.mocked(fetchBulkEvents).mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({ to: anchor.occurred_at, session_id: "ses-1", order: "desc", limit: 8 }),
      expect.objectContaining({ from: anchor.occurred_at, session_id: "ses-1", order: "asc", limit: 8 }),
    ]);
    expect(vi.mocked(fetchBulkEvents).mock.calls[1]?.[0]).not.toHaveProperty("to");
  });

  it("centres on an anchor deep in a long session, not on the session's oldest events", async () => {
    // A session of 100 events; the anchor is the 90th.
    const all = Array.from({ length: 100 }, (_, i) =>
      makeEvent(`e${i}`, new Date(Date.UTC(2026, 4, 9, 7, 0, i)).toISOString()),
    );
    const anchor = all[89]!;
    vi.mocked(fetchBulkEvents).mockImplementation(async (params) => {
      const limit = params.limit ?? 50;
      if (params.order === "desc") {
        return page(all.filter((e) => e.occurred_at <= params.to!).reverse().slice(0, limit));
      }
      return page(all.filter((e) => e.occurred_at >= params.from).slice(0, limit));
    });
    render(<SurroundingEventsList event={anchor} onSelect={() => {}} window={2} />);
    await waitFor(() => expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument());
    const ids = screen
      .getAllByTestId(/surrounding-(row|anchor)/)
      .map((r) => r.getAttribute("data-event-id"));
    expect(ids).toEqual(["e87", "e88", "e89", "e90", "e91"]);
    expect(screen.getByTestId("surrounding-anchor")).toHaveAttribute("data-event-id", "e89");
  });

  it("shows the events nearest the anchor's time when the anchor itself is not returned", async () => {
    const anchor = makeEvent("anchor", "2026-05-09T07:00:05Z");
    const others = [1, 2, 3, 4, 6, 7, 8, 9].map((s) =>
      makeEvent(`e${s}`, `2026-05-09T07:00:0${s}Z`),
    );
    vi.mocked(fetchBulkEvents).mockResolvedValue(page(others));
    render(<SurroundingEventsList event={anchor} onSelect={() => {}} window={2} />);
    await waitFor(() => {
      expect(screen.queryByTestId("surrounding-loading")).not.toBeInTheDocument();
    });
    // e6 is the first event at or after the anchor's time, so the
    // window is two on each side of it.
    const ids = screen.getAllByTestId("surrounding-row").map((r) => r.getAttribute("data-event-id"));
    expect(ids).toEqual(["e3", "e4", "e6", "e7", "e8"]);
  });

  it("shows fallback when fetch fails", async () => {
    vi.mocked(fetchBulkEvents).mockRejectedValue(new Error("boom"));
    render(
      <SurroundingEventsList
        event={makeEvent("anchor", "2026-05-09T07:00:00Z")}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/Failed to load surrounding events/),
      ).toBeInTheDocument();
    });
  });
});
