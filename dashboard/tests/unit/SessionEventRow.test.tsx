import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { scaleTime } from "d3-scale";
import { SessionEventRow } from "@/components/timeline/SessionEventRow";
import type { Session } from "@/lib/types";

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: () => ({ events: [], loading: false }),
}));

const baseSession: Session = {
  session_id: "fcc640eb-5325-4658-ab48-335e975993d8",
  flavor: "claude-code",
  agent_type: "developer",
  host: "bob-laptop",
  framework: "claude-code",
  model: "claude-sonnet-4-6",
  state: "active",
  started_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  ended_at: null,
  tokens_used: 17600,
  token_limit: null,
};

function makeScale() {
  return scaleTime()
    .domain([new Date(Date.now() - 60_000), new Date()])
    .range([0, 900]);
}

function renderRow(session: Session) {
  return render(
    <SessionEventRow
      session={session}
      scale={makeScale()}
      onClick={() => {}}
      viewMode="swimlane"
      start={new Date(Date.now() - 60_000)}
      end={new Date()}
      timelineWidth={900}
    />,
  );
}

describe("SessionEventRow", () => {
  it("shows the truncated session id when no context is present", () => {
    renderRow(baseSession);
    const label = screen.getByTestId("session-row-label");
    // truncateSessionId returns the first 8 chars
    expect(label.textContent).toBe("fcc640eb");
  });

  it("shows the hostname when context.hostname is present", () => {
    renderRow({
      ...baseSession,
      context: {
        hostname: "bob-laptop",
        os: "Darwin",
      },
    });
    const label = screen.getByTestId("session-row-label");
    expect(label.textContent).toBe("bob-laptop");
  });

  it("renders the OS icon when context.os is present", () => {
    renderRow({
      ...baseSession,
      context: { os: "Linux" },
    });
    expect(screen.getByTestId("os-icon-linux")).toBeInTheDocument();
  });

  it("renders the orchestration icon when context.orchestration is present", () => {
    renderRow({
      ...baseSession,
      context: { orchestration: "kubernetes" },
    });
    expect(screen.getByTestId("orch-icon-kubernetes")).toBeInTheDocument();
  });

  it("renders both icons together when context has os + orchestration", () => {
    renderRow({
      ...baseSession,
      context: {
        os: "Linux",
        orchestration: "kubernetes",
        hostname: "k8s-prod-1",
      },
    });
    expect(screen.getByTestId("os-icon-linux")).toBeInTheDocument();
    expect(screen.getByTestId("orch-icon-kubernetes")).toBeInTheDocument();
    expect(screen.getByTestId("session-row-label").textContent).toBe(
      "k8s-prod-1",
    );
  });

  it("does not render OS icon when context.os is missing", () => {
    renderRow({
      ...baseSession,
      context: { hostname: "bob-laptop" },
    });
    expect(screen.queryByTestId("os-icon-darwin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("os-icon-linux")).not.toBeInTheDocument();
  });
});
