import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { siApple, siLinux } from "simple-icons";
import { OSIcon } from "@/components/ui/OSIcon";

describe("OSIcon", () => {
  it("renders an SVG for Darwin", () => {
    render(<OSIcon os="Darwin" />);
    expect(screen.getByTestId("os-icon-darwin")).toBeInTheDocument();
  });

  it("renders an SVG for Linux", () => {
    render(<OSIcon os="Linux" />);
    expect(screen.getByTestId("os-icon-linux")).toBeInTheDocument();
  });

  it("renders an SVG for Windows", () => {
    render(<OSIcon os="Windows" />);
    expect(screen.getByTestId("os-icon-windows")).toBeInTheDocument();
  });

  it("renders nothing for unknown os strings", () => {
    const { container } = render(<OSIcon os="BeOS" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when os is undefined", () => {
    const { container } = render(<OSIcon os={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when os is null", () => {
    const { container } = render(<OSIcon os={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("respects the size prop", () => {
    render(<OSIcon os="Linux" size={24} />);
    const svg = screen.getByTestId("os-icon-linux");
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
  });

  it("Darwin uses the exact siApple path from simple-icons", () => {
    render(<OSIcon os="Darwin" />);
    const svg = screen.getByTestId("os-icon-darwin");
    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    // Lock in that the rendered path data comes verbatim from
    // simple-icons, not from a hand-crafted fallback. The full path
    // is several hundred characters so an equality check is the
    // tightest possible contract.
    expect(path!.getAttribute("d")).toBe(siApple.path);
    // The standard simple-icons viewBox is 0 0 24 24.
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("Linux uses the exact siLinux path from simple-icons", () => {
    render(<OSIcon os="Linux" />);
    const svg = screen.getByTestId("os-icon-linux");
    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")).toBe(siLinux.path);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("Windows renders the hand-crafted 4-square fallback", () => {
    // Windows is NOT in simple-icons (removed for trademark reasons).
    // Verify the fallback SVG still renders at its original 14x14
    // viewBox and exposes four <rect> children -- one per logo
    // square.
    render(<OSIcon os="Windows" />);
    const svg = screen.getByTestId("os-icon-windows");
    expect(svg.getAttribute("viewBox")).toBe("0 0 14 14");
    const rects = svg.querySelectorAll("rect");
    expect(rects.length).toBe(4);
    // Windows fallback has no <path> element at all.
    expect(svg.querySelector("path")).toBeNull();
  });
});
