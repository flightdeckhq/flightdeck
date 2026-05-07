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

import { applyMCPPolicyTemplate, listMCPPolicyTemplates } from "@/lib/api";
import { MCPPolicyTemplatesPanel } from "@/components/policy/MCPPolicyTemplatesPanel";
import { useWhoamiStore } from "@/store/whoami";

const listMock = listMCPPolicyTemplates as unknown as Mock;
const applyMock = applyMCPPolicyTemplate as unknown as Mock;

const STRICT_TEMPLATE = {
  name: "strict-baseline",
  description: "Allowlist mode with block_on_uncertainty=true and zero entries.",
  recommended_for: "Production flavor.",
  yaml_body: "scope: flavor\nblock_on_uncertainty: true\nentries: []\n",
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
  // D147: most tests assume admin role; viewer-mode test below
  // overrides per-case.
  useWhoamiStore.setState({
    role: "admin",
    tokenId: "test-token",
    loading: false,
    error: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MCPPolicyTemplatesPanel", () => {
  it("renders one card per template returned by GET /templates", async () => {
    listMock.mockResolvedValue([STRICT_TEMPLATE, WARNING_TEMPLATE]);

    render(
      <MCPPolicyTemplatesPanel
        flavor="prod"
        scopeKey="prod"
        onApplied={async () => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-template-card-strict-baseline"),
      ).toBeTruthy();
      expect(
        screen.getByTestId(
          "mcp-policy-template-card-strict-with-common-allows",
        ),
      ).toBeTruthy();
    });
  });

  it("surfaces the URL-maintenance warning on the strict-with-common-allows card", async () => {
    listMock.mockResolvedValue([WARNING_TEMPLATE]);

    render(
      <MCPPolicyTemplatesPanel
        flavor="prod"
        scopeKey="prod"
        onApplied={async () => undefined}
      />,
    );

    await waitFor(() => {
      const card = screen.getByTestId(
        "mcp-policy-template-card-strict-with-common-allows",
      );
      expect(card.textContent).toContain("maintenance");
    });
  });

  it("shows the confirmation dialog before posting apply_template", async () => {
    listMock.mockResolvedValue([STRICT_TEMPLATE]);
    applyMock.mockResolvedValue({});
    const onApplied = vi.fn().mockResolvedValue(undefined);

    render(
      <MCPPolicyTemplatesPanel
        flavor="prod"
        scopeKey="prod"
        onApplied={onApplied}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-template-card-strict-baseline"),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByTestId(
        "mcp-policy-template-card-apply-strict-baseline",
      ),
    );

    expect(
      screen.getByTestId("mcp-policy-template-confirm-title").textContent,
    ).toContain("strict-baseline");
    expect(applyMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mcp-policy-template-confirm-apply"));

    await waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith("prod", "strict-baseline");
      expect(onApplied).toHaveBeenCalled();
    });
  });

  it("shows the maintenance-warning warning block in the confirmation dialog for strict-with-common-allows", async () => {
    listMock.mockResolvedValue([WARNING_TEMPLATE]);

    render(
      <MCPPolicyTemplatesPanel
        flavor="prod"
        scopeKey="prod"
        onApplied={async () => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId(
          "mcp-policy-template-card-strict-with-common-allows",
        ),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByTestId(
        "mcp-policy-template-card-apply-strict-with-common-allows",
      ),
    );

    expect(
      screen.getByTestId("mcp-policy-template-confirm-warning").textContent,
    ).toContain("Flightdeck does not track upstream MCP server URL changes");
  });

  it("hides Apply button on each card when role is viewer (D147)", async () => {
    useWhoamiStore.setState({
      role: "viewer",
      tokenId: "viewer-token",
      loading: false,
      error: null,
    });
    listMock.mockResolvedValue([STRICT_TEMPLATE, WARNING_TEMPLATE]);

    render(
      <MCPPolicyTemplatesPanel
        flavor="prod"
        scopeKey="prod"
        onApplied={async () => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-template-card-strict-baseline"),
      ).toBeTruthy();
    });

    expect(
      screen.queryByTestId("mcp-policy-template-card-apply-strict-baseline"),
    ).toBeNull();
    expect(
      screen.queryByTestId(
        "mcp-policy-template-card-apply-strict-with-common-allows",
      ),
    ).toBeNull();
    // Cards still render — the operator can read what's available.
    expect(
      screen.getByTestId("mcp-policy-template-card-strict-baseline").textContent,
    ).toContain("strict-baseline");
  });
});
