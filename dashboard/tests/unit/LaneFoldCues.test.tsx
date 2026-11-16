import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { LaneFoldCues } from "@/components/agents/LaneFoldCues";
import { LANE_FOLD_FOOTER_HEIGHT_PX } from "@/lib/run-lane-layout";

// The per-agent modal's cues for lanes out of view: "N more above" in
// the time axis row's label-column cell once scrolled, "N more below" on
// a footer strip under the scroll viewport while the lanes overflow, at
// the label column's right edge, each scrolling the next hidden lane
// fully into view. Nothing scrolls under either.

// jsdom lays nothing out. The scroll viewport is 230 px tall with a
// 10 px horizontal scrollbar (220 px of client height), its 28 px time
// axis sticky at the top, the axis row's label cell the 460 px label
// column; lane i is 40 px tall from the axis down, moved up by the
// viewport's scrollTop. The content is the axis and the lanes. (jsdom
// does not shrink the viewport when the strip shows under it; the cues
// give the strip's height back when they read the overflow either way.)
const VIEW_PX = 230;
const CLIENT_PX = 220;
const AXIS_PX = 28;
const LABEL_COLUMN_PX = 460;
const LANE_PX = 40;

let scrollTop = 0;
/** One test lets the viewport lose the strip's height while the strip
 *  shows, as the browser's layout does, and sets the content's height. */
let stripShrinksView = false;
let contentPx: number | null = null;

function rect(top: number, height: number, left = 0, width = 0): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  scrollTop = 0;
  stripShrinksView = false;
  contentPx = null;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === "scroll") return rect(0, VIEW_PX, 0, 1000);
    if (this.dataset.testid === "content") {
      const lanes = this.querySelectorAll("[data-run-lane-row]").length;
      return rect(-scrollTop, contentPx ?? AXIS_PX + lanes * LANE_PX, 0, 1360);
    }
    if (this.dataset.timelineAxis === "true") return rect(0, AXIS_PX, 0, 1360);
    if (this.dataset.timelineAxisLabel === "true") return rect(0, AXIS_PX, 0, LABEL_COLUMN_PX);
    if (this.hasAttribute("data-run-lane-row")) {
      const i = Number(this.dataset.i);
      return rect(AXIS_PX + i * LANE_PX - scrollTop, LANE_PX, 0, 1360);
    }
    return rect(0, 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Harness({ lanes, onOverflowChange }: { lanes: number; onOverflowChange?: (o: boolean) => void }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const attach = (node: HTMLDivElement | null) => {
    if (node && !Object.getOwnPropertyDescriptor(node, "scrollTop")) {
      Object.defineProperty(node, "clientHeight", {
        configurable: true,
        get: () =>
          stripShrinksView && document.querySelector('[data-testid="swimlane-lanes-fold-footer"]')
            ? CLIENT_PX - LANE_FOLD_FOOTER_HEIGHT_PX
            : CLIENT_PX,
      });
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
        <div data-testid="content">
          <div data-timeline-axis="true">
            <div data-timeline-axis-label="true" />
          </div>
          {Array.from({ length: lanes }, (_, i) => (
            <div key={i} data-run-lane-row="true" data-i={i} />
          ))}
        </div>
      </div>
      <LaneFoldCues scrollEl={el} lanesKey={lanes} onOverflowChange={onOverflowChange} />
    </div>
  );
}

/** Renders and lets the cues read the lanes, which they do in a frame. */
async function renderCues(lanes: number, onOverflowChange?: (o: boolean) => void) {
  const view = render(<Harness lanes={lanes} onOverflowChange={onOverflowChange} />);
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
const footer = () => screen.queryByTestId("swimlane-lanes-fold-footer");
const aboveCell = () => screen.queryByTestId("swimlane-lanes-above-cell");

describe("LaneFoldCues", () => {
  it("shows nothing, and no strip, while every lane fits", async () => {
    const onOverflowChange = vi.fn();
    await renderCues(4, onOverflowChange);
    expect(below()).toBeNull();
    expect(above()).toBeNull();
    expect(footer()).toBeNull();
    expect(onOverflowChange).toHaveBeenLastCalledWith(false);
  });

  it("counts the lanes not fully visible below, on a strip of its own", async () => {
    const onOverflowChange = vi.fn();
    // Lanes end at 68, 108, 148, 188, 228, 268 against a view ending at
    // 220: the fifth is cut, the sixth hidden.
    await renderCues(6, onOverflowChange);
    expect(onOverflowChange).toHaveBeenLastCalledWith(true);
    expect(below()).toHaveTextContent("2 more below");
    expect(below()).toHaveAccessibleName("2 more below");
    expect(above()).toBeNull();
    const strip = footer()!;
    expect(strip).toContainElement(below());
    // In the layout, after the viewport: not over it.
    expect(strip.style.position).toBe("relative");
    expect(strip.style.height).toBe(`${LANE_FOLD_FOOTER_HEIGHT_PX}px`);
    expect(screen.getByTestId("scroll").compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The cue at the label column's right edge.
    const holder = below()!.parentElement!;
    expect(holder.style.left).toBe("0px");
    expect(holder.style.width).toBe(`${LABEL_COLUMN_PX}px`);
    expect(holder.style.justifyContent).toBe("flex-end");
  });

  it("puts the top cue in the axis row's label-column cell, at its right", async () => {
    await renderCues(6);
    fireEvent.click(below()!);
    const cell = aboveCell()!;
    expect(above()).toHaveTextContent("1 more above");
    expect(cell).toContainElement(above());
    expect(cell.style.top).toBe("0px");
    expect(cell.style.height).toBe(`${AXIS_PX}px`);
    expect(cell.style.left).toBe("0px");
    expect(cell.style.width).toBe(`${LABEL_COLUMN_PX}px`);
    expect(cell.style.alignItems).toBe("center");
    expect(cell.style.justifyContent).toBe("flex-end");
  });

  it("scrolls the next lane fully into view on a click", async () => {
    await renderCues(6);
    fireEvent.click(below()!);
    // The fifth lane's bottom (228) to the view's bottom (220).
    expect(scrollTop).toBe(8);
    expect(below()).toHaveTextContent("1 more below");
    expect(above()).toHaveTextContent("1 more above");
  });

  it("goes at the bottom, handing the focus to the lanes it scrolled; the strip stays", async () => {
    await renderCues(6);
    fireEvent.click(below()!);
    below()!.focus();
    fireEvent.click(below()!);
    expect(scrollTop).toBe(48);
    expect(below()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("scroll"));
    // The lanes still overflow: the strip keeps its place, empty, so the
    // viewport does not change height at the end of the scroll.
    expect(footer()).not.toBeNull();
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

  it("reads the overflow with the strip's height given back, so the strip does not keep itself", async () => {
    stripShrinksView = true;
    const onOverflowChange = vi.fn();
    // 228 px of content over the 220 px view: the strip shows, the view
    // drops to 196, and the next reading (228 > 196 + 24) keeps it.
    contentPx = 228;
    const { rerender } = await renderCues(5, onOverflowChange);
    await nextFrame();
    expect(onOverflowChange).toHaveBeenLastCalledWith(true);
    expect(footer()).not.toBeNull();
    // 210 px fits the 220 px view, though not the 196 px left beside the
    // strip: with the strip's height given back the strip goes, and
    // stays gone.
    contentPx = 210;
    rerender(<Harness lanes={4} onOverflowChange={onOverflowChange} />);
    await nextFrame();
    await nextFrame();
    expect(onOverflowChange).toHaveBeenLastCalledWith(false);
    expect(footer()).toBeNull();
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
