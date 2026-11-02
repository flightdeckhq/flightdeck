import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
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

  // ---- Placement: centred on x and on the row's centre line ----

  it("shifts vertically only through the class translate; hover is a pure scale", () => {
    const { container } = renderNode();
    const node = container.querySelector("[style*='background']") as HTMLElement;
    // The class carries the one vertical shift (Tailwind 4 emits it as
    // the separate ``translate`` property).
    expect(node.className).toContain("top-1/2");
    expect(node.className).toContain("-translate-y-1/2");
    // At rest there is no inline transform at all, so nothing stacks a
    // second translate on the class's.
    expect(node.style.transform).toBe("");
    fireEvent.mouseEnter(node);
    expect(node.style.transform).toBe("scale(1.25)");
    expect(node.style.transform).not.toContain("translate");
    fireEvent.mouseLeave(node);
    expect(node.style.transform).toBe("");
  });

  it("centres the circle on x: left is x minus half the size", () => {
    const { container } = renderNode({ x: 100, size: 22 });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    expect(node.style.left).toBe("89px");
    const { container: c2 } = renderNode({ x: 0, size: 24 });
    const node2 = c2.querySelector("[style*='background']") as HTMLElement;
    expect(node2.style.left).toBe("-12px");
  });

  it("carries its event and run ids as data attributes", () => {
    const { container } = renderNode({ eventId: "evt-7", sessionId: "sess-9" });
    const node = container.querySelector("[data-event-id]") as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.dataset.eventId).toBe("evt-7");
    expect(node.dataset.sessionId).toBe("sess-9");
    expect(node.dataset.testid).toBe("session-circle-sess-9");
  });

  it("click passes eventId to onClick handler", () => {
    const onClick = vi.fn();
    const { container } = renderNode({ onClick, eventId: "evt-42" });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    fireEvent.click(node);
    expect(onClick).toHaveBeenCalledWith("evt-42");
  });

  // ---- Failed directive icon and tooltip (CHANGE 2) ----

  it("directive_result error renders X icon (not XCircle, not Check)", () => {
    const { container } = renderNode({
      eventType: "directive_result",
      directiveStatus: "error",
    });
    // lucide-react renders icons as <svg class="lucide lucide-NAME ...">
    expect(container.querySelector("svg.lucide-x")).not.toBeNull();
    expect(container.querySelector("svg.lucide-check")).toBeNull();
    expect(container.querySelector("svg.lucide-circle-x")).toBeNull();
  });

  it("directive_result timeout renders X icon", () => {
    const { container } = renderNode({
      eventType: "directive_result",
      directiveStatus: "timeout",
    });
    expect(container.querySelector("svg.lucide-x")).not.toBeNull();
    expect(container.querySelector("svg.lucide-check")).toBeNull();
  });

  it("directive_result success keeps the Check icon", () => {
    const { container } = renderNode({
      eventType: "directive_result",
      directiveStatus: "success",
    });
    expect(container.querySelector("svg.lucide-check")).not.toBeNull();
    expect(container.querySelector("svg.lucide-x")).toBeNull();
  });

  it("directive_result tooltip shows 'RESULT · timeout' on hover", () => {
    const { container, getByText } = renderNode({
      eventType: "directive_result",
      directiveStatus: "timeout",
    });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    fireEvent.mouseEnter(node);
    expect(getByText("RESULT · timeout")).toBeInTheDocument();
  });

  it("directive_result tooltip shows 'RESULT · error' on hover", () => {
    const { container, getByText } = renderNode({
      eventType: "directive_result",
      directiveStatus: "error",
    });
    const node = container.querySelector("[style*='background']") as HTMLElement;
    fireEvent.mouseEnter(node);
    expect(getByText("RESULT · error")).toBeInTheDocument();
  });
});
