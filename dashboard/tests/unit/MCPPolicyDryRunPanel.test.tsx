import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    dryRunMCPPolicy: vi.fn(),
  };
});

import { dryRunMCPPolicy } from "@/lib/api";
import { MCPPolicyDryRunPanel } from "@/components/policy/MCPPolicyDryRunPanel";
import type { MCPPolicy } from "@/lib/types";

const dryRunMock = dryRunMCPPolicy as unknown as Mock;

const policy: MCPPolicy = {
  id: "policy-1",
  scope: "global",
  scope_value: null,
  mode: "blocklist",
  block_on_uncertainty: false,
  version: 3,
  created_at: "2026-05-05T00:00:00Z",
  updated_at: "2026-05-05T00:00:00Z",
  entries: [],
};

beforeEach(() => {
  dryRunMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MCPPolicyDryRunPanel", () => {
  it("renders the idle state with the canonical 'Run dry-run' CTA before any run", () => {
    render(
      <MCPPolicyDryRunPanel
        flavor="global"
        scopeKey="global"
        policy={policy}
      />,
    );

    expect(screen.getByTestId("mcp-policy-dry-run-idle")).toBeTruthy();
    expect(
      screen.getByTestId("mcp-policy-dry-run-button-global").textContent,
    ).toContain("Run dry-run");
  });

  it("posts the policy as the dry-run draft and surfaces the unresolvable callout", async () => {
    dryRunMock.mockResolvedValue({
      hours: 24,
      events_replayed: 7,
      per_server: [],
      unresolvable_count: 7,
    });

    render(
      <MCPPolicyDryRunPanel
        flavor="global"
        scopeKey="global"
        policy={policy}
      />,
    );

    fireEvent.click(screen.getByTestId("mcp-policy-dry-run-button-global"));

    await waitFor(() => {
      expect(dryRunMock).toHaveBeenCalledWith(
        "global",
        {
          mode: "blocklist",
          block_on_uncertainty: false,
          entries: [],
        },
        24,
      );
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId("mcp-policy-dry-run-unresolvable")
          .textContent?.replace(/\s+/g, " ")
          .trim(),
      ).toBe("7 unresolvable");
    });
  });

  it("re-runs with the 168h window when the operator picks 'Last 7 days'", async () => {
    dryRunMock.mockResolvedValue({
      hours: 168,
      events_replayed: 0,
      per_server: [],
      unresolvable_count: 0,
    });

    render(
      <MCPPolicyDryRunPanel
        flavor="global"
        scopeKey="global"
        policy={policy}
      />,
    );

    fireEvent.click(
      screen.getByTestId("mcp-policy-dry-run-hours-global-168"),
    );
    fireEvent.click(screen.getByTestId("mcp-policy-dry-run-button-global"));

    await waitFor(() => {
      expect(dryRunMock).toHaveBeenCalledWith(
        "global",
        expect.any(Object),
        168,
      );
    });
  });
});
