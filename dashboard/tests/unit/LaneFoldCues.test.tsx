import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { LaneFoldCues } from "@/components/agents/LaneFoldCues";

// The per-agent modal's cues for lanes out of view: "N more below" while
// lanes are below the fold, "N more above" once scrolled, each scrolling
// the next hidden lane fully into view.

// jsdom lays nothing out. The scroll viewport is 230 px tall with a
// 10 px horizontal scrollbar (220 px of client height), its 28 px time
// axis sticky at the top; lane i is 40 px tall from the axis down, moved
// up by the viewport's scrollTop.
const VIEW_PX = 230;
const CLIENT_PX = 220;
const AXIS_PX = 28;
const LANE_PX = 40;

let scrollTop = 0;

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  scrollTop = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === "scroll") return rect(0, VIEW_PX);
    if (this.dataset.timelineAxis === "true") return rect(0, AXIS_PX);
    if (this.hasAttribute("data-run-lane-row")) {
      const i = Number(this.dataset.i);
      return rect(AXIS_PX + i * LANE_PX - scrollTop, LANE_PX);
    }
    return rect(0, 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Harness({ lanes }: { lanes: number }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const attach = (node: HTMLDivElement | null) => {
    if (node && !Object.getOwnPropertyDescriptor(node, "scrollTop")) {
      Object.defineProperty(node, "clientHeight", { configurable: true, value: CLIENT_PX });
      Object.defineProperty(node, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = v;
        },
      });
      // jsdom has no scrolling: a scroll by moves the stubbed layout.
      node.scrollBy = ((options: ScrollToOptions) => {
        scrollTop += options.top ?? 0;
      }) as typeof node.scrollBy;
    }
    setEl(node);
  };
  return (
    <div style={{ position: "relative" }}>
      <div ref={attach} data-testid="scroll" tabIndex={0} aria-label="Run lanes of agent">
        <div>
          <div data-timeline-axis="true" />
          {Array.from({ length: lanes }, (_, i) => (
            <div key={i} data-run-lane-row="true" data-i={i} />
          ))}
        </div>
      </div>
      <LaneFoldCues scrollEl={el} lanesKey={lanes} />
    </div>
  );
}

/** Renders and lets the cues read the lanes, which they do in a frame. */
async function renderCues(lanes: number) {
  const view = render(<Harness lanes={lanes} />);
  await nextFrame();
  return view;
}

async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

const below = () => screen.queryByTestId("swimlane-lanes-more-below");
const above = () => screen.queryByTestId("swimlane-lanes-more-above");

describe("LaneFoldCues", () => {
  it("shows nothing while every lane is in view", async () => {
    await renderCues(4);
    expect(below()).toBeNull();
    expect(above()).toBeNull();
  });

  it("counts the lanes not fully visible below, at the lane area's bottom edge", async () => {
    // Lanes end at 68, 108, 148, 188, 228, 268 against a view ending at
    // 220: the fifth is cut, the sixth hidden.
    await renderCues(6);
    expect(below()).toHaveTextContent("2 more below");
    expect(below()).toHaveAccessibleName("2 more below");
    // Above the scrollbar, a gap clear of the edge.
    expect(below()!.style.bottom).toBe(`${VIEW_PX - CLIENT_PX + 6}px`);
    expect(above()).toBeNull();
  });

  it("scrolls the next lane fully into view on a click, then counts above too", async () => {
    await renderCues(6);
    fireEvent.click(below()!);
    // The fifth lane's bottom (228) to the view's bottom (220).
    expect(scrollTop).toBe(8);
    expect(below()).toHaveTextContent("1 more below");
    // The first lane is now partly under the axis.
    expect(above()).toHaveTextContent("1 more above");
    expect(above()!.style.top).toBe(`${AXIS_PX + 6}px`);
  });

  it("goes at the bottom, handing the focus to the lanes it scrolled", async () => {
    await renderCues(6);
    fireEvent.click(below()!);
    below()!.focus();
    fireEvent.click(below()!);
    expect(scrollTop).toBe(48);
    expect(below()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("scroll"));
    // And back up, one lane at a time.
    fireEvent.click(above()!);
    expect(above()).toHaveTextContent("1 more above");
    fireEvent.click(above()!);
    expect(scrollTop).toBe(0);
    expect(above()).toBeNull();
  });

  it("follows the viewport's own scroll", async () => {
    await renderCues(6);
    const scroll = screen.getByTestId("scroll");
    scrollTop = 48;
    scroll.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(below()).toBeNull();
    expect(above()).toHaveTextContent("2 more above");
  });

  it("recounts when the lanes change", async () => {
    const { rerender } = await renderCues(6);
    expect(below()).toHaveTextContent("2 more below");
    rerender(<Harness lanes={8} />);
    await nextFrame();
    expect(below()).toHaveTextContent("4 more below");
  });

  it("announces nothing as it scrolls: no live region", async () => {
    const { container } = await renderCues(6);
    fireEvent.click(below()!);
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="status"], [role="alert"]')).toBeNull();
  });
});
