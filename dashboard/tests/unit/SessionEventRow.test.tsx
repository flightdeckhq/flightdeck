import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { scaleTime } from "d3-scale";
import { SessionEventRow } from "@/components/timeline/SessionEventRow";
import type { Session } from "@/lib/types";

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: () => ({ events: [], loading: false }),
  attachmentsCache: new Map(),
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

function renderRow(
  session: Session,
  opts: { sessionIndex?: number; leftPanelWidth?: number } = {},
) {
  const { sessionIndex = 0, leftPanelWidth = 320 } = opts;
  return render(
    <SessionEventRow
      session={session}
      sessionIndex={sessionIndex}
      scale={makeScale()}
      onClick={() => {}}
      timelineWidth={900}
      leftPanelWidth={leftPanelWidth}
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

  it("renders a 1-based session number prefix from the zero-based sessionIndex prop", () => {
    renderRow(baseSession, { sessionIndex: 2 });
    expect(screen.getByTestId("session-row-index").textContent).toBe("3");
  });

  it("hides the token count when leftPanelWidth is below the threshold", () => {
    renderRow(baseSession, { leftPanelWidth: 200 });
    expect(screen.queryByTestId("session-row-tokens")).not.toBeInTheDocument();
  });

  it("shows the token count when leftPanelWidth is at or above the threshold", () => {
    renderRow(baseSession, { leftPanelWidth: 300 });
    expect(screen.getByTestId("session-row-tokens")).toBeInTheDocument();
    expect(
      screen.getByTestId("session-row-tokens").textContent,
    ).toContain("17,600");
  });

  it("shows the session hash below the hostname when both are available", () => {
    renderRow({
      ...baseSession,
      context: { hostname: "mac-laptop", os: "Darwin" },
    });
    expect(screen.getByTestId("session-row-label").textContent).toBe(
      "mac-laptop",
    );
    // Secondary hash line appears because hostname took the primary slot.
    expect(screen.getByTestId("session-row-hash").textContent).toBe("fcc640eb");
  });

  it("does not render the secondary hash line when there is no hostname", () => {
    // Without a hostname the hash IS the identity -- showing it twice
    // would waste space.
    renderRow({
      ...baseSession,
      context: { os: "Linux" },
    });
    expect(screen.queryByTestId("session-row-hash")).not.toBeInTheDocument();
  });

  it("hover tooltip stacks hostname on line 1 and session id on line 2 when hostname exists", () => {
    const { container } = renderRow({
      ...baseSession,
      context: { hostname: "mac-laptop-alice" },
    });
    // Title attribute lives on the sticky left-panel container.
    // Native browser tooltips render '\n' as a line break.
    const sticky = container.querySelector(
      '[title*="mac-laptop-alice"]',
    ) as HTMLElement;
    expect(sticky).not.toBeNull();
    expect(sticky.getAttribute("title")).toBe(
      `mac-laptop-alice\n${baseSession.session_id}`,
    );
  });

  it("hover tooltip shows just the session id when there is no hostname", () => {
    const { container } = renderRow({ ...baseSession, context: {} });
    const sticky = container.querySelector(
      `[title="${baseSession.session_id}"]`,
    ) as HTMLElement;
    expect(sticky).not.toBeNull();
    // No newline when there's nothing to stack above.
    expect(sticky.getAttribute("title")).toBe(baseSession.session_id);
  });

  it("renders the access token name pill when token_name is non-null", () => {
    renderRow({ ...baseSession, token_name: "Staging K8s" });
    const badge = screen.getByTestId("session-row-token-name");
    expect(badge.textContent).toBe("Staging K8s");
  });

  it("omits the token name pill when token_name is null (tok_dev / pre-Phase-5 rows)", () => {
    renderRow({ ...baseSession, token_name: null });
    expect(
      screen.queryByTestId("session-row-token-name"),
    ).not.toBeInTheDocument();
  });

  it("omits the token name pill when token_name field is absent entirely", () => {
    renderRow(baseSession);
    expect(
      screen.queryByTestId("session-row-token-name"),
    ).not.toBeInTheDocument();
  });
});
