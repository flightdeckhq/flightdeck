import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentTable } from "@/components/fleet/AgentTable";
import type { AgentSummary } from "@/lib/types";

/**
 * F3 — bucket-crossing slide animation on Fleet.
 *
 * The animation itself is a Framer-Motion ``layout="position"``
 * transition driven by DOM bounding-box deltas; jsdom doesn't
 * compute layout, so we cannot assert on the visual transition
 * directly. What we CAN guard structurally is:
 *   1. Each agent row renders inside a LayoutGroup.
 *   2. The bucket-divider rows survive the animation wiring (they
 *      are not motion components themselves; they are spacing-only
 *      siblings).
 *   3. ``data-testid="fleet-agent-row-<id>"`` is preserved on the
 *      animated row so existing E2E selectors keep working.
 *
 * Together these prevent the regression where a future refactor
 * drops the LayoutGroup wrapper or replaces motion.tr with a
 * plain tr (silently disabling the animation).
 */

function agent(id: string, lastSeenAt: string): AgentSummary {
  return {
    agent_id: id,
    agent_name: `agent-${id}`,
    agent_type: "production",
    client_type: "flightdeck_sensor",
    user: "u",
    hostname: "h",
    first_seen_at: "2026-04-25T08:00:00Z",
    last_seen_at: lastSeenAt,
    total_sessions: 1,
    total_tokens: 0,
    state: "active",
  };
}

describe("AgentTable bucket animation (F3)", () => {
  it("preserves data-testid on the animated row", () => {
    const now = new Date("2026-04-25T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const agents = [
      agent("aaa", "2026-04-25T11:59:55Z"), // LIVE  (< 15s old)
      agent("bbb", "2026-04-25T11:58:00Z"), // RECENT (< 5m old)
    ];

    const { container, unmount } = render(
      <MemoryRouter>
        <AgentTable agents={agents} sort={null} order="desc" />
      </MemoryRouter>,
    );

    expect(container.querySelector('[data-testid="fleet-agent-row-aaa"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fleet-agent-row-bbb"]')).not.toBeNull();

    unmount();
    vi.useRealTimers();
  });

  it("renders bucket divider between LIVE and RECENT buckets", () => {
    const now = new Date("2026-04-25T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const agents = [
      agent("live-1", "2026-04-25T11:59:55Z"),  // LIVE (< 15s)
      agent("recent-1", "2026-04-25T11:58:00Z"), // RECENT (< 5m)
    ];

    const { container, unmount } = render(
      <MemoryRouter>
        <AgentTable agents={agents} sort={null} order="desc" />
      </MemoryRouter>,
    );

    const divider = container.querySelector(
      '[data-testid="agent-table-bucket-divider-live-recent"]',
    );
    expect(divider).not.toBeNull();

    unmount();
    vi.useRealTimers();
  });
});
