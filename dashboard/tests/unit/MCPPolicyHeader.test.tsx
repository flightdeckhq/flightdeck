import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { MCPPolicyHeader } from "@/components/policy/MCPPolicyHeader";
import type { MCPPolicy } from "@/lib/types";

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
        policy={policy({ block_on_uncertainty: false })}
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

  it("notes the BOU toggle is a no-op under blocklist mode", () => {
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

    const header = screen.getByTestId("mcp-policy-header-global");
    expect(header.textContent).toContain("(no-op under blocklist mode)");
  });
});
