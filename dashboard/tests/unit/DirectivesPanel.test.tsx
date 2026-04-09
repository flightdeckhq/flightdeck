import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DirectivesPanel } from "@/components/fleet/DirectivesPanel";
import type { CustomDirective } from "@/lib/types";

const mockDirectives: CustomDirective[] = [
  {
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
  },
];

vi.mock("@/lib/api", () => ({
  fetchCustomDirectives: vi.fn(() => Promise.resolve([])),
  triggerCustomDirective: vi.fn(() => Promise.resolve()),
}));

import { fetchCustomDirectives, triggerCustomDirective } from "@/lib/api";

const mockFetchCustomDirectives = fetchCustomDirectives as ReturnType<typeof vi.fn>;
const mockTriggerCustomDirective = triggerCustomDirective as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DirectivesPanel", () => {
  it("renders directive list from mock data", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    expect(screen.getByText("Rotate the active model mid-session")).toBeInTheDocument();
  });

  it("string parameter with options renders select", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    // The select trigger should have a placeholder or value
    expect(screen.getByText(/Select target_model/)).toBeInTheDocument();
  });

  it("string parameter without options renders text input", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    const reasonInput = screen.getByLabelText("reason");
    expect(reasonInput).toBeInTheDocument();
    expect(reasonInput).toHaveAttribute("type", "text");
  });

  it("boolean parameter renders checkbox", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    const checkbox = screen.getByLabelText("dry_run");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("type", "checkbox");
  });

  it("integer parameter renders number input with step 1", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    const input = screen.getByLabelText("priority");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("step", "1");
  });

  it("float parameter renders number input with step 0.01", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    const input = screen.getByLabelText("weight");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("step", "0.01");
  });

  it("submit calls triggerCustomDirective with correct payload", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId="sess-1" />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    // Fill in the text input for reason
    const reasonInput = screen.getByLabelText("reason");
    fireEvent.change(reasonInput, { target: { value: "cost optimization" } });

    // Click Run
    fireEvent.click(screen.getByText("Run"));

    await waitFor(() => {
      expect(mockTriggerCustomDirective).toHaveBeenCalledWith({
        action: "custom",
        directive_name: "rotate-model",
        fingerprint: "fp-abc",
        session_id: "sess-1",
        flavor: "research-agent",
        parameters: {
          target_model: "",
          reason: "cost optimization",
          dry_run: false,
          priority: 1,
          weight: 0.5,
        },
      });
    });
  });

  it("empty state shows registration hint", async () => {
    mockFetchCustomDirectives.mockResolvedValue([]);
    render(<DirectivesPanel flavorFilter={null} selectedSessionId={null} />);
    await waitFor(() => {
      expect(
        screen.getByText(/No custom directives registered for this fleet\. Decorate a function with @flightdeck_sensor\.directive\(\) and call init\(\) to register one\./)
      ).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    mockFetchCustomDirectives.mockReturnValue(new Promise(() => {})); // never resolves
    render(<DirectivesPanel flavorFilter={null} selectedSessionId={null} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("error state renders retry button", async () => {
    mockFetchCustomDirectives.mockRejectedValue(new Error("API 500: /v1/directives/custom"));
    render(<DirectivesPanel flavorFilter={null} selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("Failed to load directives.")).toBeInTheDocument();
    });
    expect(screen.getByText("Retry")).toBeInTheDocument();

    // Click retry triggers a new fetch
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    expect(mockFetchCustomDirectives).toHaveBeenCalledTimes(2);
  });

  it("shows sent confirmation after successful submit", async () => {
    mockFetchCustomDirectives.mockResolvedValue([
      {
        ...mockDirectives[0],
        parameters: [],
      },
    ]);
    render(<DirectivesPanel flavorFilter="research-agent" selectedSessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Run"));
    await waitFor(() => {
      expect(screen.getByText("Directive sent")).toBeInTheDocument();
    });
  });
});
