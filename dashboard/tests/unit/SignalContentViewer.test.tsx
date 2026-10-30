import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchEventContent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  fetchEventContent,
}));

import { SignalContentViewer } from "@/components/session/SignalContentViewer";

beforeEach(() => {
  fetchEventContent.mockReset();
});

describe("SignalContentViewer", () => {
  it("renders each captured text under its heading", async () => {
    fetchEventContent.mockResolvedValue({
      event_id: "e1",
      provider: "flightdeck-signal",
      response: { compact_summary: "Line one.\nLine two." },
    });
    render(<SignalContentViewer eventId="e1" hasContent />);
    await waitFor(() => expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "text"));
    const section = screen.getByTestId("signal-content-compact_summary");
    expect(section).toHaveTextContent("Compaction summary");
    expect(section).toHaveTextContent("Line one. Line two.");
  });

  it("does not fetch when nothing was captured", () => {
    render(<SignalContentViewer eventId="e1" hasContent={false} />);
    expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "empty");
    expect(fetchEventContent).not.toHaveBeenCalled();
  });

  it("shows the empty state when the content is gone or holds no text", async () => {
    fetchEventContent.mockResolvedValue(null);
    const { unmount } = render(<SignalContentViewer eventId="e1" hasContent />);
    await waitFor(() => expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "empty"));
    unmount();
    fetchEventContent.mockResolvedValue({ event_id: "e2", provider: "flightdeck-signal", response: { x: 3 } });
    render(<SignalContentViewer eventId="e2" hasContent />);
    await waitFor(() => expect(screen.getByTestId("signal-content-viewer")).toHaveAttribute("data-state", "empty"));
  });
});
