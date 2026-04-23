import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { AgentTable } from "@/components/fleet/AgentTable";
import type { AgentSummary } from "@/lib/types";
import { AgentType, ClientType } from "@/lib/agent-identity";

function mkAgent(partial: Partial<AgentSummary>): AgentSummary {
  return {
    agent_id: partial.agent_id ?? "11111111-2222-3333-4444-555555555555",
    agent_name: partial.agent_name ?? "omria@Omri-PC",
    agent_type: partial.agent_type ?? AgentType.Production,
    client_type: partial.client_type ?? ClientType.FlightdeckSensor,
    user: partial.user ?? "omria",
    hostname: partial.hostname ?? "Omri-PC",
    first_seen_at: partial.first_seen_at ?? "2026-04-22T10:00:00Z",
    last_seen_at: partial.last_seen_at ?? "2026-04-23T10:00:00Z",
    total_sessions: partial.total_sessions ?? 3,
    total_tokens: partial.total_tokens ?? 1000,
    state: partial.state ?? "active",
  };
}

// Probe component that mirrors current URL into a test hook so
// assertions can inspect query params post-navigation.
function CurrentUrl({ onUrl }: { onUrl: (url: string) => void }) {
  const loc = useLocation();
  onUrl(`${loc.pathname}${loc.search}`);
  return null;
}

describe("AgentTable row click -> Investigate navigation", () => {
  it("includes both agent_id AND from AND to query params (Bug 2a)", () => {
    // Regression guard: direct navigation with only ``agent_id=``
    // left Investigate to default its own from/to, which worked in
    // isolation but surfaced edge-case rendering where the chip fell
    // through to the UUID prefix. Explicit from/to keeps the URL
    // self-describing and matches the shape facet-click emits.
    const agents = [
      mkAgent({ agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    ];
    let capturedUrl = "";
    const onUrl = vi.fn((url: string) => {
      capturedUrl = url;
    });

    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AgentTable agents={agents} loading={false} />}
          />
          <Route
            path="/investigate"
            element={<CurrentUrl onUrl={onUrl} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(
      getByTestId("fleet-agent-row-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    );

    expect(capturedUrl.startsWith("/investigate?")).toBe(true);
    const sp = new URLSearchParams(capturedUrl.split("?")[1] ?? "");
    expect(sp.get("agent_id")).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    // Supervisor-specified "default time range (Last 7 days)".
    expect(sp.get("from")).toBeTruthy();
    expect(sp.get("to")).toBeTruthy();
    const fromMs = new Date(sp.get("from")!).getTime();
    const toMs = new Date(sp.get("to")!).getTime();
    expect(Number.isFinite(fromMs)).toBe(true);
    expect(Number.isFinite(toMs)).toBe(true);
    // from must be ~7 days before to (allow ±1 minute tolerance).
    const deltaDays = (toMs - fromMs) / 86400000;
    expect(deltaDays).toBeGreaterThan(6.99);
    expect(deltaDays).toBeLessThan(7.01);
  });
});
