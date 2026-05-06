import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    resolveMCPPolicy: vi.fn(),
  };
});

import { resolveMCPPolicy } from "@/lib/api";
import { MCPPolicyResolvePanel } from "@/components/policy/MCPPolicyResolvePanel";

const resolveMock = resolveMCPPolicy as unknown as Mock;

beforeEach(() => {
  resolveMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("MCPPolicyResolvePanel", () => {
  it("renders collapsed by default and does not fetch on mount", () => {
    render(
      <MCPPolicyResolvePanel flavor="prod" scopeKey="prod" />,
    );

    expect(screen.queryByTestId("resolve-url-prod")).toBeNull();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("fetches a debounced /resolve once expanded with both fields filled", async () => {
    resolveMock.mockResolvedValue({
      decision: "allow",
      decision_path: "global_entry",
      policy_id: "policy-1",
      scope: "global",
      fingerprint: "abcdef0123456789",
    });

    render(<MCPPolicyResolvePanel flavor={null} scopeKey="global" />);

    fireEvent.click(
      screen.getByTestId("mcp-policy-resolve-panel-toggle-global"),
    );

    fireEvent.change(screen.getByTestId("resolve-url-global"), {
      target: { value: "https://search.example.com" },
    });
    fireEvent.change(screen.getByTestId("resolve-name-global"), {
      target: { value: "search" },
    });

    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith({
        flavor: undefined,
        server_url: "https://search.example.com",
        server_name: "search",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-resolve-panel-pill-allow"),
      ).toBeTruthy();
    });
  });

  it("clears form + result when Clear is clicked", async () => {
    resolveMock.mockResolvedValue({
      decision: "block",
      decision_path: "flavor_entry",
      policy_id: "p",
      scope: "flavor:prod",
      fingerprint: "abcdef0123456789",
    });

    render(<MCPPolicyResolvePanel flavor="prod" scopeKey="prod" />);

    fireEvent.click(
      screen.getByTestId("mcp-policy-resolve-panel-toggle-prod"),
    );
    fireEvent.change(screen.getByTestId("resolve-url-prod"), {
      target: { value: "https://maps.example.com" },
    });
    fireEvent.change(screen.getByTestId("resolve-name-prod"), {
      target: { value: "maps" },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-resolve-panel-pill-block"),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByTestId("mcp-policy-resolve-panel-clear-prod"),
    );

    expect(
      (screen.getByTestId("resolve-url-prod") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByTestId("resolve-name-prod") as HTMLInputElement).value,
    ).toBe("");
  });
});
