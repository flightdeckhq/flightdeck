import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
