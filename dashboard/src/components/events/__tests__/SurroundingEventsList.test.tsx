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
    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sibling" }),
    );
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
