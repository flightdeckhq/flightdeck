import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PolicyEditor } from "@/components/policy/PolicyEditor";
import type { Policy } from "@/lib/types";
import { ApiError } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchDegradeTargets: vi.fn().mockResolvedValue([
    { model_id: "claude-haiku-4-5", provider: "anthropic" },
  ]),
}));

const mockPolicy: Policy = {
  id: "p1",
  scope: "flavor",
  scope_value: "research-agent",
  token_limit: 100000,
  warn_at_pct: 70,
  degrade_at_pct: 85,
  degrade_to: "claude-haiku-4-5-20251001",
  block_at_pct: 95,
  created_at: "2026-04-07T10:00:00Z",
  updated_at: "2026-04-07T10:00:00Z",
};

describe("PolicyEditor", () => {
  it("renders in create mode with empty fields", () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Create")).toBeInTheDocument();
    const tokenLimitInput = screen.getByPlaceholderText("Optional");
    expect(tokenLimitInput).toHaveValue(null);
  });

  it("renders in edit mode with pre-populated fields", () => {
    render(
      <PolicyEditor policy={mockPolicy} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText("Update")).toBeInTheDocument();
    expect(screen.getByDisplayValue("research-agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("70")).toBeInTheDocument();
    expect(screen.getByDisplayValue("85")).toBeInTheDocument();
    expect(screen.getByDisplayValue("95")).toBeInTheDocument();
  });

  it("warn >= degrade shows validation error", async () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);

    const pctInputs = screen.getAllByPlaceholderText("1-99");
    fireEvent.change(pctInputs[0], { target: { value: "90" } });
    fireEvent.change(pctInputs[1], { target: { value: "80" } });

    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(screen.getByText("Warn % must be less than degrade %")).toBeInTheDocument();
    });
  });

  it("degrade > block shows validation error", async () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);

    const pctInputs = screen.getAllByPlaceholderText("1-99");
    const blockInput = screen.getByPlaceholderText("1-100");

    fireEvent.change(pctInputs[1], { target: { value: "95" } });
    fireEvent.change(blockInput, { target: { value: "90" } });

    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(screen.getByText(/Degrade % must be/)).toBeInTheDocument();
    });
  });

  it("valid form calls onSave with correct data", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PolicyEditor onSave={onSave} onCancel={vi.fn()} />);

    const tokenLimitInput = screen.getByPlaceholderText("Optional");
    fireEvent.change(tokenLimitInput, { target: { value: "50000" } });

    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "org",
          scope_value: "",
          token_limit: 50000,
        })
      );
    });
  });

  it("scope_value required when scope is flavor", async () => {
    // Render in edit mode with flavor scope but blank scope_value
    // to avoid Radix Select jsdom scrollIntoView issues
    const flavorPolicy: Policy = {
      ...mockPolicy,
      scope_value: "",
    };
    render(
      <PolicyEditor policy={flavorPolicy} onSave={vi.fn()} onCancel={vi.fn()} />
    );

    // scope_value input is visible (flavor scope) but empty
    fireEvent.click(screen.getByText("Update"));

    await waitFor(() => {
      expect(
        screen.getByText("Scope value is required for this scope")
      ).toBeInTheDocument();
    });
  });

  it("rejects out of range warn_at_pct", async () => {
    render(<PolicyEditor onSave={vi.fn()} onCancel={vi.fn()} />);

    const pctInputs = screen.getAllByPlaceholderText("1-99");
    const blockInput = screen.getByPlaceholderText("1-100");

    // Set warn_at_pct to 99 (near upper bound) and block_at_pct to 50
    // so warn >= block, triggering "Warn % must be less than block %"
    fireEvent.change(pctInputs[0], { target: { value: "99" } });
    fireEvent.change(blockInput, { target: { value: "50" } });

    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(
        screen.getByText("Warn % must be less than block %")
      ).toBeInTheDocument();
    });
  });

  it("flags a stored degrade_to that is no longer priced, and keeps it", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PolicyEditor
        policy={{ ...mockPolicy, degrade_to: "claude-3-opus-retired" }}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );
    expect(await screen.findByTestId("degrade-to-unlisted")).toHaveTextContent("Saving keeps it");

    fireEvent.click(screen.getByText("Update"));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ degrade_to: "claude-3-opus-retired" })
      )
    );
  });

  it("warns when a newly entered degrade_to is not priced", async () => {
    render(<PolicyEditor policy={mockPolicy} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText("Or enter model name directly →"));
    fireEvent.change(screen.getByPlaceholderText("e.g. claude-haiku-4-5"), {
      target: { value: "gpt-typo" },
    });
    expect(await screen.findByTestId("degrade-to-unlisted")).toHaveTextContent(
      "the API will reject it"
    );
  });

  it("shows the API's reason when a save is rejected", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, "POST /v1/policies", "degrade_to must be a current, priced model")
      );
    render(<PolicyEditor onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText("Create"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "degrade_to must be a current, priced model"
    );
  });

  it("falls back to a generic message when a save fails otherwise", async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError(500, "POST /v1/policies"));
    render(<PolicyEditor onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText("Create"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to create policy");
  });
});
