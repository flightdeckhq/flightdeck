import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { AgentEvent } from "@/lib/types";

const fetchBulkEvents = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  fetchBulkEvents,
}));

import { SurroundingEventsList } from "@/components/events/SurroundingEventsList";

function ev(id: string, sessionId: string, minute: number): AgentEvent {
  return {
    id,
    session_id: sessionId,
    flavor: "agent",
    event_type: "tool_call",
    occurred_at: `2026-10-23T10:${String(minute).padStart(2, "0")}:00Z`,
    has_content: false,
  } as AgentEvent;
}

const s1 = Array.from({ length: 9 }, (_, i) => ev(`e${i}`, "s1", i));

beforeEach(() => {
  fetchBulkEvents.mockReset();
});

describe("SurroundingEventsList", () => {
  it("shows a window of events around the anchor", async () => {
    fetchBulkEvents.mockResolvedValue({ events: s1, total: 9, has_more: false });
    render(<SurroundingEventsList event={s1[4]!} onSelect={() => {}} window={1} />);
    await waitFor(() => expect(screen.getByTestId("surrounding-events-list")).toBeInTheDocument());
    expect(screen.getAllByTestId("surrounding-row")).toHaveLength(2);
    expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument();
  });

  it("moving the anchor within the same session reuses the fetched events", async () => {
    fetchBulkEvents.mockResolvedValue({ events: s1, total: 9, has_more: false });
    const { rerender } = render(
      <SurroundingEventsList event={s1[4]!} onSelect={() => {}} window={1} />,
    );
    await waitFor(() => expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument());
    rerender(<SurroundingEventsList event={s1[6]!} onSelect={() => {}} window={1} />);
    expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument();
    expect(fetchBulkEvents).toHaveBeenCalledTimes(1);
  });

  it("a different session fetches again and never shows the previous session's events", async () => {
    const s2 = [ev("x0", "s2", 0), ev("x1", "s2", 1)];
    let releaseS2: (v: unknown) => void = () => {};
    fetchBulkEvents
      .mockResolvedValueOnce({ events: s1, total: 9, has_more: false })
      .mockImplementationOnce(() => new Promise((r) => (releaseS2 = r)));
    const { rerender } = render(
      <SurroundingEventsList event={s1[4]!} onSelect={() => {}} window={1} />,
    );
    await waitFor(() => expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument());
    rerender(<SurroundingEventsList event={s2[1]!} onSelect={() => {}} window={1} />);
    expect(screen.getByTestId("surrounding-loading")).toBeInTheDocument();
    releaseS2({ events: s2, total: 2, has_more: false });
    await waitFor(() => expect(screen.getByTestId("surrounding-anchor")).toBeInTheDocument());
    expect(fetchBulkEvents).toHaveBeenCalledTimes(2);
  });

  it("reports a failed fetch", async () => {
    fetchBulkEvents.mockRejectedValue(new Error("boom"));
    render(<SurroundingEventsList event={s1[0]!} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Failed to load surrounding events: boom/)).toBeInTheDocument());
  });
});
