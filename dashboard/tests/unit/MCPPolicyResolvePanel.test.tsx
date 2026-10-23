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
  function fill(scope: string, url: string, name: string) {
    fireEvent.change(screen.getByTestId(`resolve-url-${scope}`), {
      target: { value: url },
    });
    fireEvent.change(screen.getByTestId(`resolve-name-${scope}`), {
      target: { value: name },
    });
  }

  it("shows the preview again when the cleared inputs are typed again", async () => {
    resolveMock.mockResolvedValue({
      decision: "block",
      decision_path: "flavor_entry",
      policy_id: "p",
      scope: "flavor:prod",
      fingerprint: "abcdef0123456789",
    });
    render(<MCPPolicyResolvePanel flavor="prod" scopeKey="prod" />);
    fireEvent.click(screen.getByTestId("mcp-policy-resolve-panel-toggle-prod"));
    fill("prod", "https://maps.example.com", "maps");
    await waitFor(() => {
      expect(screen.getByTestId("mcp-policy-resolve-panel-pill-block")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("mcp-policy-resolve-panel-clear-prod"));
    expect(screen.queryByTestId("mcp-policy-resolve-panel-pill-block")).toBeNull();

    // Typed again before the cleared inputs' debounce settled, the
    // same inputs are a new request, not a cleared one.
    fill("prod", "https://maps.example.com", "maps");
    await waitFor(() => {
      expect(screen.getByTestId("mcp-policy-resolve-panel-pill-block")).toBeTruthy();
    });
  });

  it("does not bring back an earlier preview after a failure", async () => {
    // Answer per server name, so the intermediate keys produced while
    // the two debounced fields catch up cannot consume a scripted reply.
    let releaseC: (v: unknown) => void = () => undefined;
    resolveMock.mockImplementation(({ server_name }: { server_name: string }) => {
      if (server_name === "a") {
        return Promise.resolve({
          decision: "allow",
          decision_path: "global_entry",
          policy_id: "p",
          scope: "global",
          fingerprint: "abcdef0123456789",
        });
      }
      if (server_name === "c") return new Promise((resolve) => (releaseC = resolve));
      return Promise.reject(new Error("resolve exploded"));
    });
    render(<MCPPolicyResolvePanel flavor={null} scopeKey="global" />);
    fireEvent.click(screen.getByTestId("mcp-policy-resolve-panel-toggle-global"));

    fill("global", "https://a.example.com", "a");
    await waitFor(() => {
      expect(screen.getByTestId("mcp-policy-resolve-panel-pill-allow")).toBeTruthy();
    });
    fill("global", "https://b.example.com", "b");
    await waitFor(() => {
      expect(screen.getByTestId("mcp-policy-resolve-panel-error-global")).toBeTruthy();
    });
    expect(screen.queryByTestId("mcp-policy-resolve-panel-pill-allow")).toBeNull();

    // While C's request is in flight, A's decision stays hidden.
    fill("global", "https://c.example.com", "c");
    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith({
        flavor: undefined,
        server_url: "https://c.example.com",
        server_name: "c",
      });
    });
    expect(screen.queryByTestId("mcp-policy-resolve-panel-pill-allow")).toBeNull();
    expect(screen.queryByTestId("mcp-policy-resolve-panel-error-global")).toBeNull();

    releaseC({
      decision: "block",
      decision_path: "global_entry",
      policy_id: "p",
      scope: "global",
      fingerprint: "abcdef0123456789",
    });
    await waitFor(() => {
      expect(screen.getByTestId("mcp-policy-resolve-panel-pill-block")).toBeTruthy();
    });
  });
});
