// Tests for the MCP Protection Policy quick-start link.
// Visibility gates: entryCount === 0 + not-yet-applied. The popover
// lazy-loads templates on first open; applying a template marks the
// scope, closes the popover, and fires the parent's onApplied
// callback.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    listMCPPolicyTemplates: vi.fn(),
    applyMCPPolicyTemplate: vi.fn(),
  };
});

import {
  applyMCPPolicyTemplate,
  listMCPPolicyTemplates,
} from "@/lib/api";
import { MCPQuickStartTemplates } from "@/components/policy/MCPQuickStartTemplates";
import { useMCPQuickStartStore } from "@/store/quickStart";

const listMock = listMCPPolicyTemplates as unknown as Mock;
const applyMock = applyMCPPolicyTemplate as unknown as Mock;

const STRICT_TEMPLATE = {
  name: "strict-baseline",
  description: "Allowlist mode with block_on_uncertainty=true and zero entries.",
  recommended_for: "Production flavor.",
  yaml_body: "scope: flavor\nblock_on_uncertainty: true\nentries: []\n",
};
const PERMISSIVE_TEMPLATE = {
  name: "permissive-dev",
  description: "Blocklist mode with zero entries; everything passes.",
  recommended_for: "Dev flavor.",
  yaml_body: "scope: flavor\nblock_on_uncertainty: false\nentries: []\n",
};
const WARNING_TEMPLATE = {
  name: "strict-with-common-allows",
  description:
    "Allowlist mode with three pre-populated allow entries. URL maintenance is on the operator.",
  recommended_for: "Production with immediate productivity.",
  yaml_body: "scope: flavor\nblock_on_uncertainty: true\nentries: []\n",
};

beforeEach(() => {
  listMock.mockReset();
  applyMock.mockReset();
  useMCPQuickStartStore.getState().reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MCPQuickStartTemplates", () => {
  it("renders the link when empty + not-yet-applied on a flavor scope", () => {
    render(
      <MCPQuickStartTemplates
        flavor="research-agent"
        scopeKey="research-agent"
        entryCount={0}
        onApplied={async () => undefined}
      />,
    );
    expect(
      screen.getByTestId("mcp-quickstart-templates-trigger-research-agent"),
    ).toBeTruthy();
  });

  it("hides the link on the global scope — apply_template returns 400 by design (D138 + D134)", () => {
    render(
      <MCPQuickStartTemplates
        flavor="global"
        scopeKey="global"
        entryCount={0}
        onApplied={async () => undefined}
      />,
    );
    expect(
      screen.queryByTestId("mcp-quickstart-templates-trigger-global"),
    ).toBeNull();
  });

  it("hides the link when entries populate", () => {
    render(
      <MCPQuickStartTemplates
        flavor="global"
        scopeKey="global"
        entryCount={1}
        onApplied={async () => undefined}
      />,
    );
    expect(
      screen.queryByTestId("mcp-quickstart-templates-trigger-global"),
    ).toBeNull();
  });

  it("hides the link after the operator marks the scope applied (per-scope flag)", () => {
    useMCPQuickStartStore.getState().markApplied("global");
    render(
      <MCPQuickStartTemplates
        flavor="global"
        scopeKey="global"
        entryCount={0}
        onApplied={async () => undefined}
      />,
    );
    expect(
      screen.queryByTestId("mcp-quickstart-templates-trigger-global"),
    ).toBeNull();
  });

  it("opens a popover that lazy-loads the templates on first click", async () => {
    listMock.mockResolvedValue([
      STRICT_TEMPLATE,
      PERMISSIVE_TEMPLATE,
      WARNING_TEMPLATE,
    ]);
    render(
      <MCPQuickStartTemplates
        flavor="research-agent"
        scopeKey="research-agent"
        entryCount={0}
        onApplied={async () => undefined}
      />,
    );
    expect(listMock).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByTestId("mcp-quickstart-templates-trigger-research-agent"),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-quickstart-templates-row-strict-baseline"),
      ).toBeTruthy();
    });
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("renders the maintenance-warning chip on strict-with-common-allows row only", async () => {
    listMock.mockResolvedValue([
      STRICT_TEMPLATE,
      PERMISSIVE_TEMPLATE,
      WARNING_TEMPLATE,
    ]);
    render(
      <MCPQuickStartTemplates
        flavor="research-agent"
        scopeKey="research-agent"
        entryCount={0}
        onApplied={async () => undefined}
      />,
    );
    fireEvent.click(
      screen.getByTestId("mcp-quickstart-templates-trigger-research-agent"),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId(
          "mcp-quickstart-templates-row-strict-with-common-allows",
        ),
      ).toBeTruthy();
    });
    expect(
      screen.getByTestId(
        "mcp-quickstart-templates-maintenance-chip-strict-with-common-allows",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(
        "mcp-quickstart-templates-maintenance-chip-strict-baseline",
      ),
    ).toBeNull();
  });

  it("apply happy path: marks scope, fires onApplied, closes popover", async () => {
    listMock.mockResolvedValue([STRICT_TEMPLATE]);
    applyMock.mockResolvedValue({ id: "p1", scope: "flavor" });
    const onApplied = vi.fn(async () => undefined);

    render(
      <MCPQuickStartTemplates
        flavor="prod"
        scopeKey="flavor:prod"
        entryCount={0}
        onApplied={onApplied}
      />,
    );

    fireEvent.click(
      screen.getByTestId("mcp-quickstart-templates-trigger-flavor:prod"),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-quickstart-templates-row-strict-baseline"),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByTestId("mcp-quickstart-templates-apply-strict-baseline"),
    );

    await waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith("prod", "strict-baseline");
    });
    expect(onApplied).toHaveBeenCalled();
    expect(
      useMCPQuickStartStore.getState().wasApplied("flavor:prod"),
    ).toBe(true);
  });

  it("apply failure surfaces inline error and does not mark the scope applied", async () => {
    listMock.mockResolvedValue([STRICT_TEMPLATE]);
    applyMock.mockRejectedValue(new Error("Apply failed"));

    render(
      <MCPQuickStartTemplates
        flavor="prod"
        scopeKey="flavor:prod"
        entryCount={0}
        onApplied={async () => undefined}
      />,
    );

    fireEvent.click(
      screen.getByTestId("mcp-quickstart-templates-trigger-flavor:prod"),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-quickstart-templates-row-strict-baseline"),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByTestId("mcp-quickstart-templates-apply-strict-baseline"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId(
          "mcp-quickstart-templates-apply-error-flavor:prod",
        ).textContent,
      ).toContain("Apply failed");
    });
    // Scope NOT marked applied on failure — the operator can retry.
    expect(
      useMCPQuickStartStore.getState().wasApplied("flavor:prod"),
    ).toBe(false);
  });
});
