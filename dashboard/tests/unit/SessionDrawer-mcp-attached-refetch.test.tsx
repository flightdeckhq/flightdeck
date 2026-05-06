import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useFleetStore } from "@/store/fleet";
import type { AgentEvent } from "@/lib/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    fetchSession: vi.fn(),
  };
});

import { fetchSession } from "@/lib/api";
import { useSession } from "@/hooks/useSession";

const fetchSessionMock = fetchSession as unknown as Mock;

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: "ev-1",
    session_id: "sess-1",
    flavor: "prod",
    agent_id: "agent-1",
    agent_type: "coding",
    client_type: "flightdeck_sensor",
    event_type: "mcp_server_attached",
    timestamp: "2026-05-06T15:00:00Z",
    occurred_at: "2026-05-06T15:00:00Z",
    has_content: false,
    ...overrides,
  } as AgentEvent;
}

const SESSION_DETAIL = {
  session: {
    session_id: "sess-1",
    flavor: "prod",
    state: "active",
    agent_id: "agent-1",
    agent_type: "coding",
    client_type: "flightdeck_sensor",
    started_at: "2026-05-06T14:00:00Z",
    last_seen_at: "2026-05-06T14:00:00Z",
  },
  events: [],
  attachments: [],
} as unknown as Awaited<ReturnType<typeof fetchSession>>;

beforeEach(() => {
  fetchSessionMock.mockReset();
  fetchSessionMock.mockResolvedValue(SESSION_DETAIL);
  useFleetStore.setState({ lastEvent: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("D140 SessionDrawer mcp_server_attached re-fetch trigger", () => {
  it("bumping revalidationKey forces useSession to re-fetch", async () => {
    const { rerender } = renderHook(
      ({ key }: { key: number }) => useSession("sess-1", undefined, key),
      { initialProps: { key: 0 } },
    );

    // Initial mount fetches once.
    await act(async () => {
      await Promise.resolve();
    });
    const initialCalls = fetchSessionMock.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Bump revalidationKey — useEffect re-runs and hits the network
    // again because the cache was invalidated.
    rerender({ key: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSessionMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it("does NOT bump revalidationKey for non-mcp_server_attached events on the same session", () => {
    // Simulates the SessionDrawer's lastEvent useEffect logic
    // standalone. The trigger only fires when both event_type AND
    // session_id match.
    const lastEvent = makeEvent({
      event_type: "post_call",
      session_id: "sess-1",
    });
    const sessionId = "sess-1";

    const shouldBump =
      sessionId !== null &&
      lastEvent !== null &&
      lastEvent.session_id === sessionId &&
      lastEvent.event_type === "mcp_server_attached";

    expect(shouldBump).toBe(false);
  });

  it("does NOT bump revalidationKey for mcp_server_attached on a different session", () => {
    const lastEvent = makeEvent({
      event_type: "mcp_server_attached",
      session_id: "sess-other",
    });
    const sessionId = "sess-1";

    const shouldBump =
      sessionId !== null &&
      lastEvent !== null &&
      lastEvent.session_id === sessionId &&
      lastEvent.event_type === "mcp_server_attached";

    expect(shouldBump).toBe(false);
  });

  it("DOES bump revalidationKey for mcp_server_attached on the matching session", () => {
    const lastEvent = makeEvent({
      event_type: "mcp_server_attached",
      session_id: "sess-1",
    });
    const sessionId = "sess-1";

    const shouldBump =
      sessionId !== null &&
      lastEvent !== null &&
      lastEvent.session_id === sessionId &&
      lastEvent.event_type === "mcp_server_attached";

    expect(shouldBump).toBe(true);
  });

  it("setLastEvent action updates the fleet store's lastEvent", () => {
    expect(useFleetStore.getState().lastEvent).toBeNull();

    const event = makeEvent({ event_type: "mcp_server_attached" });
    useFleetStore.getState().setLastEvent(event);

    expect(useFleetStore.getState().lastEvent).toBe(event);
  });
});
