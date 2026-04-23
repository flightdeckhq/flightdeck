import { describe, it, expect, vi, beforeEach } from "vitest";

// This test guards the "Cannot read properties of null (reading 'map')"
// runtime crash the user hit on the Phase 2 regression-fix branch.
// Root cause was ``api/internal/store/postgres.go::GetAgentFleet``
// returning a nil Go slice on an empty fleet, which JSON-encoded to
// ``null`` and crashed the dashboard's ``fleet.agents.map(...)`` in
// the store seed. The backend now returns ``make([]AgentSummary, 0)``
// so the wire always carries ``[]``; this test pins the frontend's
// belt-and-suspenders guard in place so a future wire-contract
// regression cannot re-surface the crash.

const fetchFleetMock = vi.fn();
const fetchSessionsMock = vi.fn();
const fetchCustomDirectivesMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchFleet: (...args: unknown[]) => fetchFleetMock(...args),
  fetchSessions: (...args: unknown[]) => fetchSessionsMock(...args),
  fetchCustomDirectives: (...args: unknown[]) =>
    fetchCustomDirectivesMock(...args),
}));

// eslint-disable-next-line import/first
import { useFleetStore } from "@/store/fleet";

beforeEach(() => {
  fetchFleetMock.mockReset();
  fetchSessionsMock.mockReset();
  fetchCustomDirectivesMock.mockReset();
  useFleetStore.setState({
    agents: [],
    flavors: [],
    expandedSessions: new Map(),
    enteredBucketAt: new Map(),
    loading: false,
    error: null,
  });
});

describe("useFleetStore.load -- JSON-null agents guard", () => {
  it("does not crash when /v1/fleet returns agents: null", async () => {
    // Simulate the exact wire shape a nil Go slice produces when an
    // empty fleet is encoded without the ``make([]T, 0)`` guard.
    fetchFleetMock.mockResolvedValue({
      agents: null as unknown as never,
      total: 0,
      page: 1,
      per_page: 50,
      context_facets: null,
    });
    fetchSessionsMock.mockResolvedValue({
      sessions: null as unknown as never,
      total: 0,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    fetchCustomDirectivesMock.mockResolvedValue([]);

    // Pre-fix this call would throw "Cannot read properties of null
    // (reading 'map')" from either buildFlavors or seedBucketEntries.
    await expect(useFleetStore.getState().load()).resolves.toBeUndefined();

    const s = useFleetStore.getState();
    expect(Array.isArray(s.agents)).toBe(true);
    expect(s.agents).toHaveLength(0);
    expect(Array.isArray(s.flavors)).toBe(true);
    expect(s.flavors).toHaveLength(0);
    expect(s.enteredBucketAt.size).toBe(0);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("handles partial null payloads (agents populated, sessions null)", async () => {
    // Mixed-null scenario: fleet endpoint returns real agents but
    // the sessions bootstrap call returns null. buildFlavors must
    // still produce an agent-per-row result (with empty sessions
    // arrays) rather than crashing on the null second argument.
    fetchFleetMock.mockResolvedValue({
      agents: [
        {
          agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          agent_name: "test@host",
          agent_type: "production",
          client_type: "flightdeck_sensor",
          user: "test",
          hostname: "host",
          first_seen_at: "2026-04-22T10:00:00Z",
          last_seen_at: "2026-04-23T10:00:00Z",
          total_sessions: 5,
          total_tokens: 100,
          state: "closed",
        },
      ],
      total: 1,
      page: 1,
      per_page: 50,
      context_facets: {},
    });
    fetchSessionsMock.mockResolvedValue({
      sessions: null as unknown as never,
      total: 0,
      limit: 100,
      offset: 0,
      has_more: false,
    });
    fetchCustomDirectivesMock.mockResolvedValue([]);

    await expect(useFleetStore.getState().load()).resolves.toBeUndefined();

    const s = useFleetStore.getState();
    expect(s.agents).toHaveLength(1);
    expect(s.flavors).toHaveLength(1);
    expect(s.flavors[0].sessions).toEqual([]);
  });
});
