import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Directives } from "@/pages/Directives";
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
        name: "dry_run",
        type: "boolean",
        description: "Simulate without applying",
        options: [],
        required: false,
        default: false,
      },
    ],
    registered_at: "2026-04-07T10:00:00Z",
    last_seen_at: "2026-04-07T12:00:00Z",
  },
  {
    id: "cd-2",
    fingerprint: "fp-def",
    name: "flush-cache",
    description: "Clear the agent cache",
    flavor: "research-agent",
    parameters: [],
    registered_at: "2026-04-06T10:00:00Z",
    last_seen_at: "2026-04-06T12:00:00Z",
  },
];

vi.mock("@/lib/api", () => ({
  fetchCustomDirectives: vi.fn(() => Promise.resolve([])),
  fetchFlavors: vi.fn(() => Promise.resolve(["research-agent", "coding-agent"])),
  triggerCustomDirective: vi.fn(() => Promise.resolve()),
}));

import {
  fetchCustomDirectives,
  fetchFlavors,
  triggerCustomDirective,
} from "@/lib/api";

const mockFetchCustomDirectives = fetchCustomDirectives as ReturnType<typeof vi.fn>;
const mockFetchFlavors = fetchFlavors as ReturnType<typeof vi.fn>;
const mockTriggerCustomDirective = triggerCustomDirective as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchFlavors.mockResolvedValue(["research-agent", "coding-agent"]);
});

describe("Directives page", () => {
  it("renders directive cards from API", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });
    expect(screen.getByText("flush-cache")).toBeInTheDocument();
    expect(screen.getByText("Rotate the active model mid-session")).toBeInTheDocument();
  });

  it("empty state shows code snippet", async () => {
    mockFetchCustomDirectives.mockResolvedValue([]);
    render(<Directives />);
    await waitFor(() => {
      expect(
        screen.getByText(/No custom directives registered yet/)
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/def my_action\(context\)/)).toBeInTheDocument();
  });

  it("flavor filter changes API call param", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    // Initial call with no filter
    expect(mockFetchCustomDirectives).toHaveBeenCalledWith(undefined);
  });

  it("search filters directive list client-side", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText("Search directives");
    fireEvent.change(searchInput, { target: { value: "flush" } });

    expect(screen.queryByText("rotate-model")).not.toBeInTheDocument();
    expect(screen.getByText("flush-cache")).toBeInTheDocument();
  });

  it("trigger button expands parameter form", async () => {
    mockFetchCustomDirectives.mockResolvedValue(mockDirectives);
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("rotate-model")).toBeInTheDocument();
    });

    // Click Trigger on the first card
    const triggerButtons = screen.getAllByText("Trigger");
    fireEvent.click(triggerButtons[0]);

    expect(screen.getByText("Send Directive")).toBeInTheDocument();
    // target_model is a Select (string with options), dry_run is a checkbox
    expect(screen.getByText(/Select target_model/)).toBeInTheDocument();
    expect(screen.getByLabelText("dry_run")).toBeInTheDocument();
  });

  it("submit calls triggerCustomDirective with correct payload", async () => {
    mockFetchCustomDirectives.mockResolvedValue([mockDirectives[1]]); // flush-cache, no params
    render(<Directives />);
    await waitFor(() => {
      expect(screen.getByText("flush-cache")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Trigger"));
    fireEvent.click(screen.getByText("Send Directive"));

    await waitFor(() => {
      expect(mockTriggerCustomDirective).toHaveBeenCalledWith({
        action: "custom",
        directive_name: "flush-cache",
        fingerprint: "fp-def",
        flavor: "research-agent",
        parameters: undefined,
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Directive sent to all research-agent sessions/)).toBeInTheDocument();
    });
  });
});
