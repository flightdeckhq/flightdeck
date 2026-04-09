import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { EventNode } from "@/components/timeline/EventNode";

describe("EventNode", () => {
  const baseProps = {
    x: 100,
    eventType: "post_call" as const,
    sessionId: "test-sess-1",
    flavor: "test-flavor",
    occurredAt: "2026-04-08T10:00:00Z",
    onClick: vi.fn(),
  };

  function renderNode(props = {}) {
    return render(<EventNode {...baseProps} {...props} />);
  }

  it("renders with LLM color for post_call", () => {
    const { container } = renderNode();
    const node = container.querySelector("[style*='background']") as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.style.backgroundColor).toBe("var(--event-llm)");
  });

  it("renders with tool color for tool_call", () => {
    const { container } = renderNode({ eventType: "tool_call", toolName: "bash" });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    expect(node.style.backgroundColor).toBe("var(--event-tool)");
  });

  it("renders with warn color for policy_warn", () => {
    const { container } = renderNode({ eventType: "policy_warn" });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    expect(node.style.backgroundColor).toBe("var(--event-warn)");
  });

  it("renders with lifecycle color for session_start", () => {
    const { container } = renderNode({ eventType: "session_start" });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    expect(node.style.backgroundColor).toBe("var(--event-lifecycle)");
  });

  it("renders 24px circle by default", () => {
    const { container } = renderNode();
    const node = container.querySelector("[style*='background']") as HTMLElement;
    expect(node.style.width).toBe("24px");
    expect(node.style.height).toBe("24px");
  });

  it("renders 20px circle when size=20", () => {
    const { container } = renderNode({ size: 20 });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    expect(node.style.width).toBe("20px");
    expect(node.style.height).toBe("20px");
  });
});
