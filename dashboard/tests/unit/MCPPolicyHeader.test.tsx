import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { MCPPolicyHeader } from "@/components/policy/MCPPolicyHeader";
import type { MCPPolicy } from "@/lib/types";
import { useWhoamiStore } from "@/store/whoami";

beforeEach(() => {
  // D147: tests that exercise mutations assume admin role; viewer
  // tests below override per-case.
  useWhoamiStore.setState({
    role: "admin",
    tokenId: "test-token",
    loading: false,
    error: null,
  });
});

function policy(override: Partial<MCPPolicy> = {}): MCPPolicy {
  return {
    id: "policy-1",
    scope: "global",
    scope_value: null,
    mode: "blocklist",
    block_on_uncertainty: false,
    version: 1,
    created_at: "2026-05-05T00:00:00Z",
    updated_at: "2026-05-05T00:00:00Z",
    entries: [],
    ...override,
  };
}

describe("MCPPolicyHeader", () => {
  const noopAsync = async () => undefined;

  it("renders the segmented mode control on the editable Global tab", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist" })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={noopAsync}
        onBlockOnUncertaintyChange={noopAsync}
      />,
    );

    const segmented = screen.getByTestId(
      "mcp-policy-mode-segmented-global",
    );
    expect(segmented).toBeTruthy();
    expect(segmented.textContent).toContain("Allow-list");
    expect(segmented.textContent).toContain("Block-list");
  });

  it("renders inheritance copy and hides the segmented control on a flavor tab", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ scope: "flavor", mode: null })}
        scopeKey="prod"
        modeEditable={false}
        globalMode="blocklist"
        onModeChange={noopAsync}
        onBlockOnUncertaintyChange={noopAsync}
      />,
    );

    expect(screen.queryByTestId("mcp-policy-mode-segmented-prod")).toBeNull();
    const readonly = screen.getByTestId("mcp-policy-mode-readonly-prod");
    expect(readonly.textContent).toContain("Inherits global mode:");
    expect(readonly.textContent).toContain("blocklist");
  });

  it("calls onModeChange with the clicked option's value", async () => {
    const handler = vi.fn(() => Promise.resolve());
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "blocklist" })}
        scopeKey="global"
        modeEditable
        globalMode="blocklist"
        onModeChange={handler}
        onBlockOnUncertaintyChange={noopAsync}
      />,
    );

    fireEvent.click(
      screen.getByTestId("mcp-policy-mode-segmented-global-allowlist"),
    );

    expect(handler).toHaveBeenCalledWith("allowlist");
  });

  it("calls onBlockOnUncertaintyChange when the switch is toggled", async () => {
    const handler = vi.fn(() => Promise.resolve());
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist", block_on_uncertainty: false })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={noopAsync}
        onBlockOnUncertaintyChange={handler}
      />,
    );

    fireEvent.click(screen.getByTestId("mcp-policy-bou-switch-global"));
    expect(handler).toHaveBeenCalledWith(true);
  });

  it("hides the BOU toggle entirely under blocklist mode (B2)", () => {
    // Step 6.6 B2: BOU is only meaningful under allowlist (D134).
    // Hide-rather-than-grey matches Salesforce / Atlassian / Linear
    // precedent of removing irrelevant controls. Server-side value
    // persists across mode flips so flipping back to allowlist
    // restores the prior BOU state automatically.
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "blocklist", block_on_uncertainty: false })}
        scopeKey="global"
        modeEditable
        globalMode="blocklist"
        onModeChange={noopAsync}
        onBlockOnUncertaintyChange={noopAsync}
      />,
    );

    expect(screen.queryByTestId("mcp-policy-bou-section-global")).toBeNull();
    expect(screen.queryByTestId("mcp-policy-bou-switch-global")).toBeNull();
  });

  it("shows the BOU toggle under allowlist mode (B2)", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist", block_on_uncertainty: true })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={noopAsync}
        onBlockOnUncertaintyChange={noopAsync}
      />,
    );

    expect(screen.getByTestId("mcp-policy-bou-section-global")).toBeTruthy();
    expect(screen.getByTestId("mcp-policy-bou-switch-global")).toBeTruthy();
  });

  it("renders the Allow-list / Block-list descriptive copy under the segmented control (B2)", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "blocklist" })}
        scopeKey="global"
        modeEditable
        globalMode="blocklist"
        onModeChange={noopAsync}
        onBlockOnUncertaintyChange={noopAsync}
      />,
    );

    const help = screen.getByTestId("mcp-policy-mode-help-global");
    expect(help.textContent).toContain(
      "every server blocked by default; explicit allow entries open access.",
    );
    expect(help.textContent).toContain(
      "every server allowed by default; explicit deny entries block access.",
    );
  });

  it("disables mode segmented + BOU switch with admin-token tooltip when role is viewer (D147)", () => {
    useWhoamiStore.setState({
      role: "viewer",
      tokenId: "viewer-token",
      loading: false,
      error: null,
    });
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist", block_on_uncertainty: true })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={async () => undefined}
        onBlockOnUncertaintyChange={async () => undefined}
      />,
    );

    const modeWrapper = screen.getByTestId(
      "mcp-policy-mode-segmented-disabled-global",
    );
    expect(modeWrapper).toBeTruthy();
    const bouWrapper = screen.getByTestId(
      "mcp-policy-bou-switch-disabled-global",
    );
    expect(bouWrapper).toBeTruthy();
  });

  it("disables mode segmented + BOU switch with Loading… tooltip while whoami is in flight (D147)", () => {
    useWhoamiStore.setState({
      role: null,
      tokenId: null,
      loading: true,
      error: null,
    });
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist", block_on_uncertainty: true })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={async () => undefined}
        onBlockOnUncertaintyChange={async () => undefined}
      />,
    );

    expect(
      screen.getByTestId("mcp-policy-mode-segmented-disabled-global"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("mcp-policy-bou-switch-disabled-global"),
    ).toBeTruthy();
  });
});
