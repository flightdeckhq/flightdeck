import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AgentDrawerRunsTab } from "@/components/agents/AgentDrawerRunsTab";
import { fetchSessions } from "@/lib/api";
import type { SessionListItem, SessionsResponse } from "@/lib/types";

const h = vi.hoisted(() => ({
  response: {
    sessions: [],
    total: 0,
    limit: 50,
    offset: 0,
    has_more: false,
  } as SessionsResponse,
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSessions: vi.fn(async () => h.response),
  };
});

function mkRun(
  id: string,
  over: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    session_id: id,
    flavor: "agent-1",
    agent_type: "coding",
    host: null,
    model: null,
    state: "closed",
    started_at: "2026-05-15T12:00:00Z",
    ended_at: null,
    last_seen_at: "2026-05-15T12:05:00Z",
    duration_s: 300,
    tokens_used: 100,
    token_limit: null,
    context: {},
    ...over,
  };
}

async function renderTab(
  sessions: SessionListItem[],
  total: number,
  onRunClick: (s: string) => void = () => {},
) {
  h.response = {
    sessions,
    total,
    limit: 50,
    offset: 0,
    has_more: total > sessions.length,
  };
  const result = render(
    <AgentDrawerRunsTab agentId="agent-1" onRunClick={onRunClick} />,
  );
  await act(async () => {});
  return result;
}

describe("AgentDrawerRunsTab", () => {
  beforeEach(() => {
    vi.mocked(fetchSessions).mockClear();
  });

  it("renders a row per fetched run", async () => {
    await renderTab([mkRun("r1"), mkRun("r2")], 2);
    expect(
      screen.getByTestId("agent-drawer-run-row-r1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-drawer-run-row-r2"),
    ).toBeInTheDocument();
  });

  it("shows an empty state when the agent has no runs", async () => {
    await renderTab([], 0);
    expect(screen.getByTestId("agent-drawer-runs-empty")).toBeInTheDocument();
  });

  it("renders the attached pill only for re-attached runs", async () => {
    await renderTab(
      [
        mkRun("r1", { attachment_count: 3 }),
        mkRun("r2", { attachment_count: 0 }),
      ],
      2,
    );
    expect(
      screen.getAllByTestId("agent-drawer-run-attached-pill"),
    ).toHaveLength(1);
  });

  it("opens the run drawer on a row click", async () => {
    const onRunClick = vi.fn();
    await renderTab([mkRun("r1")], 1, onRunClick);
    fireEvent.click(screen.getByTestId("agent-drawer-run-row-r1"));
    expect(onRunClick).toHaveBeenCalledWith("r1");
  });

  it("re-fetches with the new sort when a sortable header is clicked", async () => {
    await renderTab([mkRun("r1")], 1);
    vi.mocked(fetchSessions).mockClear();
    fireEvent.click(screen.getByTestId("agent-drawer-runs-th-tokens_used"));
    await act(async () => {});
    const lastCall = vi.mocked(fetchSessions).mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ sort: "tokens_used" });
  });

  it("shows the error state when the fetch fails", async () => {
    vi.mocked(fetchSessions).mockRejectedValueOnce(new Error("500"));
    render(<AgentDrawerRunsTab agentId="agent-1" onRunClick={() => {}} />);
    await act(async () => {});
    expect(
      screen.getByTestId("agent-drawer-runs-error"),
    ).toBeInTheDocument();
  });
});
