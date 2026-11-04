import { afterEach, describe, expect, it, vi } from "vitest";

// The swimlane ends a lost run, and a run the orphan-timeout reaper
// closed, at its last signal. The fleet store must therefore keep the
// ``last_seen_at`` and ``close_reasons`` that GET /v1/sessions returns
// on each run it hands the swimlane, rather than stand in ended_at or
// "now" for the last signal.

const AGENT_ID = "11111111-2222-4333-8444-555555555555";

vi.mock("@/lib/api", () => ({
  fetchFleet: vi.fn(async () => ({
    agents: [
      {
        agent_id: AGENT_ID,
        agent_name: "worker",
        agent_type: "coding",
        client_type: "claude_code",
        user: "e2e",
        hostname: "host",
        first_seen_at: "2026-11-01T00:00:00Z",
        last_seen_at: "2026-11-02T09:00:00Z",
        total_sessions: 2,
        total_tokens: 0,
        state: "lost",
        topology: "lone",
        // A run reaped after more than a day of silence: older than the
        // 24 h sessions page, so only the rollup carries it.
        recent_sessions: [
          {
            session_id: "rollup-reaped-run",
            flavor: "e2e",
            agent_type: "coding",
            agent_id: AGENT_ID,
            state: "closed",
            started_at: "2026-10-31T06:00:00Z",
            ended_at: "2026-11-02T08:00:00Z",
            last_seen_at: "2026-10-31T07:00:00Z",
            tokens_used: 0,
            capture_enabled: false,
            close_reasons: ["orphan_timeout"],
          },
        ],
      },
    ],
    total: 1,
    page: 1,
    per_page: 200,
    context_facets: {},
  })),
  fetchSessions: vi.fn(async () => ({
    sessions: [
      {
        session_id: "lost-run",
        agent_id: AGENT_ID,
        flavor: "e2e",
        agent_type: "coding",
        host: null,
        model: null,
        state: "lost",
        started_at: "2026-11-02T07:00:00Z",
        ended_at: null,
        last_seen_at: "2026-11-02T07:05:00Z",
        duration_s: 300,
        tokens_used: 0,
        token_limit: null,
        context: {},
        capture_enabled: false,
        close_reasons: [],
      },
      {
        session_id: "reaped-run",
        agent_id: AGENT_ID,
        flavor: "e2e",
        agent_type: "coding",
        host: null,
        model: null,
        state: "closed",
        started_at: "2026-11-01T06:00:00Z",
        ended_at: "2026-11-02T08:00:00Z",
        last_seen_at: "2026-11-01T06:30:00Z",
        duration_s: 1800,
        tokens_used: 0,
        token_limit: null,
        context: {},
        capture_enabled: false,
        close_reasons: ["orphan_timeout"],
      },
    ],
    total: 2,
  })),
  fetchCustomDirectives: vi.fn(async () => []),
}));

import { useFleetStore } from "@/store/fleet";
import type { Session } from "@/lib/types";

afterEach(() => {
  useFleetStore.setState({ agents: [], flavors: [], loading: false, error: null });
});

function runOf(id: string) {
  const row = useFleetStore.getState().flavors.find((f) => f.flavor === AGENT_ID);
  return row?.sessions.find((s) => s.session_id === id);
}

describe("fleet store keeps each run's last signal", () => {
  it("keeps a lost run's last_seen_at from GET /v1/sessions", async () => {
    await useFleetStore.getState().load();
    expect(runOf("lost-run")?.last_seen_at).toBe("2026-11-02T07:05:00Z");
  });

  it("keeps a reaped run's last_seen_at and its close_reasons", async () => {
    await useFleetStore.getState().load();
    const reaped = runOf("reaped-run");
    expect(reaped?.last_seen_at).toBe("2026-11-01T06:30:00Z");
    expect(reaped?.ended_at).toBe("2026-11-02T08:00:00Z");
    expect(reaped?.close_reasons).toEqual(["orphan_timeout"]);
  });
});

describe("fleet store keeps a run's close reasons", () => {
  it("takes them from the recent_sessions rollup for a run older than the sessions page", async () => {
    await useFleetStore.getState().load();
    expect(runOf("rollup-reaped-run")?.close_reasons).toEqual(["orphan_timeout"]);
  });

  it("keeps them across a live update whose row lacks them, and takes new ones", async () => {
    await useFleetStore.getState().load();
    const reaped = runOf("reaped-run")!;
    const update = (session: Session) =>
      useFleetStore.getState().applyUpdate({ type: "session_update", session });

    const { close_reasons: _dropped, ...withoutReasons } = reaped;
    update({ ...withoutReasons, tokens_used: 5 });
    expect(runOf("reaped-run")?.tokens_used).toBe(5);
    expect(runOf("reaped-run")?.close_reasons).toEqual(["orphan_timeout"]);

    update({ ...reaped, close_reasons: ["normal_exit", "orphan_timeout"] });
    expect(runOf("reaped-run")?.close_reasons).toEqual(["normal_exit", "orphan_timeout"]);
  });
});
