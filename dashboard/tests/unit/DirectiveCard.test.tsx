import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DirectiveCard } from "@/components/directives/DirectiveCard";
import type { CustomDirective } from "@/lib/types";

// Mock the API module so tests assert on the outgoing trigger payload
// without going through the real fetch / NATS / worker path.
vi.mock("@/lib/api", () => ({
  triggerCustomDirective: vi.fn(() => Promise.resolve()),
}));

import { triggerCustomDirective } from "@/lib/api";
const mockTrigger = triggerCustomDirective as ReturnType<typeof vi.fn>;

const rotateModel: CustomDirective = {
  id: "cd-1",
  fingerprint: "fp-abc",
  name: "rotate-model",
  description: "Rotate the active model mid-session",
  flavor: "research-agent",
  parameters: [
    {
      name: "target_model",
      type: "string",
      description: "Model to switch to",
      options: ["gpt-4o", "claude-sonnet-4-20250514"],
      required: true,
      default: null,
    },
    {
      name: "reason",
      type: "string",
      description: "Reason for rotation",
      options: [],
      required: false,
      default: "",
    },
    {
      name: "dry_run",
      type: "boolean",
      description: "Simulate without applying",
      options: [],
      required: false,
      default: false,
    },
    {
      name: "priority",
      type: "integer",
      description: "Priority level",
      options: [],
      required: false,
      default: 1,
    },
    {
      name: "weight",
      type: "float",
      description: "Sampling weight",
      options: [],
      required: false,
      default: 0.5,
    },
  ],
  registered_at: "2026-04-07T10:00:00Z",
  last_seen_at: "2026-04-07T12:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DirectiveCard", () => {
  it("renders directive name, description, and every parameter", () => {
    render(<DirectiveCard directive={rotateModel} sessionId="sess-1" />);
    expect(screen.getByText("rotate-model")).toBeInTheDocument();
    expect(screen.getByText(/Rotate the active model/)).toBeInTheDocument();
    // Each parameter renders its label text next to its input. The
    // Radix Select on `target_model` renders as a combobox so we
    // assert on the label text instead of the wiring.
    expect(screen.getByText("target_model")).toBeInTheDocument();
    expect(screen.getByText("reason")).toBeInTheDocument();
    expect(screen.getByText("dry_run")).toBeInTheDocument();
    expect(screen.getByText("priority")).toBeInTheDocument();
    expect(screen.getByText("weight")).toBeInTheDocument();
  });

  it("integer parameter renders a number input", () => {
    render(<DirectiveCard directive={rotateModel} sessionId="sess-1" />);
    const input = screen.getByLabelText("priority") as HTMLInputElement;
    expect(input.type).toBe("number");
  });

  it("float parameter renders a number input with decimal step", () => {
    render(<DirectiveCard directive={rotateModel} sessionId="sess-1" />);
    const input = screen.getByLabelText("weight") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.step).toBe("0.01");
  });

  it("boolean parameter renders a checkbox", () => {
    render(<DirectiveCard directive={rotateModel} sessionId="sess-1" />);
    const checkbox = screen.getByLabelText("dry_run") as HTMLInputElement;
    expect(checkbox.type).toBe("checkbox");
  });

  it("Run button triggers the directive with session_id when provided", async () => {
    render(<DirectiveCard directive={rotateModel} sessionId="sess-1" />);
    fireEvent.click(screen.getByTestId("directive-run-rotate-model"));
    await waitFor(() => {
      expect(mockTrigger).toHaveBeenCalledTimes(1);
    });
    const call = mockTrigger.mock.calls[0][0];
    expect(call.directive_name).toBe("rotate-model");
    expect(call.fingerprint).toBe("fp-abc");
    expect(call.session_id).toBe("sess-1");
    // flavor must NOT be set when session_id is — they're mutually
    // exclusive per the ingestion API contract.
    expect(call.flavor).toBeUndefined();
  });

  it("Run button triggers the directive with flavor when no sessionId", async () => {
    render(<DirectiveCard directive={rotateModel} flavor="research-agent" />);
    fireEvent.click(screen.getByTestId("directive-run-rotate-model"));
    await waitFor(() => {
      expect(mockTrigger).toHaveBeenCalledTimes(1);
    });
    const call = mockTrigger.mock.calls[0][0];
    expect(call.session_id).toBeUndefined();
    expect(call.flavor).toBe("research-agent");
  });

  it("Run button label switches based on sessionId vs flavor", () => {
    const { rerender } = render(
      <DirectiveCard directive={rotateModel} sessionId="sess-1" />,
    );
    expect(
      screen.getByTestId("directive-run-rotate-model").textContent,
    ).toContain("this session");

    rerender(
      <DirectiveCard directive={rotateModel} flavor="research-agent" />,
    );
    expect(
      screen.getByTestId("directive-run-rotate-model").textContent,
    ).toContain("all active");
  });

  it("shows inline error when the trigger API fails", async () => {
    mockTrigger.mockRejectedValueOnce(new Error("boom"));
    render(<DirectiveCard directive={rotateModel} sessionId="sess-1" />);
    fireEvent.click(screen.getByTestId("directive-run-rotate-model"));
    await waitFor(() => {
      expect(screen.getByText("boom")).toBeInTheDocument();
    });
  });
});
