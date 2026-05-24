import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FrameworkPill } from "@/components/facets/FrameworkPill";

describe("FrameworkPill", () => {
  it("renders the bare framework name verbatim", () => {
    const { getByText } = render(<FrameworkPill framework="langchain" />);
    expect(getByText("langchain")).toBeTruthy();
  });

  it("renders nothing for a null framework", () => {
    const { container } = render(<FrameworkPill framework={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for an empty-string framework", () => {
    const { container } = render(<FrameworkPill framework="" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for an undefined framework", () => {
    const { container } = render(<FrameworkPill framework={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("honours the testId prop", () => {
    const { getByTestId } = render(
      <FrameworkPill framework="crewai" testId="fw-pill" />,
    );
    expect(getByTestId("fw-pill").textContent).toBe("crewai");
  });
});
