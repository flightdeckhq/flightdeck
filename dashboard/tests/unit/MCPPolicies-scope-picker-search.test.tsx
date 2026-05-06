// Step 6.7 (d): the scope picker on /mcp-policies replaces the
// pre-fix Radix Select with a button + filter panel. Standard
// pattern for a dropdown over ~20 items — at 67+ flavors the
// alphabetical list became impossible to scan. These tests lock
// the search behavior so a future refactor can't drop it.

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { MCPPolicies } from "@/pages/MCPPolicies";

// MCPPolicies fetches global + flavors on mount. We mock the API
// surface so the component renders without hitting the network.
import { vi } from "vitest";
vi.mock("@/lib/api", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("@/lib/api");
  const stubPolicy = {
    id: "global-policy",
    scope: "global",
    scope_value: null,
    mode: "blocklist",
    block_on_uncertainty: false,
    version: 1,
    created_at: "2026-05-06T00:00:00Z",
    updated_at: "2026-05-06T00:00:00Z",
    entries: [],
  };
  return {
    ...actual,
    fetchGlobalMCPPolicy: vi.fn().mockResolvedValue(stubPolicy),
    fetchFlavors: vi
      .fn()
      .mockResolvedValue([
        "alpha-prod",
        "beta-staging",
        "gamma-dev",
        "delta-canary",
        "epsilon-shadow",
        "production",
        "staging",
      ]),
    fetchFlavorMCPPolicy: vi.fn().mockResolvedValue(null),
    createFlavorMCPPolicy: vi.fn(),
    updateFlavorMCPPolicy: vi.fn(),
    updateGlobalMCPPolicy: vi.fn(),
  };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/mcp-policies"]}>
      <MCPPolicies />
    </MemoryRouter>,
  );
}

describe("MCP Policies scope picker — searchable combobox (step 6.7 d)", () => {
  it("opens the panel when the trigger is clicked", async () => {
    renderPage();
    // Wait for the flavors to load and the trigger to render.
    const trigger = await screen.findByTestId("mcp-policies-scope-select");
    expect(screen.queryByTestId("mcp-policies-scope-panel")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId("mcp-policies-scope-panel")).toBeTruthy();
    expect(screen.getByTestId("mcp-policies-scope-search")).toBeTruthy();
  });

  it("filters the visible options as the operator types", async () => {
    renderPage();
    const trigger = await screen.findByTestId("mcp-policies-scope-select");
    fireEvent.click(trigger);

    // All 7 flavor scopes + Global = 8 options visible at start.
    // Wait for the flavors to populate.
    await screen.findByTestId("mcp-policies-tab-flavor:alpha-prod");

    const search = screen.getByTestId(
      "mcp-policies-scope-search",
    ) as HTMLInputElement;

    fireEvent.change(search, { target: { value: "stag" } });
    // Two scopes contain "stag": beta-staging and staging.
    expect(screen.getByTestId("mcp-policies-tab-flavor:beta-staging")).toBeTruthy();
    expect(screen.getByTestId("mcp-policies-tab-flavor:staging")).toBeTruthy();
    // alpha-prod / gamma-dev / Global drop out.
    expect(screen.queryByTestId("mcp-policies-tab-flavor:alpha-prod")).toBeNull();
    expect(screen.queryByTestId("mcp-policies-tab-flavor:gamma-dev")).toBeNull();
    expect(screen.queryByTestId("mcp-policies-tab-global")).toBeNull();
  });

  it("renders an empty-state message when no scope matches the query", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("mcp-policies-scope-select"));
    await screen.findByTestId("mcp-policies-tab-flavor:alpha-prod");

    fireEvent.change(screen.getByTestId("mcp-policies-scope-search"), {
      target: { value: "definitely-not-a-flavor" },
    });
    const empty = screen.getByTestId("mcp-policies-scope-empty");
    expect(empty.textContent).toContain("No scopes match");
  });

  it("commits the click selection and closes the panel", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("mcp-policies-scope-select"));
    const target = await screen.findByTestId(
      "mcp-policies-tab-flavor:production",
    );
    fireEvent.click(target);

    // Panel collapses and the trigger now reads the selected
    // flavor.
    expect(screen.queryByTestId("mcp-policies-scope-panel")).toBeNull();
    const trigger = screen.getByTestId("mcp-policies-scope-select");
    expect(trigger.textContent).toContain("production");
  });

  it("dismisses on Escape", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("mcp-policies-scope-select"));
    const search = await screen.findByTestId("mcp-policies-scope-search");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByTestId("mcp-policies-scope-panel")).toBeNull();
  });

  it("Enter on a highlighted option commits the selection (keyboard nav)", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("mcp-policies-scope-select"));
    const search = await screen.findByTestId("mcp-policies-scope-search");
    // Filter so the option count is small + deterministic.
    fireEvent.change(search, { target: { value: "alpha" } });
    // First filtered option is highlighted by default; pressing
    // Enter commits it.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.queryByTestId("mcp-policies-scope-panel")).toBeNull();
    const trigger = screen.getByTestId("mcp-policies-scope-select");
    expect(trigger.textContent).toContain("alpha-prod");
  });
});
