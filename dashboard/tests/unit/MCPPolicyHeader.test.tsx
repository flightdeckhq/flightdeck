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

  it("marks the active mode option with data-active='true' (D146 visual-fix lock)", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist" })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={async () => undefined}
        onBlockOnUncertaintyChange={async () => undefined}
      />,
    );
    const allow = screen.getByTestId(
      "mcp-policy-mode-segmented-global-allowlist",
    );
    const block = screen.getByTestId(
      "mcp-policy-mode-segmented-global-blocklist",
    );
    expect(allow.getAttribute("data-active")).toBe("true");
    expect(block.getAttribute("data-active")).toBe("false");
  });

  it("ArrowRight on the active mode button moves focus to the next option (D146 keyboard nav)", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist" })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={async () => undefined}
        onBlockOnUncertaintyChange={async () => undefined}
      />,
    );
    const allow = screen.getByTestId(
      "mcp-policy-mode-segmented-global-allowlist",
    );
    allow.focus();
    expect(document.activeElement).toBe(allow);

    fireEvent.keyDown(allow, { key: "ArrowRight" });
    const block = screen.getByTestId(
      "mcp-policy-mode-segmented-global-blocklist",
    );
    expect(document.activeElement).toBe(block);
    // Arrow nav moves FOCUS only — not commit. data-active stays
    // on the original until the user presses Space/Enter.
    expect(allow.getAttribute("data-active")).toBe("true");
    expect(block.getAttribute("data-active")).toBe("false");
  });

  it("renders the shared InfoIcon next to the Policy mode heading on the editable Global tab (step 6.9)", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist" })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={async () => undefined}
        onBlockOnUncertaintyChange={async () => undefined}
      />,
    );
    const trigger = screen.getByTestId(
      "mcp-policy-mode-tooltip-trigger-global",
    );
    // The shared primitive renders a real <button> (not a styled
    // span). The aria-label drives both the screen-reader name and
    // the derived test-id semantics.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-label")).toBe("Policy mode help");
  });

  it("renders the shared InfoIcon next to the BOU heading under allowlist mode with the corrected polarity copy (step 6.9)", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "allowlist", block_on_uncertainty: false })}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={async () => undefined}
        onBlockOnUncertaintyChange={async () => undefined}
      />,
    );
    const trigger = screen.getByTestId(
      "mcp-policy-bou-tooltip-trigger-global",
    );
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-label")).toBe(
      "Block on uncertainty help",
    );
  });

  it("BOU section (with its InfoIcon) stays hidden under blocklist mode — D135 invariant the spec text contradicted (step 6.9)", () => {
    render(
      <MCPPolicyHeader
        policy={policy({ mode: "blocklist" })}
        scopeKey="global"
        modeEditable
        globalMode="blocklist"
        onModeChange={async () => undefined}
        onBlockOnUncertaintyChange={async () => undefined}
      />,
    );
    expect(screen.queryByTestId("mcp-policy-bou-section-global")).toBeNull();
    expect(
      screen.queryByTestId("mcp-policy-bou-tooltip-trigger-global"),
    ).toBeNull();
  });
});
