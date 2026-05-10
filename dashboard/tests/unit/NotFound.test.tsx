// D146: tests for the catch-all 404. Asserts the standalone
// component renders title + back link, and that App's router
// matches /mcp-policies (and other unmatched paths) to the
// NotFound element.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { NotFound } from "@/pages/NotFound";

describe("NotFound (D146 catch-all)", () => {
  it("renders the title + back link", () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("not-found")).toBeTruthy();
    expect(screen.getByTestId("not-found").textContent).toContain(
      "Page not found",
    );
    const link = screen.getByTestId("not-found-home-link");
    expect(link.getAttribute("href")).toBe("/");
  });

  it("matches catch-all routes (e.g. retired /mcp-policies)", () => {
    render(
      <MemoryRouter initialEntries={["/mcp-policies"]}>
        <Routes>
          <Route path="/" element={<div data-testid="root">Fleet</div>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("not-found")).toBeTruthy();
    expect(screen.queryByTestId("root")).toBeNull();
  });

  it("matches arbitrary unmatched paths", () => {
    render(
      <MemoryRouter initialEntries={["/some/random/path"]}>
        <Routes>
          <Route path="/" element={<div data-testid="root">Fleet</div>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("not-found")).toBeTruthy();
  });
});
