import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    importMCPPolicyYAML: vi.fn(),
    exportMCPPolicyYAML: vi.fn(),
  };
});

import { exportMCPPolicyYAML, importMCPPolicyYAML } from "@/lib/api";
import { MCPPolicyYamlPanel } from "@/components/policy/MCPPolicyYamlPanel";

const importMock = importMCPPolicyYAML as unknown as Mock;
const exportMock = exportMCPPolicyYAML as unknown as Mock;

beforeEach(() => {
  importMock.mockReset();
  exportMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MCPPolicyYamlPanel", () => {
  it("blocks Import when the textarea is empty", () => {
    render(
      <MCPPolicyYamlPanel
        flavor="prod"
        scopeKey="prod"
        onImported={async () => undefined}
      />,
    );
    const button = screen.getByTestId(
      "mcp-policy-yaml-import-prod",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("posts the textarea body to the import helper and surfaces the version on success", async () => {
    importMock.mockResolvedValue({
      id: "p",
      scope: "flavor",
      scope_value: "prod",
      mode: null,
      block_on_uncertainty: true,
      version: 4,
      created_at: "2026-05-05T00:00:00Z",
      updated_at: "2026-05-05T00:00:00Z",
    });
    const onImported = vi.fn().mockResolvedValue(undefined);

    render(
      <MCPPolicyYamlPanel
        flavor="prod"
        scopeKey="prod"
        onImported={onImported}
      />,
    );

    fireEvent.change(screen.getByTestId("mcp-policy-yaml-textarea-prod"), {
      target: { value: "scope: flavor\nblock_on_uncertainty: true\nentries: []\n" },
    });
    fireEvent.click(screen.getByTestId("mcp-policy-yaml-import-prod"));

    await waitFor(() => {
      expect(importMock).toHaveBeenCalledWith(
        "prod",
        "scope: flavor\nblock_on_uncertainty: true\nentries: []\n",
      );
      expect(
        screen.getByTestId("mcp-policy-yaml-import-success-prod").textContent,
      ).toContain("now at v4");
      expect(onImported).toHaveBeenCalled();
    });
  });

  it("renders the API error message inline when the import fails", async () => {
    importMock.mockRejectedValue(new Error("entries[0]: server_url required"));

    render(
      <MCPPolicyYamlPanel
        flavor="prod"
        scopeKey="prod"
        onImported={async () => undefined}
      />,
    );

    fireEvent.change(screen.getByTestId("mcp-policy-yaml-textarea-prod"), {
      target: { value: "scope: flavor\n" },
    });
    fireEvent.click(screen.getByTestId("mcp-policy-yaml-import-prod"));

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-yaml-import-error-prod").textContent,
      ).toBe("entries[0]: server_url required");
    });
  });

  it("triggers a Blob download via a hidden anchor when Export YAML is clicked", async () => {
    exportMock.mockResolvedValue("scope: global\nmode: blocklist\n");
    const createUrl = vi.fn(() => "blob:mock");
    const revokeUrl = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createUrl as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeUrl as unknown as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <MCPPolicyYamlPanel
        flavor="global"
        scopeKey="global"
        onImported={async () => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId("mcp-policy-yaml-export-global"));

    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledWith("global");
      expect(createUrl).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeUrl).toHaveBeenCalledWith("blob:mock");
    });

    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    clickSpy.mockRestore();
  });
});
