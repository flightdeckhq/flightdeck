import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SyntaxJson } from "@/components/ui/syntax-json";

describe("SyntaxJson", () => {
  it("shows the value exactly, including $ patterns", () => {
    const { container } = render(<SyntaxJson data={{ price: "$$5", ref: "$&", n: 3 }} />);
    const text = container.textContent ?? "";
    expect(text).toContain('"price": "$$5"');
    expect(text).toContain('"ref": "$&"');
    expect(text).toContain('"n": 3');
  });

  it("escapes markup in values instead of rendering it", () => {
    const { container } = render(<SyntaxJson data={{ html: "<script>alert(1)</script>" }} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders arrays, primitives and undefined", () => {
    expect(render(<SyntaxJson data={[1, "a"]} />).container.textContent).toContain('"a"');
    expect(render(<SyntaxJson data={"plain"} />).container.textContent).toBe('"plain"');
    expect(render(<SyntaxJson data={undefined} />).container.textContent).toBe("undefined");
  });
});
