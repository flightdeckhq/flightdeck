import { afterEach, describe, expect, it, vi } from "vitest";

// The agent row's ``telemetry`` (which drives the OTel source pill)
// follows the agent's newest session on a live update, so the pill
// appears or goes away without a refetch when the agent's latest run
// switches source. A session the update carries without its context
// says nothing about the source and leaves the value alone.

vi.mock("@/lib/api", () => ({
  fetchFleet: vi.fn(async () => ({
    agents: [],
    total: 0,
    page: 1,
    per_page: 200,
    context_facets: {},
  })),
  fetchSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  fetchCustomDirectives: vi.fn(async () => []),
}));

import { useFleetStore } from "@/store/fleet";
import type { AgentSummary, FlavorSummary, Session } from "@/lib/types";

const AGENT = "agent-otlp";
const OLD = "2026-11-01T10:00:00Z";
const NEW = "2026-11-01T11:00:00Z";

function mkSession(over: Partial<Session>): Session {
  return {
    session_id: "s-old",
    flavor: "claude-code",
    agent_type: "coding",
    agent_id: AGENT,
    agent_name: "dev@host",
    client_type: "claude_code",
    host: null,
    framework: null,
    model: null,
    state: "active",
    started_at: OLD,
    last_seen_at: OLD,
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    ...over,
  };
}

function seed(telemetry: string | null, sessions: Session[]): void {
  const flavor: FlavorSummary = {
    flavor: AGENT,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: 1,
    tokens_used_total: 0,
    sessions,
    agent_id: AGENT,
    agent_name: "dev@host",
    client_type: "claude_code",
    last_seen_at: OLD,
    telemetry,
  };
  const agent: AgentSummary = {
    agent_id: AGENT,
    agent_name: "dev@host",
    agent_type: "coding",
    client_type: "claude_code",
    user: "dev",
    hostname: "host",
    first_seen_at: OLD,
    last_seen_at: OLD,
    total_sessions: sessions.length,
    total_tokens: 0,
    state: "active",
    topology: "lone",
    telemetry,
    recent_sessions: [],
  };
  useFleetStore.setState({
    flavors: [flavor],
    agents: [agent],
    enteredBucketAt: new Map<string, number>(),
    shuttingDown: new Set<string>(),
  });
}

const row = () => useFleetStore.getState().flavors.find((f) => f.flavor === AGENT);
const agentRow = () => useFleetStore.getState().agents.find((a) => a.agent_id === AGENT);

describe("fleet store applyUpdate — the agent's telemetry follows its newest session", () => {
  afterEach(() => {
    useFleetStore.setState({
      flavors: [],
      agents: [],
      enteredBucketAt: new Map<string, number>(),
      shuttingDown: new Set<string>(),
    });
  });

  it("a newer OTLP run turns the pill on, on the Fleet row and the agent row", () => {
    seed(null, [mkSession({ context: {} })]);
    useFleetStore.getState().applyUpdate({
      type: "session_start",
      session: mkSession({
        session_id: "s-new",
        started_at: NEW,
        last_seen_at: NEW,
        context: { telemetry: "otlp", supports_directives: false },
      }),
    });
    expect(row()?.telemetry).toBe("otlp");
    expect(agentRow()?.telemetry).toBe("otlp");
  });

  it("a newer plugin run turns it off", () => {
    seed("otlp", [mkSession({ context: { telemetry: "otlp" } })]);
    useFleetStore.getState().applyUpdate({
      type: "session_start",
      session: mkSession({
        session_id: "s-new",
        started_at: NEW,
        last_seen_at: NEW,
        context: { supports_directives: false },
      }),
    });
    expect(row()?.telemetry).toBeNull();
    expect(agentRow()?.telemetry).toBeNull();
  });

  it("an update to an older run, or one without context, leaves it alone", () => {
    seed("otlp", [mkSession({ session_id: "s-new", started_at: NEW, context: { telemetry: "otlp" } })]);
    useFleetStore.getState().applyUpdate({
      type: "session_update",
      session: mkSession({ session_id: "s-old", started_at: OLD, context: {} }),
    });
    expect(row()?.telemetry).toBe("otlp");
    useFleetStore.getState().applyUpdate({
      type: "session_update",
      session: mkSession({ session_id: "s-newest", started_at: "2026-11-01T12:00:00Z" }),
    });
    expect(row()?.telemetry).toBe("otlp");
  });
});
