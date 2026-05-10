import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MCPPolicyEntryDialog } from "@/components/policy/MCPPolicyEntryDialog";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    resolveMCPPolicy: vi.fn(),
  };
});

import { resolveMCPPolicy } from "@/lib/api";

const resolveMock = resolveMCPPolicy as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resolveMock.mockReset();
  resolveMock.mockResolvedValue({
    decision: "block",
    decision_path: "global_entry",
    policy_id: "11112222-3333-4444-5555-666677778888",
    scope: "global",
    fingerprint: "abcdef0123456789aabbccddeeff0011",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MCPPolicyEntryDialog", () => {
  it("renders an idle live-preview placeholder before URL or name is filled", () => {
    render(
      <MCPPolicyEntryDialog
        open
        flavor={null}
        onClose={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(
      screen.getByTestId("mcp-policy-entry-resolve-empty"),
    ).toBeTruthy();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("fires a debounced GET /resolve once URL and name are stable, and renders the decision pill", async () => {
    render(
      <MCPPolicyEntryDialog
        open
        flavor="prod"
        onClose={() => undefined}
        onSave={async () => undefined}
      />,
    );

    fireEvent.change(screen.getByTestId("mcp-policy-entry-url"), {
      target: { value: "https://maps.example.com" },
    });
    fireEvent.change(screen.getByTestId("mcp-policy-entry-name"), {
      target: { value: "maps" },
    });

    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith({
        flavor: "prod",
        server_url: "https://maps.example.com",
        server_name: "maps",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mcp-policy-entry-resolve-pill-block"),
      ).toBeTruthy();
    });
  });

  it("defers validation errors until first submit, then forwards the mutation when fields are filled (B4)", async () => {
    // B4: don't show validation errors before the operator has tried
    // to submit — the dialog opens with empty fields, and showing the
    // red "URL is required / Name is required" list immediately reads
    // as "the form is broken". The submit button stays enabled until
    // the first attempt; clicking it on empty fields surfaces the
    // validation list AND disables submit until the user fixes the
    // problem.
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <MCPPolicyEntryDialog
        open
        flavor={null}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );

    const submit = screen.getByTestId("mcp-policy-entry-submit");
    // Pre-attempt: not disabled, no validation list shown.
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("mcp-policy-entry-validation")).toBeNull();

    // First submit attempt on empty form → validation list appears,
    // submit becomes disabled, onSave is NOT called. Submit the form
    // directly because the inputs have HTML5 `required`, which jsdom
    // would otherwise short-circuit on a button click.
    const form = submit.closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-policy-entry-validation")).toBeTruthy();
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("mcp-policy-entry-url"), {
      target: { value: "https://api.example.com" },
    });
    fireEvent.change(screen.getByTestId("mcp-policy-entry-name"), {
      target: { value: "api" },
    });

    // After both fields are filled, validation passes → submit re-enables.
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        server_url: "https://api.example.com",
        server_name: "api",
        entry_kind: "allow",
        enforcement: null,
      });
    });
  });

  it("renders the spec placeholders and help text on the URL + Name fields (step 6.9)", () => {
    render(
      <MCPPolicyEntryDialog
        open
        flavor={null}
        onClose={() => undefined}
        onSave={async () => undefined}
      />,
    );

    const urlInput = screen.getByTestId(
      "mcp-policy-entry-url",
    ) as HTMLInputElement;
    expect(urlInput.placeholder).toBe(
      "https://mcp.example.com/sse OR stdio:///path/to/server-binary",
    );

    const nameInput = screen.getByTestId(
      "mcp-policy-entry-name",
    ) as HTMLInputElement;
    expect(nameInput.placeholder).toBe("filesystem");

    // Help text is the prose immediately under each input. Match
    // load-bearing phrases — full strings are too brittle across
    // copy-tightening passes.
    expect(
      screen.getByText(
        /URL the agent uses to reach the MCP server/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Human-readable identifier declared by the MCP server/i),
    ).toBeInTheDocument();
  });

  it("renders an InfoIcon on every field (URL / Name / Decision / Enforcement) per step 6.9 standardization", () => {
    render(
      <MCPPolicyEntryDialog
        open
        flavor={null}
        onClose={() => undefined}
        onSave={async () => undefined}
      />,
    );

    const triggerIds = [
      "mcp-policy-entry-url-tooltip-trigger",
      "mcp-policy-entry-name-tooltip-trigger",
      "mcp-policy-entry-kind-tooltip-trigger",
      "mcp-policy-entry-enforcement-tooltip-trigger",
    ];
    for (const id of triggerIds) {
      const trigger = screen.getByTestId(id);
      // The shared InfoIcon primitive renders a <button> trigger
      // (not a styled span) so keyboard users can land on it.
      expect(trigger.tagName).toBe("BUTTON");
      expect(trigger.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("seeds form fields from ``initial`` when editing an existing entry", () => {
    render(
      <MCPPolicyEntryDialog
        open
        flavor={null}
        initial={{
          id: "edit-1",
          policy_id: "policy",
          server_url: "stdio://existing",
          server_name: "existing-svc",
          fingerprint: "ff".repeat(8),
          entry_kind: "deny",
          enforcement: "warn",
          created_at: "2026-05-05T00:00:00Z",
        }}
        onClose={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(
      (screen.getByTestId("mcp-policy-entry-url") as HTMLInputElement).value,
    ).toBe("stdio://existing");
    expect(
      (screen.getByTestId("mcp-policy-entry-name") as HTMLInputElement).value,
    ).toBe("existing-svc");
  });
});
