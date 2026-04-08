import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { EventNode } from "@/components/timeline/EventNode";
import { TooltipProvider } from "@/components/ui/tooltip";

// Mock framer-motion
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, style, className, ...props }: Record<string, unknown>) => (
      <div style={style as React.CSSProperties} className={className as string} data-testid="event-node">
        {children as React.ReactNode}
      </div>
    ),
  },
}));

describe("EventNode", () => {
  const baseProps = {
    x: 100,
    eventType: "post_call" as const,
    sessionId: "test-sess-1",
    flavor: "test-flavor",
    occurredAt: "2026-04-08T10:00:00Z",
    onClick: vi.fn(),
  };

  it("renders with LLM color for post_call", () => {
    const { container } = render(<TooltipProvider><EventNode {...baseProps} /></TooltipProvider>);
    const node = container.querySelector("[data-testid='event-node']") as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.style.backgroundColor).toBe("var(--event-llm)");
  });

  it("renders with tool color for tool_call", () => {
    const { container } = render(
      <TooltipProvider><EventNode {...baseProps} eventType="tool_call" toolName="bash" /></TooltipProvider>
    );
    const node = container.querySelector("[data-testid='event-node']") as HTMLElement;
    expect(node.style.backgroundColor).toBe("var(--event-tool)");
  });

  it("renders with warn color for policy_warn", () => {
    const { container } = render(
      <TooltipProvider><EventNode {...baseProps} eventType="policy_warn" /></TooltipProvider>
    );
    const node = container.querySelector("[data-testid='event-node']") as HTMLElement;
    expect(node.style.backgroundColor).toBe("var(--event-warn)");
  });

  it("renders with lifecycle color for session_start", () => {
    const { container } = render(
      <TooltipProvider><EventNode {...baseProps} eventType="session_start" /></TooltipProvider>
    );
    const node = container.querySelector("[data-testid='event-node']") as HTMLElement;
    expect(node.style.backgroundColor).toBe("var(--event-lifecycle)");
  });

  it("renders with lifecycle color for session_end", () => {
    const { container } = render(
      <TooltipProvider><EventNode {...baseProps} eventType="session_end" /></TooltipProvider>
    );
    const node = container.querySelector("[data-testid='event-node']") as HTMLElement;
    expect(node.style.backgroundColor).toBe("var(--event-lifecycle)");
  });
});
