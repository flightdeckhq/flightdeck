import { describe, it, expect, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { TruncatedText } from "@/components/ui/TruncatedText";

// jsdom does not implement layout, so ``scrollWidth`` and
// ``clientWidth`` are both 0 by default. We stub those getters on
// HTMLElement.prototype to simulate the "truncation happens" and
// "text fits" cases. Each test restores the originals in afterEach
// via cleanup so the stubs don't leak between cases.

interface WidthOverrides {
  scrollWidth?: number;
  clientWidth?: number;
}

function stubWidths({ scrollWidth = 0, clientWidth = 0 }: WidthOverrides) {
  const descriptors: Array<{
    key: keyof HTMLElement;
    original: PropertyDescriptor | undefined;
  }> = [
    {
      key: "scrollWidth",
      original: Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollWidth",
      ),
    },
    {
      key: "clientWidth",
      original: Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "clientWidth",
      ),
    },
  ];
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => scrollWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => clientWidth,
  });
  return () => {
    for (const d of descriptors) {
      if (d.original) {
        Object.defineProperty(HTMLElement.prototype, d.key, d.original);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (HTMLElement.prototype as any)[d.key];
      }
    }
  };
}

afterEach(() => {
  cleanup();
});

describe("TruncatedText", () => {
  it("renders the full text as its own text node", () => {
    const { getByText } = render(<TruncatedText text="integration@host" />);
    expect(getByText("integration@host")).toBeDefined();
  });

  it("applies the CSS signature the audit rule requires", () => {
    // The primitive must carry overflow-hidden + whitespace-nowrap +
    // textOverflow: ellipsis so truncation is POSSIBLE when the
    // container narrows. These are the shape guarantees the audit
    // leans on; auto-detection is covered separately below.
    const { getByText } = render(<TruncatedText text="hello-world" />);
    const el = getByText("hello-world");
    expect(el.className).toContain("overflow-hidden");
    expect(el.className).toContain("whitespace-nowrap");
    expect((el as HTMLElement).style.textOverflow).toBe("ellipsis");
  });

  it("does not set title when text fits the container", () => {
    // scrollWidth == clientWidth -> not truncated -> no title.
    const restore = stubWidths({ scrollWidth: 100, clientWidth: 100 });
    try {
      const { getByText } = render(<TruncatedText text="short" />);
      expect(getByText("short").getAttribute("title")).toBeNull();
    } finally {
      restore();
    }
  });

  it("sets title to the full text when truncation is detected", () => {
    // scrollWidth > clientWidth -> browser would render the ellipsis
    // -> primitive must surface the full text on hover.
    const restore = stubWidths({ scrollWidth: 400, clientWidth: 80 });
    try {
      const { getByText } = render(
        <TruncatedText text="integration@integration-test-host" />,
      );
      expect(
        getByText("integration@integration-test-host").getAttribute("title"),
      ).toBe("integration@integration-test-host");
    } finally {
      restore();
    }
  });

  it("updates title on container resize (ResizeObserver fires)", () => {
    // Default jsdom has ResizeObserver as undefined; stub it so the
    // primitive registers a listener, then fire it manually after
    // bumping scrollWidth past clientWidth.
    let trigger: () => void = () => {};
    const observers: ResizeObserver[] = [];
    class FakeRO {
      constructor(public cb: ResizeObserverCallback) {
        trigger = () => cb([] as ResizeObserverEntry[], this as unknown as ResizeObserver);
        observers.push(this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
      FakeRO as unknown as typeof ResizeObserver;

    // Start with widths that fit; expect no title.
    const restore = stubWidths({ scrollWidth: 100, clientWidth: 100 });
    const { getByText } = render(<TruncatedText text="resize-me" />);
    expect(getByText("resize-me").getAttribute("title")).toBeNull();

    // Bump scrollWidth past clientWidth and fire the observer.
    restore();
    const restoreNarrow = stubWidths({ scrollWidth: 300, clientWidth: 60 });
    act(() => {
      trigger();
    });
    try {
      expect(getByText("resize-me").getAttribute("title")).toBe("resize-me");
    } finally {
      restoreNarrow();
      (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = undefined as unknown as typeof ResizeObserver;
    }
  });

  it("supports the 'div' render tag for table-cell call sites", () => {
    const { getByText } = render(
      <TruncatedText as="div" text="cell-text" />,
    );
    expect(getByText("cell-text").tagName).toBe("DIV");
  });

  it("forwards extra HTML attributes verbatim (data-testid, etc.)", () => {
    const onClick = vi.fn();
    const { getByTestId } = render(
      <TruncatedText
        text="click-me"
        data-testid="tt-click"
        onClick={onClick}
      />,
    );
    const el = getByTestId("tt-click");
    (el as HTMLElement).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
