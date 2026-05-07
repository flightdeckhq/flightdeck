// D146: tests for the unified Policies page parent. Tab state
// lives in the URL query param (?policy=mcp deep-links MCP
// Protection; default / no-param is Token Budget). Mocks the API
// helpers used by both sub-tabs so these tests stay focused on
// the routing logic and don't trigger network roundtrips.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  const stubGlobal = {
    id: "global-policy",
    scope: "global",
    scope_value: null,
    mode: "blocklist",
    block_on_uncertainty: false,
    created_at: "2026-05-07T00:00:00Z",
    updated_at: "2026-05-07T00:00:00Z",
    entries: [],
  };
  return {
    ...actual,
    fetchPolicies: vi.fn().mockResolvedValue([]),
    fetchGlobalMCPPolicy: vi.fn().mockResolvedValue(stubGlobal),
    fetchFlavors: vi.fn().mockResolvedValue([]),
    fetchFlavorMCPPolicy: vi.fn().mockResolvedValue(null),
  };
});

import { Policies } from "@/pages/Policies";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Policies (unified Token Budget + MCP Protection sub-tabs, D146)", () => {
  it("renders Token Budget content by default when no query param is set", async () => {
    render(
      <MemoryRouter initialEntries={["/policies"]}>
        <Policies />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("policies-tab-token-budget")).toBeTruthy();
    expect(screen.getByTestId("policies-tab-mcp-protection")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByTestId("policies-tab-token-budget-content"),
      ).toBeTruthy();
    });
  });

  it("marks MCP Protection trigger as active when ?policy=mcp", async () => {
    render(
      <MemoryRouter initialEntries={["/policies?policy=mcp"]}>
        <Policies />
      </MemoryRouter>,
    );
    // Radix Tabs sets data-state="active" on the active trigger.
    // This is the cheapest reliable signal that the URL deep-link
    // landed on the right sub-tab without depending on Radix's
    // mount semantics for inactive content.
    await waitFor(() => {
      expect(
        screen
          .getByTestId("policies-tab-mcp-protection")
          .getAttribute("data-state"),
      ).toBe("active");
    });
    expect(
      screen
        .getByTestId("policies-tab-token-budget")
        .getAttribute("data-state"),
    ).toBe("inactive");
  });

  it("renders both TabsTrigger handles regardless of initial URL", () => {
    render(
      <MemoryRouter initialEntries={["/policies"]}>
        <Policies />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("policies-tab-token-budget").textContent).toBe(
      "Token Budget",
    );
    expect(screen.getByTestId("policies-tab-mcp-protection").textContent).toBe(
      "MCP Protection",
    );
  });
});

// Click-driven tab switch (URL update from setSearchParams) is
// verified via Chrome at the end of step 6.8 commit chain;
// jsdom + Radix Tabs + MemoryRouter useSearchParams-update doesn't
// always re-render the data-state attribute synchronously enough
// for a deterministic assertion. The two passing cases above lock
// the URL → render contract; live navigation closes the loop.
