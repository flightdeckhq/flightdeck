// The ?event=&event_session= deep-link host: it opens the event once
// its run's page loads, keeps the open event while switching to
// another one, and shows an explicit "Event not found" panel on a miss
// or a failed lookup.

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return { ...actual, fetchBulkEvents: vi.fn() };
});
vi.mock("@/components/fleet/EventDetailDrawer", () => ({
  EventDetailDrawer: ({ event }: { event: { id: string } | null }) =>
    event ? <div data-testid={`drawer-${event.id}`} /> : null,
}));

import { fetchBulkEvents } from "@/lib/api";
import { EventDetailDrawerHost } from "@/App";

const fetchMock = fetchBulkEvents as unknown as Mock;

const SESSION = "11111111-1111-4111-8111-111111111111";
const E1 = "22222222-2222-4222-8222-222222222222";
const E2 = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";

let setParams: ReturnType<typeof useSearchParams>[1] = () => undefined;
function ParamsHandle() {
  setParams = useSearchParams()[1];
  return null;
}

function renderAt(eventId: string) {
  return render(
    <MemoryRouter initialEntries={[`/?event=${eventId}&event_session=${SESSION}`]}>
      <ParamsHandle />
      <EventDetailDrawerHost />
    </MemoryRouter>,
  );
}

function page() {
  return { events: [{ id: E1 }, { id: E2 }], has_more: false };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("EventDetailDrawerHost", () => {
  it("keeps the open event while the next one loads, then switches", async () => {
    let releaseSecond: (v: unknown) => void = () => undefined;
    fetchMock
      .mockResolvedValueOnce(page())
      .mockImplementationOnce(() => new Promise((resolve) => (releaseSecond = resolve)));
    renderAt(E1);
    await waitFor(() => expect(screen.getByTestId(`drawer-${E1}`)).toBeTruthy());

    act(() => setParams({ event: E2, event_session: SESSION }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId(`drawer-${E1}`)).toBeTruthy();

    await act(async () => releaseSecond(page()));
    expect(screen.getByTestId(`drawer-${E2}`)).toBeTruthy();
    expect(screen.queryByTestId(`drawer-${E1}`)).toBeNull();
  });

  it("shows the not-found panel when the event is not in the page", async () => {
    fetchMock.mockResolvedValueOnce(page());
    renderAt(MISSING);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Event not found" })).toBeTruthy());
  });

  it("shows the not-found panel when the lookup fails, and drops the previous event", async () => {
    fetchMock.mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error("down"));
    renderAt(E1);
    await waitFor(() => expect(screen.getByTestId(`drawer-${E1}`)).toBeTruthy());

    act(() => setParams({ event: E2, event_session: SESSION }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Event not found" })).toBeTruthy());
    expect(screen.queryByTestId(`drawer-${E1}`)).toBeNull();
  });
});
